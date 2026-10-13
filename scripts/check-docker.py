#!/usr/bin/env python3
"""Smoke all Compose variants using only test-owned ports, names, and state."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parent.parent


def build(image):
    """Build the Web image, reusing layers from the BuildKit cache CI configures (TALARIA_DOCKER_CACHE)."""
    cache = os.environ.get("TALARIA_DOCKER_CACHE")
    if not cache:
        subprocess.run(["docker", "build", "-t", image, str(ROOT / "web")], check=True)
        return
    # A cache backend's credentials reach BuildKit from the environment, never from these arguments.
    subprocess.run(["docker", "buildx", "build", "--load", "-t", image,
                    "--cache-from", cache, "--cache-to", cache + ",mode=max,ignore-error=true", str(ROOT / "web")], check=True)


def main():
    variants = ("single", "two-container", "three-container", "auto-uid", "explicit-uid", "agent-upgrade")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("variants", nargs="*", choices=variants)
    releases = json.loads((ROOT / "web/sidecar/agent_support.json").read_text())["releases"]
    parser.add_argument("--agent-release", choices=[release["releaseTag"] for release in releases],
                        help="Test a supported older Agent image with the current Web image")
    args = parser.parse_args()
    selected = args.variants or variants
    if "agent-upgrade" in selected:
        upgrade_smoke(releases)
        selected = [variant for variant in selected if variant != "agent-upgrade"]
        if not selected:
            return
    agent_image = next((release["image"] for release in releases if release["releaseTag"] == args.agent_release), None)
    image = "talaria-monorepo-smoke:" + uuid.uuid4().hex[:12]
    try:
        build(image)
        subprocess.run(["docker", "run", "--rm", "--entrypoint", "/bin/sh", image, "-c",
                        "test ! -e /apptoo/.venv && test ! -e /apptoo/.codex-tmp && test ! -e /apptoo/packages/frontend/node_modules && test -f /apptoo/packages/server/dist/bin/talaria-web.js"], check=True)
        # Variants own their project, container names, state and ephemeral ports, so they run concurrently.
        with ThreadPoolExecutor(max_workers=len(selected)) as pool:
            for future in [pool.submit(smoke, variant, image, agent_image) for variant in selected]:
                future.result()
    finally:
        subprocess.run(["docker", "image", "rm", image], check=False)


def upgrade_smoke(releases):
    """Upgrade legacy source volumes through the shipped Agent service's entrypoint."""
    pin = json.loads((ROOT / "web/sidecar/agent_dependency.json").read_text())
    current_image = pin["services"]["hermes-agent"]["image"]
    current = pin["x-talaria"]
    # Cover both the oldest and immediately previous supported image across the two layouts.
    previous = [release for release in releases if release["sourceRevision"] != current["sourceRevision"]]
    for variant, old in zip(("two-container", "three-container"), (previous[0], previous[-1])):
        with tempfile.TemporaryDirectory(prefix="talaria-agent-upgrade-") as temporary:
            project = "talaria-upgrade-" + uuid.uuid4().hex[:12]
            env = {"PATH": os.environ["PATH"], "HOME": str(Path.home()),
                   "HERMES_WORKSPACE": temporary, "UID": "1000", "GID": "1000"}
            config = json.loads(subprocess.check_output([
                "docker", "compose", "--env-file", os.devnull, "-f",
                str(ROOT / "web" / f"docker-compose.{variant}.yml"), "config", "--format", "json",
            ], env=env))
            agent = config["services"]["hermes-agent"]
            config["services"] = {"hermes-agent": agent}
            config.pop("name", None)
            agent.pop("container_name", None)
            agent.pop("ports", None)
            agent["restart"] = "no"
            for kind in ("volumes", "networks"):
                for resource in config.get(kind, {}).values():
                    resource.pop("name", None)
            configured = Path(temporary) / "compose.json"
            compose = ["docker", "compose", "--env-file", os.devnull, "-p", project, "-f", str(configured)]

            def run_agent(image, command, legacy=False):
                agent["image"] = image
                original = json.loads(json.dumps(agent))
                if legacy:
                    # Reproduce a pre-fix deployment, including Docker's initial volume copy-up.
                    agent.pop("entrypoint", None)
                    agent.pop("healthcheck", None)
                    agent["volumes"] = [mount for mount in agent["volumes"] if mount["type"] == "volume"]
                    for mount in agent["volumes"]:
                        if mount["source"] == "hermes-agent-src":
                            mount["target"] = "/opt/hermes"
                configured.write_text(json.dumps(config))
                try:
                    return subprocess.run([*compose, "run", "--rm", "--no-deps", "-T", "hermes-agent",
                                           "/bin/sh", "-c", command], env=env, text=True,
                                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
                finally:
                    agent.clear()
                    agent.update(original)

            def source(command):
                return subprocess.check_output([
                    "docker", "run", "--rm", "--entrypoint", "/bin/sh", "-v",
                    f"{project}_hermes-agent-src:/fixture", current_image, "-c", "set -eu; " + command,
                ], env=env, text=True, timeout=180).strip()

            try:
                first = run_agent(old["image"], 'printf preserved > "$HERMES_HOME/upgrade-sentinel"; hermes --version', legacy=True)
                assert first.returncode == 0 and f"Hermes Agent v{old['version']}" in first.stdout, first.stdout
                source("touch /fixture/.obsolete-source")
                probe = 'set -e; hermes --version; python3 --version; test "$(cat "$HERMES_HOME/upgrade-sentinel")" = preserved'
                upgraded = run_agent(current_image, probe)
                assert f"Hermes Agent v{current['version']}" in upgraded.stdout, upgraded.stdout
                assert upgraded.returncode == 0, upgraded.stdout
                revision = source("cat /fixture/.talaria-source-revision")
                assert revision == current["sourceRevision"], revision
                stamp = json.loads(source("cat /fixture/install-stamp.json"))
                assert stamp["commit"] == current["sourceRevision"], stamp
                source("test ! -e /fixture/.obsolete-source; touch /fixture/.restart-sentinel")
                restarted = run_agent(current_image, probe)
                assert restarted.returncode == 0, restarted.stdout
                source("test -f /fixture/.restart-sentinel")
                # A missing completion marker represents an interrupted copy and must be repaired.
                source("rm /fixture/.talaria-source-revision")
                repaired = run_agent(current_image, probe)
                assert repaired.returncode == 0, repaired.stdout
                source("test ! -e /fixture/.restart-sentinel")
                assert source("cat /fixture/.talaria-source-revision") == current["sourceRevision"]
                rolled_back = run_agent(old["image"], probe)
                assert rolled_back.returncode == 0 and f"Hermes Agent v{old['version']}" in rolled_back.stdout, rolled_back.stdout
                assert source("cat /fixture/.talaria-source-revision") == old["sourceRevision"]
                print(f"PASS Docker {variant} upgrade {old['releaseTag']} -> {current['releaseTag']}, restart, interrupted copy, rollback and home preservation", flush=True)
            finally:
                subprocess.run([*compose, "down", "--volumes", "--remove-orphans"], env=env, check=True)


def smoke(variant, image, agent_image=None):
    with tempfile.TemporaryDirectory(prefix="talaria-docker-") as temporary:
        state = Path(temporary)
        (state / "home").mkdir()
        (state / "workspace").mkdir()
        env = {"PATH": os.environ["PATH"], "HOME": str(Path.home()),
               "HERMES_HOME": str(state / "home"), "HERMES_WORKSPACE": str(state / "workspace"),
               "UID": "1000", "GID": "1000"}
        project = "talaria-smoke-" + uuid.uuid4().hex[:12]
        if variant.endswith("-uid"):
            data = state / "data"
            data.mkdir()
            subprocess.run([
                "docker", "run", "--rm", "--entrypoint", "/bin/sh", "-v", f"{data}:/fixture",
                image, "-c", "chown 1001:1001 /fixture && chmod 777 /fixture",
            ], env=env, check=True)
            environment = {"HERMES_WEBUI_STATE_DIR": "/app/data"}
            mounts = [f"{data}:/app/data"]
            if variant == "explicit-uid":
                environment.update(WANTED_UID="1024", WANTED_GID="1024")
                mounts.append(f"{data}:/home/hermeswebui/.hermes")
            config = {"services": {"hermes-webui": {
                "image": image, "environment": environment,
                "ports": [{"target": 8787}],
                "volumes": mounts,
            }}}
        else:
            suffix = "" if variant == "single" else f".{variant}"
            config = json.loads(subprocess.check_output([
                "docker", "compose", "--env-file", os.devnull, "-f", str(ROOT / "web" / f"docker-compose{suffix}.yml"),
                "config", "--format", "json",
            ], env=env))
        config.pop("name", None)
        for service_name, service in config["services"].items():
            if agent_image and service_name in ("hermes-agent", "hermes-dashboard"):
                service["image"] = agent_image
            service["container_name"] = f"{project}-{service_name}"
            service["restart"] = "no"
            for port in service.get("ports", []):
                port.update(published="0", host_ip="127.0.0.1")
        web = config["services"]["hermes-webui"]
        web["image"] = image
        web.setdefault("environment", {}).update(TIRITH_ENABLED="0", HERMES_STATE_DB_GUARD_BYPASS="1")
        web.setdefault("healthcheck", {})["start_period"] = "600s"
        web.pop("build", None)
        for kind in ("volumes", "networks"):
            for resource in config.get(kind, {}).values():
                resource.pop("name", None)
        configured = state / "compose.json"
        configured.write_text(json.dumps(config))
        compose = ["docker", "compose", "--env-file", os.devnull, "-p", project, "-f", str(configured)]
        try:
            # A cold Agent install downloads its full dependency set before Web can become healthy.
            subprocess.run([*compose, "up", "-d", "--wait", "--wait-timeout", "600"], env=env, check=True)
            address = subprocess.check_output([*compose, "port", "hermes-webui", "8787"], env=env, text=True).strip()
            with urllib.request.urlopen(f"http://{address}/health", timeout=10) as response:
                assert json.load(response)["status"] == "ok"
            if variant in ("two-container", "three-container"):
                subprocess.run([*compose, "exec", "-T", "--user", "hermeswebui", "hermes-webui",
                                "/app/hermes-agent-src/venv/bin/python", "-c",
                                "from run_agent import AIAgent"], env=env, check=True, timeout=60)
                subprocess.run([*compose, "exec", "-T", "--user", "hermeswebui", "hermes-webui",
                                "/app/hermes-agent-src/venv/bin/python", "-"],
                               input=(ROOT / "web/scripts/lib/docker_chat_smoke.py").read_text(),
                               text=True, env=env, check=True, timeout=180)
            if variant.endswith("-uid"):
                actual = subprocess.check_output([*compose, "exec", "-T", "hermes-webui", "id", "-u", "hermeswebui"], env=env, text=True).strip()
                assert actual == ("1001" if variant == "auto-uid" else "1024"), actual
            print(f"PASS Docker {variant} health", flush=True)
        finally:
            subprocess.run([*compose, "logs", "--no-color", "--tail=60"], env=env, check=False)
            try:
                subprocess.run([*compose, "down", "--volumes", "--remove-orphans"], env=env, check=True)
            finally:
                # The containers write bind-mounted state as their own UIDs (1000, 1001, 1024), which the
                # invoking user cannot delete unless it happens to share one; hand the tree back through the
                # image so the temporary directory's own cleanup, which stays strict, can remove it.
                subprocess.run(["docker", "run", "--rm", "--entrypoint", "/bin/sh", "-v", f"{state}:/state", image,
                                "-c", f"chown -R {os.getuid()}:{os.getgid()} /state && chmod -R u+rwX /state"],
                               env=env, check=False)


if __name__ == "__main__":
    main()
