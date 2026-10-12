#!/usr/bin/env python3
"""Run Agent compatibility for every supported release against the Web ref selected by the release plan."""

import argparse
import json
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


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
            try:
                path = checkout(tag)
            except subprocess.CalledProcessError as error:
                return subprocess.CompletedProcess(error.cmd, error.returncode, stdout=f"{error}\n")
            receipt = ["--receipt", str(args.receipts.resolve() / f"{tag}.json")] if args.receipts else []
            return subprocess.run(["python3", str(path / "scripts/check-agent-compatibility.py"), "--release", tag, *receipt],
                                  cwd=path, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

        listing = checkout("list")
        # The selected source's own record names its supported releases and requires its active pin among them.
        releases = json.loads(subprocess.check_output(["python3", str(listing / "scripts/check-agent-compatibility.py"), "--list"],
                                                      cwd=listing))
        failed = []
        # Releases run concurrently; each one's output prints as one block when it finishes so the job log stays readable.
        with ThreadPoolExecutor(max_workers=len(releases)) as pool:
            for future in as_completed(futures := {pool.submit(check, tag): tag for tag in releases}):
                tag, result = futures[future], future.result()
                print(f"===== Agent {tag}: {'passed' if result.returncode == 0 else 'FAILED'} =====\n{result.stdout}", end="", flush=True)
                if result.returncode:
                    failed.append(tag)
    if failed:
        raise RuntimeError(f"supported Agent releases failed compatibility: {', '.join(failed)}")


if __name__ == "__main__":
    main()
