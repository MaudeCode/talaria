#!/usr/bin/env python3
"""Prepare a Web-only main or published checkout, preserving the legacy install."""

import argparse
import json
import os
import re
import shlex
import subprocess
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = "MaudeCode/talaria"
REPOSITORY_URL = f"https://github.com/{REPOSITORY}"
API_ROOT = f"https://api.github.com/repos/{REPOSITORY}"
_SHA = re.compile(r"[a-f0-9]{40}")
_VERSION = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"


class ReleaseUnavailable(ValueError):
    """No trustworthy published release could be resolved."""


class _AssetRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        if target.scheme != "https" or target.hostname != "release-assets.githubusercontent.com":
            raise ReleaseUnavailable("Unexpected release download redirect")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            redirected.remove_header("Authorization")
        return redirected


def _get_json(path, *, asset=False):
    headers = {"Accept": "application/octet-stream" if asset else "application/vnd.github+json",
               "User-Agent": "Talaria-Web", "X-GitHub-Api-Version": "2026-03-10"}
    token = os.environ.get("TALARIA_RELEASE_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(API_ROOT + path, headers=headers)
    with urllib.request.build_opener(_AssetRedirect()).open(request, timeout=5) as response:
        data = response.read(2_000_001)
    if len(data) > 2_000_000:
        raise ReleaseUnavailable("Release metadata exceeds the download limit")
    return json.loads(data)


def published_web_release(channel="stable"):
    """The newest completed `release-set-<sha>` whose Web component matches the channel (Web `tools/updates.ts`)."""
    tag_pattern = re.compile(("web-exp-v" if channel == "experimental" else "web-v") + _VERSION)
    published = []
    for page in range(1, 6):
        releases = _get_json(f"/releases?per_page=100&page={page}")
        if not isinstance(releases, list):
            raise ReleaseUnavailable("Invalid published release list")
        published.extend(item for item in releases if isinstance(item, dict) and not item.get("draft") and isinstance(item.get("published_at"), str))
        if len(releases) < 100:
            break
    else:
        raise ReleaseUnavailable("Release history exceeds automatic lookup; update manually")
    for release in sorted(published, key=lambda item: item["published_at"], reverse=True):
        tag = release.get("tag_name", "")
        if not isinstance(tag, str) or not re.fullmatch(r"release-set-[a-f0-9]{40}", tag):
            continue
        assets = [item for item in release.get("assets", []) if isinstance(item, dict) and item.get("name") == "release-set.json"]
        if len(assets) != 1 or type(assets[0].get("id")) is not int or assets[0]["id"] < 1:
            raise ReleaseUnavailable("Published release set lacks its immutable manifest")
        manifest = _get_json(f"/releases/assets/{assets[0]['id']}", asset=True)
        if (not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1
                or manifest.get("status") != "complete" or manifest.get("releaseSet") != tag.removeprefix("release-set-")):
            raise ReleaseUnavailable("Release set is incomplete or has inconsistent provenance")
        component = (manifest.get("components") or {}).get("web", {})
        component_tag = component.get("tag", "") if isinstance(component, dict) else ""
        if not isinstance(component_tag, str) or not tag_pattern.fullmatch(component_tag):
            continue
        source = component.get("sourceRevision", "")
        if not isinstance(source, str) or not _SHA.fullmatch(source) or component.get("releaseSet") != source:
            raise ReleaseUnavailable("Web release references are mutable or inconsistent")
        contracts = manifest.get("contracts", {})
        supported = {name: contracts[name]["web"] for name in ("appWeb", "webRelay")}
        return {**component, "runtime": {"tag": component_tag, "version": component["version"], "sourceRevision": source,
                                          "releaseSet": source, "contracts": supported, "compatibleAgent": manifest["agent"]}}
    raise ReleaseUnavailable("No completed Talaria Web release is available on this channel")


def verify_release_source(root, release, run_git):
    """Check published metadata against immutable source blobs without importing code."""
    files = {}
    for name in ("sidecar/agent_dependency.json", "contract_versions.json"):
        contents, exists = run_git(["show", f"{release['sourceRevision']}:web/{name}"], root)
        if not exists:
            raise ValueError("missing release metadata")
        files[name] = json.loads(contents)
    pin, versions = files["sidecar/agent_dependency.json"], files["contract_versions.json"]
    expected = {"tag": release["tag"], "version": release["version"], "sourceRevision": release["sourceRevision"], "releaseSet": release["sourceRevision"],
                "compatibleAgent": {**pin["x-talaria"], "image": pin["services"]["hermes-agent"]["image"]},
                "contracts": {"appWeb": [versions["appWeb"]["fixtureVersion"]], "webRelay": [versions["webRelay"]["protocolVersion"]]}}
    if expected != release["runtime"]:
        raise ValueError("release metadata differs from source")
    return expected


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
        with (destination / "web/_release.json").open("x") as stream:
            stream.write(json.dumps(metadata, indent=2) + "\n")
    return {"prepared": True, "legacyRevision": old, "sourceRevision": source,
            "tag": release["tag"] if release else None, "updateChannel": channel,
            "workingDirectory": str(destination / "web"), "environmentCopied": environment is not None,
            # The frontend bundle is built, not committed (TAL-379), so the checkout builds every workspace.
            "install": ["npm", "ci", "--prefix", str(destination / "web"), "--include=dev"],
            "build": ["npm", "run", "build:fast", "--prefix", str(destination / "web")],
            "launch": ["node", str(destination / "web/packages/server/dist/bin/talaria-web.js"), "--foreground", "--no-browser", "--skip-agent-install"]}


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
