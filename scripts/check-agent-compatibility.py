#!/usr/bin/env python3
"""Check the pinned external Agent in disposable source and container state."""

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tests", nargs="*", help="Optional native Web test selectors; defaults to the full suite.")
    args = parser.parse_args()
    pin = json.loads((ROOT / "web/api/agent_dependency.json").read_text())
    sha = pin["x-talaria"]["sourceRevision"]
    version = pin["x-talaria"]["version"]
    image = pin["services"]["hermes-agent"]["image"]
    if not re.fullmatch(r"[a-f0-9]{40}", sha) or not re.fullmatch(r"docker.io/nousresearch/hermes-agent@sha256:[a-f0-9]{64}", image):
        raise ValueError("Agent source and image must be immutable")
    python = shutil.which(os.environ.get("HERMES_WEBUI_TEST_PYTHON", "python3.13"))
    if not python:
        raise RuntimeError("Python 3.13 is required (or set HERMES_WEBUI_TEST_PYTHON)")

    with tempfile.TemporaryDirectory(prefix="talaria-agent-compatibility-") as directory:
        state = Path(directory)
        for name in ("home", "tmp", "agent"):
            (state / name).mkdir()
        env = {"PATH": os.environ["PATH"], "HOME": str(state / "home"), "TMPDIR": str(state / "tmp"),
               "UV_CACHE_DIR": str(state / "uv-cache"), "HERMES_HOME": str(state / "home/hermes"),
               "HERMES_WEBUI_STATE_DIR": str(state / "home/webui"), "PIP_CONFIG_FILE": os.devnull,
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0"}
        if "LD_LIBRARY_PATH" in os.environ:
            env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
        agent = state / "agent"
        for command in (["git", "init", "--quiet", str(agent)],
                        ["git", "-C", str(agent), "fetch", "--depth=1", "--no-tags", "https://github.com/NousResearch/hermes-agent.git", sha],
                        ["git", "-C", str(agent), "checkout", "--quiet", "--detach", "FETCH_HEAD"]):
            subprocess.run(command, env=env, check=True)
        actual = subprocess.check_output(["git", "-C", str(agent), "rev-parse", "HEAD"], env=env, text=True).strip()
        if actual != sha:
            raise RuntimeError("Agent checkout does not match the compatibility pin")
        subprocess.run(["uv", "sync", "--frozen", "--no-dev", "--python", python], cwd=agent, env=env, check=True)
        agent_python = agent / ".venv/bin/python"
        packages = json.loads(subprocess.check_output([str(agent_python), "-c", "import site,json; print(json.dumps(site.getsitepackages()))"], env=env))
        env.update(PYTHONPATH=os.pathsep.join([str(ROOT / "web"), str(agent), *packages]),
                   HERMES_WEBUI_AGENT_DIR=str(agent), HERMES_WEBUI_PYTHON=str(agent_python),
                   HERMES_WEBUI_TEST_PYTHON=python,
                   PLAYWRIGHT_BROWSERS_PATH=str(ROOT / "web/.codex-tmp/playwright"))
        subprocess.run([str(agent_python), str(ROOT / "releases/agent_probe.py"), version], cwd=agent, env=env, check=True)
        # Use the native harness for dependency setup and its network/state guards.
        setup_env = {key: value for key, value in env.items() if key != "PYTHONPATH"}
        # Install Web's own dependencies. Otherwise pip considers packages on
        # Agent's PYTHONPATH installed and leaves Web's venv incomplete.
        subprocess.run(["./scripts/test.sh", "--collect-only", "-q", "tests/test_ci_hygiene.py"], cwd=ROOT / "web", env=setup_env, check=True)
        subprocess.run([str(ROOT / "web/.venv/bin/python"), "-m", "playwright", "install", "chromium"], env=env, check=True)
        subprocess.run(["./scripts/test.sh", *(args.tests or ["tests/"]), "-q", "--timeout=60"], cwd=ROOT / "web", env=env, check=True)

    # Docker needs the caller's daemon context, but the container receives only
    # these synthetic environment values, read-only code and temporary state.
    subprocess.run(["docker", "pull", image], check=True)
    config = json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]["Config"]
    if config.get("Labels", {}).get("org.opencontainers.image.revision") != sha:
        raise RuntimeError("Agent image source label does not match its tested source")
    name = "talaria-agent-compatibility-" + uuid.uuid4().hex[:12]
    try:
        subprocess.run([
            "docker", "run", "--rm", "--name", name, "--network", "none", "--read-only",
            "--tmpfs", "/tmp", "--tmpfs", "/opt/data", "--entrypoint", "/opt/hermes/.venv/bin/python",
            "-e", "HOME=/tmp/home", "-e", "HERMES_HOME=/tmp/home/hermes", "-e", "PYTHONPATH=/web:/opt/hermes",
            "-v", f"{ROOT / 'web'}:/web:ro", "-v", f"{ROOT / 'releases/agent_probe.py'}:/probe.py:ro",
            image, "/probe.py", version,
        ], check=True)
    finally:
        subprocess.run(["docker", "rm", "--force", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    print(json.dumps({**pin["x-talaria"], "image": image, "result": "success"}))


if __name__ == "__main__":
    main()
