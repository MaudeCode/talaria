#!/usr/bin/env python3
"""Run Agent compatibility for every supported release against the Web ref selected by the release plan.

``--list`` prints the jobs a release runs: each supported release of the selected source in ``SHARDS`` shards
(TAL-1550, TAL-1599). ``--release TAG --shard N/M`` checks one release's shard with the whole worker budget, and
``--expect JSON --receipts DIR`` requires the listed jobs to be exactly those and every one of them to have left a
passing receipt in this run whose shards together ran every sidecar test case of its release exactly once."""

import argparse
from collections import Counter
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_RUNTIME_ARTIFACTS = ('web/node_modules', 'web/packages/contracts/dist', 'web/packages/server/dist')
sys.path.insert(0, str(ROOT / "web/sidecar/scripts"))
from suite_runner import worker_count


# Each supported release's sidecar suite runs as this many jobs; the release graph's matrix comes from --list.
SHARDS = 3


def release_jobs(releases):
    return [{"release": tag, "shard": shard, "shards": SHARDS} for tag in releases for shard in range(1, SHARDS + 1)]


def latest_receipt(directory, tag, shard, run, attempt):
    """This run's newest passing gate receipt for one shard (a rerun keeps the shards that passed before) and the
    compatibility receipt beside it."""
    found = []
    for path in directory.rglob(f"{tag}.shard-{shard}.gate.json"):
        gate = json.loads(path.read_text())
        match = re.fullmatch(rf"https://github\.com/MaudeCode/talaria/actions/runs/{run}/attempts/([1-9][0-9]*)", str(gate.get("runUrl")))
        if gate.get("gate") == "agentCompatibility" and gate.get("result") == "success" and match and int(match[1]) <= attempt:
            found.append((int(match[1]), path))
    if not found:
        raise ValueError(f"Agent {tag} shard {shard}/{SHARDS} left no passing receipt in this run")
    _, path = max(found)
    return json.loads(path.with_name(f"{tag}.shard-{shard}.json").read_text())


def verify_receipts(directory, releases, source):
    """Every release's shards passed on the selected source and together ran its whole sidecar suite exactly once."""
    run, attempt = os.environ["GITHUB_RUN_ID"], int(os.environ["GITHUB_RUN_ATTEMPT"])
    for tag in releases:
        cases, suites = Counter(), set()
        for shard in range(1, SHARDS + 1):
            receipt = latest_receipt(directory, tag, shard, run, attempt)
            coverage = receipt.get("shard") or {}
            if (receipt.get("result"), receipt.get("kind"), receipt.get("releaseTag"), receipt.get("webRevision"),
                    receipt.get("imageVerified"), coverage.get("shard")) != ("success", "supported", tag, source, True, f"{shard}/{SHARDS}"):
                raise ValueError(f"Agent {tag} shard {shard}/{SHARDS} receipt is not a passing, image-verified check of the selected source")
            cases.update(coverage["cases"])
            suites.add((coverage["suiteCases"], coverage["suiteDigest"]))
        repeated = sorted(case for case, count in cases.items() if count > 1)
        if repeated:
            raise ValueError(f"Agent {tag} shards ran {len(repeated)} cases more than once, first {repeated[0]}")
        if len(suites) != 1:
            raise ValueError(f"Agent {tag} shards were dealt from different suites")
        (total, digest), = suites
        if len(cases) != total or hashlib.sha256("\n".join(sorted(cases)).encode()).hexdigest() != digest:
            raise ValueError(f"Agent {tag} shards ran {len(cases)} of its {total} sidecar test cases")
        print(f"Agent {tag}: {SHARDS} shards ran every one of {total} sidecar test cases exactly once", flush=True)


def worker_allocations(releases, budget):
    active = min(len(releases), budget)
    return {tag: budget // active + (index < budget % active) if len(releases) <= budget else 1
            for index, tag in enumerate(releases)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--receipts", type=Path, help="Directory for each release's receipt and JUnit report.")
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--list", action="store_true", help="Print the release's Agent jobs as JSON and stop.")
    selection.add_argument("--release", help="Check only this supported release.")
    selection.add_argument("--expect", help="Require exactly these Agent jobs (JSON) and their passing receipts in --receipts.")
    parser.add_argument("--shard", metavar="N/M", help="With --release: run only this shard of its sidecar suite.")
    args = parser.parse_args()
    if args.shard and not args.release:
        parser.error("--shard needs --release")
    if args.expect is not None and not args.receipts:
        parser.error("--expect needs --receipts")
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
            name = f"{tag}.shard-{args.shard.split('/')[0]}" if args.shard else tag
            receipt = ["--receipt", str(args.receipts.resolve() / f"{name}.json")] if args.receipts else []
            shard = ["--shard", args.shard] if args.shard else []
            try:
                path = checkout(tag)
                print(f"===== Agent {tag}{f' shard {args.shard}' if args.shard else ''}: started =====", flush=True)
                # Unbuffered, so the job log shows each phase as it happens (TAL-1599).
                return subprocess.run(["python3", str(path / "scripts/check-agent-compatibility.py"), "--release", tag, *shard, *receipt],
                                      cwd=path, env={**os.environ, "TALARIA_SIDECAR_WORKERS": str(allocations[tag]),
                                                     "TALARIA_SIDECAR_TOTAL_WORKERS": str(budget)})
            except (subprocess.CalledProcessError, OSError) as error:
                # Reported as this release failing, so the other releases still finish and print.
                print(f"===== Agent {tag}: {error} =====", flush=True)
                return subprocess.CompletedProcess(tag, 1)

        listing = checkout("list")
        # The selected source's own record names its supported releases and requires its active pin among them.
        releases = json.loads(subprocess.check_output(["python3", str(listing / "scripts/check-agent-compatibility.py"), "--list"],
                                                      cwd=listing))
        if args.list:
            print(json.dumps(release_jobs(releases)))
            return
        if args.expect is not None:
            key = lambda job: json.dumps(job, sort_keys=True)
            if sorted(map(key, json.loads(args.expect))) != sorted(map(key, release_jobs(releases))):
                raise ValueError(f"checked Agent jobs {args.expect} are not the supported releases' shards {json.dumps(release_jobs(releases))}")
            verify_receipts(args.receipts, releases, source)
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
        # Releases run concurrently; a release job checks one, so its log reads in order.
        with ThreadPoolExecutor(max_workers=min(len(releases), budget)) as pool:
            futures = {pool.submit(check, tag): tag for tag in releases}
            for future in as_completed(futures):
                tag, result = futures[future], future.result()
                print(f"===== Agent {tag}: {'passed' if result.returncode == 0 else 'FAILED'} =====", flush=True)
                if result.returncode:
                    failed.append(tag)
    if failed:
        raise RuntimeError(f"supported Agent releases failed compatibility: {', '.join(sorted(failed))}")


if __name__ == "__main__":
    main()
