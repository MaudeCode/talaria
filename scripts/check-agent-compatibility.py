#!/usr/bin/env python3
"""Check the pinned stable Agent release in disposable source and container state.

Provisions the pinned Hermes Agent checkout and its venv in a temporary directory,
runs the sidecar pytest suite on that interpreter (``--sidecar-tests``), runs an
optional extra command with ``HERMES_WEBUI_AGENT_DIR``/``HERMES_WEBUI_PYTHON`` set
(``--command``), and verifies the pinned container image (unless ``--skip-docker``).
"""

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
    parser.add_argument("tests", nargs="*", help="Optional sidecar pytest selectors; defaults to the full sidecar suite.")
    parser.add_argument("--command", nargs=argparse.REMAINDER, help="Extra command to run with the provisioned Agent in its environment.")
    parser.add_argument("--skip-docker", action="store_true", help="Skip the pinned image verification (no Docker daemon).")
    parser.add_argument("--skip-sidecar-tests", action="store_true")
    args = parser.parse_args()
    pin = json.loads((ROOT / "web/sidecar/agent_dependency.json").read_text())
    release_tag = pin["x-talaria"]["releaseTag"]
    sha = pin["x-talaria"]["sourceRevision"]
    version = pin["x-talaria"]["version"]
    image = pin["services"]["hermes-agent"]["image"]
    if (not re.fullmatch(r"v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]+)?", release_tag)
            or not re.fullmatch(r"[a-f0-9]{40}", sha)
            or not re.fullmatch(r"docker.io/nousresearch/hermes-agent@sha256:[a-f0-9]{64}", image)):
        raise ValueError("Agent release tag, source, and image must be immutable")
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
        for key in ("LD_LIBRARY_PATH", "PLAYWRIGHT_BROWSERS_PATH"):
            if key in os.environ:
                env[key] = os.environ[key]
        agent = state / "agent"
        for command in (["git", "init", "--quiet", str(agent)],
                        ["git", "-C", str(agent), "fetch", "--depth=1", "--no-tags", "https://github.com/NousResearch/hermes-agent.git", f"refs/tags/{release_tag}"],
                        ["git", "-C", str(agent), "checkout", "--quiet", "--detach", "FETCH_HEAD"]):
            subprocess.run(command, env=env, check=True)
        actual = subprocess.check_output(["git", "-C", str(agent), "rev-parse", "HEAD"], env=env, text=True).strip()
        if actual != sha:
            raise RuntimeError("Agent release tag does not match the compatibility pin")
        # The mcp extra (shipped in the image via [all]) lets the sidecar suite drive a real stub MCP server.
        subprocess.run(["uv", "sync", "--frozen", "--no-dev", "--extra", "mcp", "--python", python], cwd=agent, env=env, check=True)
        agent_python = agent / ".venv/bin/python"
        env.update(HERMES_WEBUI_AGENT_DIR=str(agent), HERMES_WEBUI_PYTHON=str(agent_python), HERMES_WEBUI_TEST_PYTHON=python)
        subprocess.run([str(agent_python), str(ROOT / "releases/agent_probe.py"), version], cwd=agent, env={**env, "PYTHONPATH": str(ROOT / "web/sidecar")}, check=True)
        if not args.skip_sidecar_tests:
            # The sidecar suite spawns `python -m talaria_sidecar` on this venv with disposable homes.
            subprocess.run([str(ROOT / "web/sidecar/scripts/test.sh"), *args.tests], cwd=ROOT / "web", env=env, check=True)
        if args.command:
            subprocess.run(args.command, cwd=ROOT, env={**os.environ, **env, "PATH": os.environ["PATH"]}, check=True)

    if not args.skip_docker:
        # Docker needs the caller's daemon context, but the container receives only
        # these synthetic environment values, read-only code and temporary state.
        subprocess.run(["docker", "pull", image], check=True)
        release_image = f"docker.io/nousresearch/hermes-agent:{release_tag}"
        subprocess.run(["docker", "pull", release_image], check=True)
        release_digests = json.loads(subprocess.check_output(["docker", "image", "inspect", release_image]))[0].get("RepoDigests", [])
        if not any(ref.endswith("@" + image.rsplit("@", 1)[1]) for ref in release_digests):
            raise RuntimeError("Agent release tag image does not match the compatibility pin")
        config = json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]["Config"]
        if config.get("Labels", {}).get("org.opencontainers.image.revision") != sha:
            raise RuntimeError("Agent image source label does not match its tested source")
        name = "talaria-agent-compatibility-" + uuid.uuid4().hex[:12]
        try:
            subprocess.run([
                "docker", "run", "--rm", "--name", name, "--network", "none", "--read-only",
                "--tmpfs", "/tmp", "--tmpfs", "/opt/data", "--entrypoint", "/opt/hermes/.venv/bin/python",
                "-e", "HOME=/tmp/home", "-e", "HERMES_HOME=/tmp/home/hermes", "-e", "PYTHONPATH=/web/sidecar:/opt/hermes",
                "-v", f"{ROOT / 'web'}:/web:ro", "-v", f"{ROOT / 'releases/agent_probe.py'}:/probe.py:ro",
                image, "/probe.py", version,
            ], check=True)
        finally:
            subprocess.run(["docker", "rm", "--force", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    print(json.dumps({**pin["x-talaria"], "image": image, "result": "success"}))


if __name__ == "__main__":
    main()
