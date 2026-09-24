#!/usr/bin/env python3
"""Validate the selected App/Web/Relay refs, including reused older components."""

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def verify_app_web(plan, output):
    app = plan["components"]["app"]["sourceRevision"]
    web_refs = list(dict.fromkeys([plan["components"]["web"]["sourceRevision"], *plan["supportedWebSources"]]))
    # One App revision for every Web: the pairs share a checkout, so only the first builds cold.
    with tempfile.TemporaryDirectory(prefix="talaria-selected-app-") as temporary:
        for index, web in enumerate(web_refs):
            subprocess.run([
                "python3", str(ROOT / "scripts/check-previous-app.py"), "--app-ref", app, "--web-ref", web,
                "--shared-contracts", "--output", str(output / f"app-web-{index}"),
                "--app-checkout", str(Path(temporary) / "source"),
            ], check=True)
    return web_refs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--only", choices=("app", "fixtures"),
                        help="app: the native App runs on Mac; fixtures: the portable Web/Relay fixture suites.")
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    refs = {name: component["sourceRevision"] for name, component in plan["components"].items()}
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    web_refs = list(dict.fromkeys([refs["web"], *plan["supportedWebSources"]]))
    if args.only != "fixtures":
        web_refs = verify_app_web(plan, output)
    if args.only == "app":
        (output / "verification.json").write_text(json.dumps({"sourceRefs": refs, "supportedWebSources": web_refs, "result": "success"}, indent=2) + "\n")
        return
    with tempfile.TemporaryDirectory(prefix="talaria-release-contracts-") as temporary:
        state = Path(temporary)
        for name in ("web", "relay"):
            checkout = state / name
            subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(ROOT), str(checkout)], check=True)
            subprocess.run(["git", "-C", str(checkout), "checkout", "--quiet", "--detach", refs[name]], check=True)
            home, scratch = state / f"{name}-home", state / f"{name}-tmp"
            home.mkdir(); scratch.mkdir()
            env = {"PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": str(scratch)}
            if "LD_LIBRARY_PATH" in os.environ:
                env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
            with (output / f"{name}-contracts.log").open("w") as log:
                if name == "web":
                    # The contracts package owns the monorepo fixture tests (publisher snapshot, activity scenes).
                    subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=checkout / "web", env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
                    subprocess.run(["npm", "run", "build", "-w", "packages/contracts"], cwd=checkout / "web", env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
                    subprocess.run(["npm", "test", "-w", "packages/contracts"], cwd=checkout / "web", env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
                else:
                    # Producer and consumer fixtures come from their actual refs,
                    # not whichever unreleased code happens to be on main.
                    for fixture in ("app-registration", "relay-snapshot"):
                        data = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{refs['app']}:contracts/fixtures/{fixture}.json"])
                        (checkout / f"contracts/fixtures/{fixture}.json").write_bytes(data)
                    subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=checkout / "relay", env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
                    for web_ref in web_refs:
                        data = subprocess.check_output(["git", "-C", str(ROOT), "show", f"{web_ref}:contracts/fixtures/publisher-snapshot.json"])
                        (checkout / "contracts/fixtures/publisher-snapshot.json").write_bytes(data)
                        subprocess.run(["pnpm", "exec", "vitest", "run", "tests/sharedContracts.test.ts"], cwd=checkout / "relay", env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    (output / "verification.json").write_text(json.dumps({"sourceRefs": refs, "supportedWebSources": web_refs, "result": "success"}, indent=2) + "\n")


if __name__ == "__main__":
    main()
