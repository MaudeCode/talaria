#!/usr/bin/env python3
"""Run Agent compatibility for every supported release against the Web ref selected by the release plan.

``--list`` prints the selected source's supported releases. A release fans them out as one job each (TAL-1550):
``--release TAG`` checks that one release with the whole worker budget, and ``--expect JSON`` requires the jobs to
have covered exactly the supported releases."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_RUNTIME_ARTIFACTS = ('web/node_modules', 'web/packages/contracts/dist', 'web/packages/server/dist')
sys.path.insert(0, str(ROOT / "web/sidecar/scripts"))
from suite_runner import worker_count


def worker_allocations(releases, budget):
    active = min(len(releases), budget)
    return {tag: budget // active + (index < budget % active) if len(releases) <= budget else 1
            for index, tag in enumerate(releases)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--receipts", type=Path, help="Directory for each release's receipt and JUnit report.")
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--list", action="store_true", help="Print the supported releases as JSON and stop.")
    selection.add_argument("--release", help="Check only this supported release.")
    selection.add_argument("--expect", help="Require exactly these releases (JSON list) to be the supported ones.")
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    source = plan["components"]["web"]["sourceRevision"]
    pin = json.loads(subprocess.check_output(["git", "-C", str(ROOT), "show", f"{source}:web/sidecar/agent_dependency.json"]))
    identity = {**pin["x-talaria"], "image": pin["services"]["hermes-agent"]["image"]}
    if identity != plan["agent"]:
        raise ValueError("selected Web source and planned Agent identity differ")
    # Colima shares the checkout's home path, not macOS system temporary paths.
    scratch = ROOT / ".codex-tmp"
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="talaria-selected-web-", dir=scratch) as temporary:
        runtime = None

        def checkout(name):
            path = Path(temporary) / name
            subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(ROOT), str(path)], check=True)
            subprocess.run(["git", "-C", str(path), "checkout", "--quiet", "--detach", source], check=True)
            if runtime is not None:
                for relative in SERVER_RUNTIME_ARTIFACTS:
                    link = path / relative
                    link.parent.mkdir(parents=True, exist_ok=True)
                    link.symlink_to(runtime / relative, target_is_directory=True)
            return path

        def check(tag):
            # Each release gets its own checkout: the sidecar suite builds its pytest venv inside it.
            receipt = ["--receipt", str(args.receipts.resolve() / f"{tag}.json")] if args.receipts else []
            try:
                path = checkout(tag)
                return subprocess.run(["python3", str(path / "scripts/check-agent-compatibility.py"), "--release", tag, *receipt],
                                      cwd=path, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                      env={**os.environ, "TALARIA_SIDECAR_WORKERS": str(allocations[tag]),
                                           "TALARIA_SIDECAR_TOTAL_WORKERS": str(budget)})
            except (subprocess.CalledProcessError, OSError) as error:
                # Reported as this release failing, so the other releases still finish and print.
                return subprocess.CompletedProcess(tag, 1, stdout=f"{error}\n")

        listing = checkout("list")
        # The selected source's own record names its supported releases and requires its active pin among them.
        releases = json.loads(subprocess.check_output(["python3", str(listing / "scripts/check-agent-compatibility.py"), "--list"],
                                                      cwd=listing))
        if args.list:
            print(json.dumps(releases))
            return
        if args.expect is not None:
            if sorted(json.loads(args.expect)) != sorted(releases):
                raise ValueError(f"checked Agent releases {args.expect} are not the supported releases {json.dumps(releases)}")
            print(f"Every supported Agent release was checked: {', '.join(releases)}")
            return
        if args.release is not None:
            if args.release not in releases:
                raise ValueError(f"Agent {args.release} is not a supported release of the selected source")
            releases = [args.release]
        # Native environment recovery includes a real server/sidecar boundary.
        # Build this exact selected source once; all release checkouts share only read-only artifacts.
        for command in (["npm", "ci", "--no-audit", "--no-fund"],
                        ["npm", "run", "build", "-w", "packages/contracts"],
                        ["npm", "run", "build", "-w", "packages/server"]):
            subprocess.run(command, cwd=listing / 'web', check=True)
        for relative in SERVER_RUNTIME_ARTIFACTS:
            if not (listing / relative).is_dir():
                raise RuntimeError(f'selected Web runtime build did not produce {relative}')
        runtime = listing
        failed = []
        budget = worker_count(os.environ.get("TALARIA_SIDECAR_WORKERS"))
        allocations = worker_allocations(releases, budget)
        print(f"Sidecar host worker budget={budget}; release allocations={allocations}", flush=True)
        # Releases run concurrently; each one's output prints as one block when it finishes so the job log stays readable.
        with ThreadPoolExecutor(max_workers=min(len(releases), budget)) as pool:
            futures = {pool.submit(check, tag): tag for tag in releases}
            for future in as_completed(futures):
                tag, result = futures[future], future.result()
                print(f"===== Agent {tag}: {'passed' if result.returncode == 0 else 'FAILED'} =====\n{result.stdout}", end="", flush=True)
                if result.returncode:
                    failed.append(tag)
    if failed:
        raise RuntimeError(f"supported Agent releases failed compatibility: {', '.join(sorted(failed))}")


if __name__ == "__main__":
    main()
