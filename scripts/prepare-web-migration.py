#!/usr/bin/env python3
"""Prepare a Web-only main or published checkout, preserving the legacy install."""

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "web"))
from api.talaria_releases import (
    REPOSITORY_URL,
    published_web_release,
    verify_release_source,
)


def run_git(args, cwd, timeout=60):
    result = subprocess.run(["git", *args], cwd=cwd, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
                            capture_output=True, text=True, timeout=timeout, check=False)
    return result.stdout.strip(), result.returncode == 0


def checked_env(path):
    if path.is_symlink():
        raise ValueError("Review the legacy .env symlink before migrating")
    if not path.exists():
        return None
    if not path.is_file():
        raise ValueError("Legacy .env must be a regular file")
    data = path.read_bytes()
    for line in data.decode("utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)", line)
        if not match:
            raise ValueError("Migration requires simple dotenv assignments; review shell configuration manually")
        key, raw = match.groups()
        value = shlex.split(raw, comments=True)
        if len(value) > 1 or (("$" in raw or "`" in raw) and not raw.strip().startswith("'")):
            raise ValueError(f"Resolve shell expansion or quoting for {key} before migration")
        value = value[0] if value else ""
        path_key = key.endswith(("_DIR", "_PATH", "_HOME", "_FILE", "_WORKSPACE", "_ROOT")) or key in {
            "HERMES_HOME", "HERMES_CONFIG_PATH", "HERMES_WEBUI_PYTHON", "HERMES_WEBUI_SERVER_CWD",
            "HERMES_WEBUI_TLS_CERT", "HERMES_WEBUI_TLS_KEY",
        }
        if path_key and value and not Path(value).is_absolute():
            raise ValueError(f"Use an absolute path for {key} before migration")
        if key in ("PYTHONPATH", "NODE_PATH", "PATH"):
            raise ValueError(f"Review {key} manually before migrating the launch environment")
    return data


def prepare(legacy, destination, release, *, channel="stable"):
    legacy, destination = Path(legacy).resolve(), Path(destination).absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError("Choose a new destination outside the legacy checkout")
    destination = destination.resolve()
    if destination.is_relative_to(legacy):
        raise ValueError("Choose a new destination outside the legacy checkout")
    top, ok = run_git(["rev-parse", "--show-toplevel"], legacy)
    if not ok or Path(top).resolve() != legacy or not (legacy / "server.py").is_file() or not (legacy / "api").is_dir():
        raise ValueError("Legacy directory must be a standalone Web Git checkout")
    status, ok = run_git(["status", "--porcelain", "--untracked-files=all"], legacy)
    if not ok or status:
        raise ValueError("Reconcile local legacy source changes before preparing migration")
    old, ok = run_git(["rev-parse", "HEAD"], legacy)
    if not ok:
        raise ValueError("Could not read the legacy source revision")
    environment = checked_env(legacy / ".env")
    destination.parent.mkdir(parents=True, exist_ok=True)
    ref = "main" if channel == "experimental" else release["tag"]
    _, ok = run_git(["clone", "--filter=blob:none", "--no-checkout", "--single-branch", "--branch", ref,
                     REPOSITORY_URL + ".git", str(destination)], destination.parent, timeout=300)
    if not ok:
        raise ValueError("Clone failed; check repository read access. Inspect any partial destination before retrying.")
    selected = "refs/remotes/origin/main^{commit}" if channel == "experimental" else f"refs/tags/{release['tag']}^{{commit}}"
    source, ok = run_git(["rev-parse", selected], destination)
    if not ok or not re.fullmatch(r"[a-f0-9]{40}", source) or (channel != "experimental" and source != release["sourceRevision"]):
        raise ValueError("Published tag does not match the release manifest; destination was not activated")
    _, included = run_git(["merge-base", "--is-ancestor", old, source], destination)
    if not included:
        raise ValueError("The selected source does not contain this legacy revision; reconcile the fork manually")
    metadata = verify_release_source(destination, release, run_git) if channel != "experimental" else None
    _, ok = run_git(["sparse-checkout", "set", "--cone", "web", "contracts", "scripts"], destination)
    if not ok:
        raise ValueError("Could not prepare the Web-only sparse checkout; destination was not activated")
    _, ok = run_git(["checkout", "main"] if channel == "experimental" else ["checkout", "--detach", source], destination)
    if not ok:
        raise ValueError("Could not check out the published source; destination was not activated")
    if environment is not None:
        config = destination / "web/.env"
        with config.open("xb") as stream:
            os.chmod(config, 0o600)
            stream.write(environment)
    if metadata is not None:
        with (destination / "web/api/_release.json").open("x") as stream:
            stream.write(json.dumps(metadata, indent=2) + "\n")
    return {"prepared": True, "legacyRevision": old, "sourceRevision": source,
            "tag": release["tag"] if release else None, "updateChannel": channel,
            "workingDirectory": str(destination / "web"), "environmentCopied": environment is not None,
            "launch": ["python3", str(destination / "web/bootstrap.py"), "--foreground", "--no-browser", "--skip-agent-install"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("legacy", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--channel", choices=("stable", "experimental"), default="stable")
    args = parser.parse_args()
    try:
        release = published_web_release(args.channel) if args.channel != "experimental" else None
        receipt = prepare(args.legacy, args.destination, release, channel=args.channel)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Migration preparation failed: {error}\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
