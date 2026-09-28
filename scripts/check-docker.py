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
    variants = ("single", "two-container", "three-container", "auto-uid", "explicit-uid")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("variants", nargs="*", choices=variants)
    selected = parser.parse_args().variants or variants
    image = "talaria-monorepo-smoke:" + uuid.uuid4().hex[:12]
    try:
        build(image)
        subprocess.run(["docker", "run", "--rm", "--entrypoint", "/bin/sh", image, "-c",
                        "test ! -e /apptoo/.venv && test ! -e /apptoo/.codex-tmp && test ! -e /apptoo/packages/frontend/node_modules && test -f /apptoo/packages/server/dist/bin/talaria-web.js"], check=True)
        # Variants own their project, container names, state and ephemeral ports, so they run concurrently.
        with ThreadPoolExecutor(max_workers=len(selected)) as pool:
            for future in [pool.submit(smoke, variant, image) for variant in selected]:
                future.result()
    finally:
        subprocess.run(["docker", "image", "rm", image], check=False)


def smoke(variant, image):
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
            service["container_name"] = f"{project}-{service_name}"
            service["restart"] = "no"
            for port in service.get("ports", []):
                port.update(published="0", host_ip="127.0.0.1")
        web = config["services"]["hermes-webui"]
        web["image"] = image
        web.pop("build", None)
        for kind in ("volumes", "networks"):
            for resource in config.get(kind, {}).values():
                resource.pop("name", None)
        configured = state / "compose.json"
        configured.write_text(json.dumps(config))
        compose = ["docker", "compose", "--env-file", os.devnull, "-p", project, "-f", str(configured)]
        try:
            subprocess.run([*compose, "up", "-d", "--wait", "--wait-timeout", "180"], env=env, check=True)
            address = subprocess.check_output([*compose, "port", "hermes-webui", "8787"], env=env, text=True).strip()
            with urllib.request.urlopen(f"http://{address}/health", timeout=10) as response:
                assert json.load(response)["status"] == "ok"
            if variant.endswith("-uid"):
                actual = subprocess.check_output([*compose, "exec", "-T", "hermes-webui", "id", "-u", "hermeswebui"], env=env, text=True).strip()
                assert actual == ("1001" if variant == "auto-uid" else "1024"), actual
            print(f"PASS Docker {variant} health", flush=True)
        finally:
            subprocess.run([*compose, "logs", "--no-color", "--tail=60"], env=env, check=False)
            subprocess.run([*compose, "down", "--volumes", "--remove-orphans"], env=env, check=True)


if __name__ == "__main__":
    main()
