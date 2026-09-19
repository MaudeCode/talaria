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
    for index, web in enumerate(web_refs):
        subprocess.run([
            "python3", str(ROOT / "scripts/check-previous-app.py"), "--app-ref", app, "--web-ref", web,
            "--shared-contracts", "--output", str(output / f"app-web-{index}"),
        ], check=True)
    return web_refs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text())
    refs = {name: component["sourceRevision"] for name, component in plan["components"].items()}
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    web_refs = verify_app_web(plan, output)
    with tempfile.TemporaryDirectory(prefix="talaria-release-contracts-") as temporary:
        state = Path(temporary)
        for name in ("web", "relay"):
            checkout = state / name
            subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(ROOT), str(checkout)], check=True)
            subprocess.run(["git", "-C", str(checkout), "checkout", "--quiet", "--detach", refs[name]], check=True)
            home, scratch = state / f"{name}-home", state / f"{name}-tmp"
            home.mkdir(); scratch.mkdir()
            env = {"PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": str(scratch)}
            if "HERMES_WEBUI_TEST_PYTHON" in os.environ:
                env["HERMES_WEBUI_TEST_PYTHON"] = os.environ["HERMES_WEBUI_TEST_PYTHON"]
            if "LD_LIBRARY_PATH" in os.environ:
                env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
            with (output / f"{name}-contracts.log").open("w") as log:
                if name == "web":
                    subprocess.run(["./scripts/test.sh", "tests/test_monorepo_contracts.py", "-q"],
                                   cwd=checkout / "web", env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
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
