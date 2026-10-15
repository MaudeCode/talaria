#!/usr/bin/env python3
"""Install a Talaria Web npm spec exactly as the updater does, boot it in an isolated home and require `/health`.

Self-contained (stdlib only): release-set.yml runs the workflow's own copy against the published version.
"""

import argparse
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

PACKAGE = "@maudecode/talaria-web"


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            return response.status == 200
    except (OSError, http.client.HTTPException):
        return False


def tail(log, limit=6000):
    text = log.read_text(errors="replace")
    return text if len(text) <= limit else f"[... {len(text) - limit} bytes ...]\n{text[-limit:]}"


def smoke(spec, timeout=60):
    """Raise RuntimeError carrying the server log tail unless the installed package serves `/health` within `timeout` s."""
    if Path(spec).is_file():
        spec = str(Path(spec).resolve())
    with tempfile.TemporaryDirectory(prefix="talaria-web-smoke-") as temporary:
        root = Path(temporary)
        prefix, state = root / "prefix", root / "state"
        for directory in (prefix, state / "workspace", state / "claude-projects"):
            directory.mkdir(parents=True)
        # The updater's install command (web/packages/server/src/tools/updates.ts).
        subprocess.run(["npm", "install", "--global", "--prefix", str(prefix), "--no-audit", "--no-fund", spec],
                       check=True, stdout=sys.stderr)
        package = prefix / "lib/node_modules" / PACKAGE
        port = free_port()
        # The isolated environment of web/packages/frontend/e2e/server.ts, with the package's own replay sidecar.
        env = {key: value for key, value in os.environ.items() if not key.startswith("HERMES_")}
        env.update({
            "HOME": str(state),
            "HERMES_WEBUI_HOST": "127.0.0.1",
            "HERMES_WEBUI_PORT": str(port),
            "HERMES_WEBUI_STATE_DIR": str(state),
            "HERMES_WEBUI_DEFAULT_WORKSPACE": str(state / "workspace"),
            "HERMES_HOME": str(state),
            "HERMES_BASE_HOME": str(state),
            "HERMES_CONFIG_PATH": str(state / "config.yaml"),
            "HERMES_WEBUI_CLAUDE_PROJECTS_DIR": str(state / "claude-projects"),
            "HERMES_WEBUI_SKIP_ONBOARDING": "1",
            "HERMES_WEBUI_TEST_NETWORK_BLOCK": "1",
            "HERMES_WEBUI_SIDECAR_COMMAND": json.dumps([sys.executable, str(package / "sidecar/scripts/replay_sidecar.py")]),
            "AWS_EC2_METADATA_DISABLED": "true",
        })
        log = root / "server.log"
        with log.open("wb") as output:
            server = subprocess.Popen(["node", str(package / "dist/bin/talaria-web.js"), "--foreground", "--no-browser"],
                                      cwd=state, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                      start_new_session=True)
        try:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline and server.poll() is None:
                if healthy(port):
                    return
                time.sleep(0.2)
            raise RuntimeError(f"{spec} did not serve /health on port {port} (exit {server.poll()}):\n{tail(log)}")
        finally:
            # The foreground launcher supervises the server worker and sidecar; stop the whole session.
            for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, 5)):
                try:
                    os.killpg(server.pid, sig)
                    server.wait(wait)
                    break
                except ProcessLookupError:
                    break
                except subprocess.TimeoutExpired:
                    continue


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", help="npm install spec: a tarball path or @maudecode/talaria-web@<version>")
    args = parser.parse_args()
    try:
        smoke(args.spec)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"smoke_npm: {error}", file=sys.stderr)
        sys.exit(1)
    print(f"smoke_npm: {args.spec} installed and served /health")


if __name__ == "__main__":
    main()
