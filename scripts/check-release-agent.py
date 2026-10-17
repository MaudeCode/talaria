#!/usr/bin/env python3
"""Run Agent compatibility for every supported release against the Web ref selected by the release plan."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
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
        def checkout(name):
            path = Path(temporary) / name
            subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(ROOT), str(path)], check=True)
            subprocess.run(["git", "-C", str(path), "checkout", "--quiet", "--detach", source], check=True)
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
