#!/usr/bin/env python3
"""Run Agent compatibility against the Web ref selected by the release plan."""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
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
        checkout = Path(temporary) / "source"
        subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(ROOT), str(checkout)], check=True)
        subprocess.run(["git", "-C", str(checkout), "checkout", "--quiet", "--detach", source], check=True)
        subprocess.run(["python3", str(checkout / "scripts/check-agent-compatibility.py")], cwd=checkout, check=True)


if __name__ == "__main__":
    main()
