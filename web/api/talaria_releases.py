"""Resolve Talaria main updates and completed component release sets."""

import json
import os
from pathlib import Path
import re
import tempfile
from time import monotonic
import urllib.request
from urllib.parse import urlsplit

from api.release_info import RELEASE_INFO, RUNNING_SOURCE_REVISION, STAMPED_RELEASE_INFO


REPOSITORY = "MaudeCode/talaria"
REPOSITORY_URL = f"https://github.com/{REPOSITORY}"
API_ROOT = f"https://api.github.com/repos/{REPOSITORY}"
# Anchored paths work from both the Git root and Web's nested working directory.
WEB_UPDATE_PATHS = (":(top)web/", ":(top)contracts/")
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
    # This opt-in credential is distinct from Agent/provider credentials.
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
    """Resolve the newest published known-good set for the selected Web channel.

    Root releases are named release-set-<source SHA> and publish release-set.json
    only after component gates pass. Component tags alone never advertise an
    update. Publication timestamps select the current known-good set.
    """
    if channel not in ("stable", "experimental"):
        raise ReleaseUnavailable("Unknown Web release channel")
    tag_pattern = re.compile(("web-exp-v" if channel == "experimental" else "web-v") + _VERSION)
    deadline = monotonic() + 15

    def fetch(path, *, asset=False):
        if monotonic() >= deadline:
            raise ReleaseUnavailable("Release lookup exceeded its deadline; retry or update manually")
        return _get_json(path, asset=asset)
    # Bound API work. If no selected-channel set is present, report unavailable
    # rather than interpreting an old unprefixed tag as a Talaria release.
    published = []
    for page in range(1, 6):
        releases = fetch(f"/releases?per_page=100&page={page}")
        if not isinstance(releases, list):
            raise ReleaseUnavailable("Invalid published release list")
        published.extend(item for item in releases if isinstance(item, dict) and not item.get("draft")
                         and isinstance(item.get("published_at"), str))
        if len(releases) < 100:
            break
    else:
        raise ReleaseUnavailable("Release history exceeds automatic lookup; update manually")
    for release in sorted(published, key=lambda item: item["published_at"], reverse=True):
        tag = release.get("tag_name", "")
        if not isinstance(tag, str) or not re.fullmatch(r"release-set-[a-f0-9]{40}", tag):
            continue
        if not isinstance(release.get("assets"), list):
            raise ReleaseUnavailable("Published release set has invalid assets")
        assets = [item for item in release["assets"]
                  if isinstance(item, dict) and item.get("name") == "release-set.json"]
        if len(assets) != 1 or type(assets[0].get("id")) is not int or assets[0]["id"] < 1:
            raise ReleaseUnavailable("Published release set lacks its immutable manifest")
        manifest = fetch(f"/releases/assets/{assets[0]['id']}", asset=True)
        if (not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1
                or manifest.get("status") != "complete" or manifest.get("releaseSet") != tag.removeprefix("release-set-")):
            raise ReleaseUnavailable("Release set is incomplete or has inconsistent provenance")
        if not isinstance(manifest.get("components"), dict):
            raise ReleaseUnavailable("Release set lacks component metadata")
        component = manifest["components"].get("web", {})
        if not isinstance(component, dict):
            raise ReleaseUnavailable("Release set lacks Web metadata")
        component_tag = component.get("tag", "")
        if not isinstance(component_tag, str) or not tag_pattern.fullmatch(component_tag):
            continue
        source = component.get("sourceRevision", "")
        if (not isinstance(source, str) or not _SHA.fullmatch(source)
                or component.get("releaseSet") != source
                or component.get("version") != component_tag.split("-v")[-1]
                or not isinstance(component.get("image"), str)
                or not re.fullmatch(r"ghcr\.io/maudecode/talaria-web@sha256:[a-f0-9]{64}", component["image"])):
            raise ReleaseUnavailable("Web release references are mutable or inconsistent")
        contracts = manifest.get("contracts", {})
        try:
            supported = {name: contracts[name]["web"] for name in ("appWeb", "webRelay")}
            agent = manifest["agent"]
            if (not all(isinstance(items, list) and items and all(type(value) is int and value > 0 for value in items)
                        for items in supported.values()) or not isinstance(agent, dict)
                    or not isinstance(component.get("upstreamBase"), str)
                    or not _SHA.fullmatch(component["upstreamBase"])):
                raise ValueError("invalid runtime provenance")
        except (KeyError, TypeError, ValueError) as error:
            raise ReleaseUnavailable("Release set lacks Web compatibility provenance") from error
        return {**component, "manifestReleaseSet": manifest["releaseSet"],
                "runtime": {"tag": component_tag, "version": component["version"], "sourceRevision": source, "releaseSet": source,
                            "upstreamBase": component["upstreamBase"], "contracts": supported, "compatibleAgent": agent},
                "release_url": f"{REPOSITORY_URL}/releases/tag/{tag}"}
    raise ReleaseUnavailable("No completed Talaria Web release is available on this channel")


def _checkout_root(web_path, run_git):
    if web_path is None:
        return None
    web_path = Path(web_path).resolve()
    top, ok = run_git(["rev-parse", "--show-toplevel"], web_path)
    if not ok or Path(top).resolve() / "web" != web_path:
        return None
    root = Path(top).resolve()
    if not (root / "contracts/versions.json").is_file() or not (web_path / "server.py").is_file():
        return None
    remote, ok = run_git(["remote", "get-url", "origin"], root)
    if not ok:
        return None
    normalized = remote.strip().rstrip("/").removesuffix(".git").lower()
    if normalized != "git@github.com:maudecode/talaria":
        try:
            parsed = urlsplit(normalized)
            if (parsed.scheme not in ("https", "ssh") or parsed.hostname != "github.com"
                    or parsed.path != "/maudecode/talaria" or parsed.query or parsed.fragment
                    or parsed.port not in (None, 443 if parsed.scheme == "https" else 22)):
                return None
        except ValueError:
            return None
    return root


def check_web_update(web_path, current_version, channel, run_git):
    root = _checkout_root(web_path, run_git)
    result = {"name": "webui", "channel": channel, "repo_url": REPOSITORY_URL,
              "current_version": current_version, "behind": None, "no_git": root is None}
    if channel == "experimental" and root is not None:
        return _check_main_update(root, result, run_git)
    try:
        release = published_web_release(channel)
    except ReleaseUnavailable as error:
        return {**result, "manual_update": True, "error": str(error)}
    except (OSError, ValueError, TimeoutError):
        return {**result, "manual_update": True,
                "error": "Talaria release metadata is unavailable. Private repositories require TALARIA_RELEASE_TOKEN with Contents read access."}
    result.update(latest_version=release["tag"], latest_sha=release["sourceRevision"],
                  branch=release["tag"], release_based=True, release_url=release["release_url"],
                  image=release["image"])
    if root is None:
        current = RELEASE_INFO.get("sourceRevision")
        prefix = "web-exp-v" if channel == "experimental" else "web-v"
        version = re.fullmatch(prefix + _VERSION, current_version or "")
        behind = 0 if version and current == release["sourceRevision"] else None
        if behind is None and version:
            installed = tuple(int(value) for value in version.groups())
            latest = tuple(int(value) for value in release["version"].split("."))
            if installed != latest:
                behind = 1 if installed < latest else 0
        return {**result, "current_sha": current, "behind": behind,
                "no_git": True, "manual_update": True,
                "message": "Use the published Talaria Web image or authenticated monorepo installation; legacy checkouts require migration."}
    current, ok = run_git(["rev-parse", "HEAD"], root)
    status, clean = run_git(["status", "--porcelain", "--untracked-files=all"], root)
    if not ok or not _SHA.fullmatch(current) or not clean:
        return {**result, "manual_update": True, "error": "Could not verify the source checkout"}
    result.update(installed_sha=current, dirty=bool(status))
    if current == release["sourceRevision"]:
        try:
            _, expected, installed = _verified_release_stamp(root, release, run_git)
            result.update(behind=0, metadata_repair=installed != expected or RELEASE_INFO != expected)
            if result["metadata_repair"]:
                result["message"] = "Apply the selected release again to repair its metadata or restart with its recorded identity."
        except (OSError, KeyError, TypeError, ValueError):
            result.update(behind=None, manual_update=True, error="Could not verify local release provenance; inspect the release stamp before updating.")
        base, known_base = current, True
    else:
        _, contains = run_git(["merge-base", "--is-ancestor", release["sourceRevision"], current], root)
        if contains:
            return {**result, "behind": None, "manual_update": True, "current_sha": None,
                    "message": "This checkout is ahead of the selected release. Manage it manually or check out the published release and restart Web."}
        result["behind"] = 1
        base, known_base = run_git(["merge-base", current, release["sourceRevision"]], root)
        if known_base and base != current and not contains:
            result.update(manual_update=True, message="Reconcile divergent source history before updating Web.")
    # Local-only commits cannot appear in a GitHub comparison. Only an ancestor
    # of the published source is known to exist there; omit unresolvable links.
    result['current_sha'] = base if known_base and _SHA.fullmatch(base) else None
    if result['current_sha']:
        result['compare_url'] = f"{REPOSITORY_URL}/compare/{base}...{release['sourceRevision']}"
    if status:
        result.update(manual_update=True, message="Commit or remove local changes before updating; Web updates never discard them.")
    return result


def _main_revision(root, run_git):
    output, ok = run_git(["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"], root, timeout=30)
    if not ok:
        return None, output
    source, ok = run_git(["rev-parse", "refs/remotes/origin/main^{commit}"], root)
    return (source, "") if ok and _SHA.fullmatch(source) else (None, "")


def _main_paths_differ(root, before, after, run_git):
    files, ok = run_git(["diff", "--no-renames", "--name-only", before, after, "--", *WEB_UPDATE_PATHS], root)
    return bool(files) if ok else None


def _main_change_count(root, before, after, run_git):
    changed = _main_paths_differ(root, before, after, run_git)
    if changed is None:
        return None
    if not changed:
        return 0
    count, ok = run_git(["rev-list", "--count", "--full-history", f"{before}..{after}", "--", *WEB_UPDATE_PATHS], root)
    return int(count) if ok and count.isdigit() and int(count) > 0 else None


def _main_restart_pending(root, head, run_git):
    if RUNNING_SOURCE_REVISION == head:
        return False
    if not RUNNING_SOURCE_REVISION:
        return True
    # A disk-only App change does not make Web's loaded code stale. Unknown
    # runtime identity still requires a restart rather than claiming success.
    return _main_paths_differ(root, RUNNING_SOURCE_REVISION, head, run_git) is not False


def _main_stamp(root):
    """Only discard the unchanged generated release stamp when leaving a release."""
    stamp = root / "web/api/_release.json"
    if stamp.is_symlink():
        raise ValueError("local release stamp is a symbolic link")
    data = stamp.read_bytes() if stamp.exists() else None
    if data is not None and (not STAMPED_RELEASE_INFO.get("tag") or json.loads(data) != STAMPED_RELEASE_INFO):
        raise ValueError("local release stamp was modified")
    return stamp, data


def _check_main_update(root, result, run_git):
    result.update(branch="origin/main", release_based=False)
    if root is None:
        return {**result, "manual_update": True, "message": "Main updates require an authenticated Talaria source checkout with Web under web/."}
    source, error = _main_revision(root, run_git)
    if source is None:
        return {**result, "error": _git_failure(error, "Could not fetch origin/main; check Git read access.")["message"]}
    result.update(latest_sha=source, latest_version=f"main@{source[:12]}")
    head, ok = run_git(["rev-parse", "HEAD"], root)
    status, clean = run_git(["status", "--porcelain", "--untracked-files=all"], root)
    if not ok or not _SHA.fullmatch(head) or not clean:
        return {**result, "manual_update": True, "error": "Could not verify the source checkout"}
    result.update(installed_sha=head, dirty=bool(status))
    base, known = run_git(["merge-base", head, source], root)
    result["current_sha"] = base if known and _SHA.fullmatch(base) else None
    if result["current_sha"]:
        result["compare_url"] = f"{REPOSITORY_URL}/compare/{base}...{source}"
    if not known or base != head:
        return {**result, "manual_update": True, "message": "This checkout is ahead of or diverged from origin/main; reconcile it manually."}
    count = _main_change_count(root, head, source, run_git)
    if count is None:
        return {**result, "error": "Could not compare the source checkout with origin/main"}
    try:
        _main_stamp(root)
    except (OSError, ValueError, TypeError):
        return {**result, "manual_update": True, "error": "Inspect the modified release stamp before updating."}
    result.update(behind=count, metadata_repair=count == 0 and _main_restart_pending(root, head, run_git))
    if status:
        result.update(manual_update=True, message="Commit or remove local changes before updating; Web updates never discard them.")
    elif result["metadata_repair"]:
        result["message"] = "Source is current; finish the update to restart with that revision."
    return result


def _verified_release_stamp(root, release, run_git):
    expected = verify_release_source(root, release, run_git)
    stamp = root / "web/api/_release.json"
    if stamp.is_symlink():
        raise ValueError("local release stamp is a symbolic link")
    installed = json.loads(stamp.read_text()) if stamp.exists() else None
    if installed is not None and installed not in (RELEASE_INFO, STAMPED_RELEASE_INFO, expected):
        raise ValueError("local release stamp was modified")
    return stamp, expected, installed


def apply_web_update(web_path, channel, run_git):
    """Fast-forward a recognized clean checkout to main or a published Stable tag."""
    root = _checkout_root(web_path, run_git)
    if root is None:
        return {"ok": False, "manual_update": True,
                "message": "Automatic updates require a Talaria monorepo checkout with Web under web/. Migrate this installation manually."}
    status, ok = run_git(["status", "--porcelain", "--untracked-files=all"], root)
    if not ok or status:
        return {"ok": False, "dirty": True, "message": "Web update refused: the checkout must be clean, including untracked files."}
    for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"):
        path, ok = run_git(["rev-parse", "--git-path", marker], root)
        if not ok or (root / path).exists():
            return {"ok": False, "message": "Finish or abort the repository operation before updating Web."}
    head, ok = run_git(["rev-parse", "HEAD"], root)
    if not ok or not _SHA.fullmatch(head):
        return {"ok": False, "message": "Could not verify the current source revision"}
    main = channel == "experimental"
    if main:
        source, error = _main_revision(root, run_git)
        if source is None:
            return _git_failure(error, "Could not fetch origin/main; check Git read access.")
        tag = "main"
    else:
        try:
            release = published_web_release(channel)
        except (OSError, ValueError, TimeoutError):
            return {"ok": False, "message": "Cannot resolve a completed Talaria release. Check private-repository read access."}
        source, tag = release["sourceRevision"], release["tag"]
    if head != source and not main:
        # Fetch only this immutable tag. Never force-replace a local tag or pull an
        # unrecorded main/upstream tip. Git's configured credentials authenticate it.
        output, ok = run_git(["fetch", "--no-tags", "origin", f"refs/tags/{tag}:refs/tags/{tag}"], root, timeout=30)
        if not ok:
            return _git_failure(output, "Could not fetch the published Web tag. Check Git credentials or a conflicting local tag.")
        fetched, ok = run_git(["rev-parse", f"refs/tags/{tag}^{{commit}}"], root)
        if not ok or fetched != source:
            return {"ok": False, "message": "Published Web tag does not match the immutable release manifest"}
    if head != source:
        _, forward = run_git(["merge-base", "--is-ancestor", head, source], root)
        if not forward:
            _, contains = run_git(["merge-base", "--is-ancestor", source, head], root)
            if contains:
                return {"ok": False, "manual_update": True, "target": "webui", "channel": channel,
                        "message": "This checkout is ahead of the selected source. Manage it manually; updates never rewind local work."}
            return {"ok": False, "message": "Web update refused: source histories diverge; reconcile the checkout manually."}
    if main:
        count = _main_change_count(root, head, source, run_git)
        if count is None:
            return {"ok": False, "message": "Could not compare Web and contract changes against origin/main."}
        if count == 0:
            source = head  # No checkout mutation for App/Relay-only changes.
    # Compare provenance with the immutable incoming files before modifying the
    # checkout. Do not import downloaded code into the running old process.
    try:
        if main:
            stamp, installed = _main_stamp(root)
            expected = None
        else:
            stamp, expected, installed = _verified_release_stamp(root, release, run_git)
    except (OSError, KeyError, TypeError, ValueError):
        return {"ok": False, "message": "Web update refused: source or local provenance does not match the release manifest."}
    runtime_current = not _main_restart_pending(root, head, run_git) if main else installed == expected and RELEASE_INFO == expected
    if head == source and runtime_current:
        return {"ok": True, "up_to_date": True, "target": "webui", "channel": channel,
                "message": "Web and shared contracts are current on main." if main else "Talaria Web already contains the selected release."}
    current, same_head = run_git(["rev-parse", "HEAD"], root)
    status, clean = run_git(["status", "--porcelain", "--untracked-files=all"], root)
    if not same_head or current != head or not clean or status:
        return {"ok": False, "message": "The checkout changed during the update; retry after it is clean."}
    if head != source:
        # Diffstat reads excluded blobs even on a sparse fast-forward. Keep
        # updates metadata-only outside the checked-out Web directories.
        output, ok = run_git(["merge", "--ff-only", "--no-stat", "--no-overwrite-ignore", source], root, timeout=30)
        actual, verified = run_git(["rev-parse", "HEAD"], root)
        if not ok or not verified or actual != source:
            return _git_failure(output, "Web fast-forward failed; no local changes were discarded.")
    if main and installed is not None:
        try:
            if stamp.is_symlink() or stamp.read_bytes() != installed:
                raise ValueError("release stamp changed during update")
            stamp.unlink()
        except (OSError, ValueError):
            return {"ok": False, "message": "Source advanced but its release stamp could not be cleared; inspect it before restarting Web."}
    elif not main and installed != expected:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=stamp.parent, prefix=".release-", delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(json.dumps(expected, indent=2) + "\n")
            temporary.replace(stamp)
        except OSError:
            return {"ok": False, "message": "Source advanced, but release metadata could not be written. Repair file permissions before restarting Web."}
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
    return {"ok": True, "target": "webui", "channel": channel,
            "sourceRevision": source, "message": f"Updated Talaria Web to {tag}."}


def _git_failure(output, message):
    from api.updates import _is_git_lock_error

    if _is_git_lock_error(output):
        return {"ok": False, "lock_conflict": True,
                "message": "Web update is blocked by a repository lock. Wait for the other Git operation or inspect the checkout manually."}
    return {"ok": False, "message": message}


def verify_release_source(root, release, run_git):
    """Check published metadata against immutable source blobs without importing code."""
    source, tag = release["sourceRevision"], release["tag"]
    files = {}
    for name in ("sidecar/agent_dependency.json", "api/contract_versions.json", "UPSTREAM_BASE_SHA"):
        contents, exists = run_git(["show", f"{source}:web/{name}"], root)
        if not exists:
            raise ValueError("missing release metadata")
        files[name] = contents.strip() if name.endswith("SHA") else json.loads(contents)
    pin, versions = files["sidecar/agent_dependency.json"], files["api/contract_versions.json"]
    expected = {"tag": tag, "version": release["version"], "sourceRevision": source, "releaseSet": source,
                "upstreamBase": files["UPSTREAM_BASE_SHA"],
                "compatibleAgent": {**pin["x-talaria"], "image": pin["services"]["hermes-agent"]["image"]},
                "contracts": {"appWeb": [versions["appWeb"]["fixtureVersion"]],
                              "webRelay": [versions["webRelay"]["protocolVersion"]]}}
    if expected != release["runtime"]:
        raise ValueError("release metadata differs from source")
    return expected
