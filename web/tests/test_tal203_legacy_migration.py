import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

import pytest


@pytest.fixture
def migration(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("prepare_web_migration", root / "scripts/prepare-web-migration.py")
    tool = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tool)

    def git(path, *args):
        return subprocess.check_output(["git", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-C", str(path), *args], text=True, stderr=subprocess.PIPE).strip()

    legacy = tmp_path / "legacy"
    git(tmp_path, "init", "-b", "main", str(legacy))
    (legacy / "api").mkdir()
    (legacy / "api/config.py").write_text("# synthetic legacy config\n")
    (legacy / "server.py").write_text("# synthetic legacy server\n")
    (legacy / ".gitignore").write_text(".env\nweb/api/_release.json\n")
    git(legacy, "add", ".")
    git(legacy, "commit", "-m", "synthetic legacy source")
    old = git(legacy, "rev-parse", "HEAD")
    state = tmp_path / "persistent-state"
    state.mkdir()
    (state / "session.json").write_text('{"id":"synthetic-session","text":"preserve me"}')
    env = f"HERMES_WEBUI_STATE_DIR='{state}'\nHERMES_WEBUI_PASSWORD='synthetic-password'\n"
    (legacy / ".env").write_text(env)
    upstream = tmp_path / "upstream.git"
    git(tmp_path, "clone", str(legacy), str(upstream))
    (upstream / "web").mkdir()
    git(upstream, "mv", "server.py", "api", "web/")
    for name in ("api/agent_dependency.json", "api/contract_versions.json"):
        shutil.copyfile(root / "web" / name, upstream / "web" / name)
    (upstream / "web/UPSTREAM_BASE_SHA").write_text(old + "\n")
    for name, text in (("app/ios.txt", "unrelated iOS bytes"), ("relay/backend.txt", "unrelated Relay bytes"),
                       ("contracts/versions.json", "{}"), ("scripts/check", "# synthetic shared script")):
        path = upstream / name
        path.parent.mkdir(exist_ok=True)
        path.write_text(text)
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "synthetic monorepo import")
    new = git(upstream, "rev-parse", "HEAD")
    git(upstream, "tag", "-a", "web-v2.0.0", "-m", "synthetic published tag")
    pin = json.loads((upstream / "web/api/agent_dependency.json").read_text())
    release = {"tag": "web-v2.0.0", "version": "2.0.0", "sourceRevision": new,
               "runtime": {"tag": "web-v2.0.0", "version": "2.0.0", "sourceRevision": new, "releaseSet": new,
                           "upstreamBase": old, "contracts": {"appWeb": [1], "webRelay": [2]},
                           "compatibleAgent": {**pin["x-talaria"], "image": pin["services"]["hermes-agent"]["image"]}}}
    git(upstream, "config", "uploadpack.allowFilter", "true")
    git(upstream, "config", "uploadpack.allowAnySHA1InWant", "true")
    monkeypatch.setattr(tool, "REPOSITORY_URL", upstream.as_uri().removesuffix(".git"))
    return tool, legacy, state, release, git


def test_prepares_prefixed_checkout_without_changing_legacy_state(migration, tmp_path):
    tool, legacy, state, release, git = migration
    before = (state / "session.json").read_bytes()
    old = git(legacy, "rev-parse", "HEAD")
    destination = tmp_path / "talaria"
    receipt = tool.prepare(legacy, destination, release)
    assert git(destination, "rev-parse", "HEAD") == release["sourceRevision"]
    assert git(legacy, "rev-parse", "HEAD") == old
    assert (state / "session.json").read_bytes() == before
    assert (destination / "web/.env").read_bytes() == (legacy / ".env").read_bytes()
    assert (destination / "web/.env").stat().st_mode & 0o777 == 0o600
    assert json.loads((destination / "web/api/_release.json").read_text()) == release["runtime"]
    assert receipt["workingDirectory"] == str(destination / "web")
    assert "synthetic-password" not in json.dumps(receipt)


@pytest.mark.parametrize("channel", ["experimental", "stable"])
@pytest.mark.parametrize("worktree", [False, True])
def test_sparse_partial_preparation_and_repeated_updates(migration, tmp_path, monkeypatch, channel, worktree):
    from api import talaria_releases as releases

    tool, legacy, state, release, git = migration
    upstream = tmp_path / "upstream.git"
    destination = tmp_path / "talaria"
    before = (state / "session.json").read_bytes()
    receipt = tool.prepare(legacy, destination, None if channel == "experimental" else release, channel=channel)
    assert git(destination, "config", "remote.origin.partialclonefilter") == "blob:none"
    assert git(destination, "config", "remote.origin.promisor") == "true"
    assert set(git(destination, "sparse-checkout", "list").splitlines()) == {"web", "contracts", "scripts"}
    assert not (destination / "app").exists() and not (destination / "relay").exists()
    missing = git(destination, "rev-list", "--objects", "--all", "--missing=print")
    for path in ("app/ios.txt", "relay/backend.txt"):
        assert "?" + git(upstream, "rev-parse", f"HEAD:{path}") in missing
    assert receipt["updateChannel"] == channel
    if channel == "experimental":
        assert git(destination, "branch", "--show-current") == "main"
        assert not (destination / "web/api/_release.json").exists()
    else:
        assert git(destination, "branch", "--show-current") == ""
        monkeypatch.setattr(releases, "RELEASE_INFO", release["runtime"])
        monkeypatch.setattr(releases, "STAMPED_RELEASE_INFO", release["runtime"])
    git(destination, "remote", "set-url", "origin", releases.REPOSITORY_URL + ".git")
    git(destination, "config", f"url.{upstream.as_uri()}.insteadOf", releases.REPOSITORY_URL + ".git")
    if worktree:
        tree = tmp_path / "deployment-worktree"
        git(destination, "worktree", "add", "--no-checkout", "--detach", str(tree), "HEAD")
        git(tree, "sparse-checkout", "set", "--cone", "web", "contracts", "scripts")
        git(tree, "checkout", "--detach", "HEAD")
        (tree / "web/.env").write_bytes((legacy / ".env").read_bytes())
        destination = tree

    def transport(args, cwd, **kwargs):
        # Keep canonical-origin validation while Git's real transport rewrites
        # origin to this fixture's filter-capable file:// server, including lazy fetches.
        if args == ["remote", "get-url", "origin"]:
            return releases.REPOSITORY_URL + ".git", True
        return tool.run_git(args, cwd, **kwargs)

    if channel == "experimental":
        monkeypatch.setattr(releases, "published_web_release", lambda *_: pytest.fail("Main must not query releases"))
    for revision in range(2):
        head = git(destination, "rev-parse", "HEAD")
        monkeypatch.setattr(releases, "RUNNING_SOURCE_REVISION", head, raising=False)
        (upstream / "web/server.py").write_text(f"# synthetic main {revision}\n")
        excluded = [f"{component}/new-{revision}.txt" for component in ("app", "relay")]
        for path in excluded:
            (upstream / path).write_text(f"unrelated {path} bytes")
        git(upstream, "add", ".")
        git(upstream, "commit", "-m", f"synthetic main {revision}")
        if channel == "stable":
            tag = f"web-v2.0.{revision + 1}"
            git(upstream, "tag", "-a", tag, "-m", "synthetic next release")
            source = git(upstream, "rev-parse", "HEAD")
            latest = {**release, "tag": tag, "version": f"2.0.{revision + 1}", "sourceRevision": source,
                      "release_url": releases.REPOSITORY_URL + "/releases/tag/" + tag,
                      "image": "ghcr.io/maudecode/talaria-web@sha256:" + "f" * 64}
            latest["runtime"] = {**release["runtime"], "tag": tag, "version": latest["version"], "sourceRevision": source, "releaseSet": source}
            monkeypatch.setattr(releases, "published_web_release", lambda _channel, selected=latest: selected)
        status = releases.check_web_update(destination / "web", "development", channel, transport)
        assert status["behind"] == 1, status
        result = releases.apply_web_update(destination / "web", channel, transport)
        assert result["ok"], result
        assert git(destination, "rev-parse", "HEAD") == git(upstream, "rev-parse", "HEAD")
        assert not (destination / "app").exists() and not (destination / "relay").exists()
        missing = git(destination, "rev-list", "--objects", "--all", "--missing=print")
        for path in excluded:
            assert "?" + git(upstream, "rev-parse", f"HEAD:{path}") in missing
        if channel == "stable":
            monkeypatch.setattr(releases, "RELEASE_INFO", latest["runtime"])
            monkeypatch.setattr(releases, "STAMPED_RELEASE_INFO", latest["runtime"])
    assert (state / "session.json").read_bytes() == before
    assert (destination / "web/.env").read_bytes() == (legacy / ".env").read_bytes()


def test_refuses_relative_configuration_and_existing_destinations(migration, tmp_path):
    tool, legacy, _, release, _ = migration
    destination = tmp_path / "talaria"
    (legacy / ".env").write_text("HERMES_WEBUI_STATE_DIR=./state\n")
    with pytest.raises(ValueError, match="absolute path"):
        tool.prepare(legacy, destination, release)
    assert not destination.exists()
    with pytest.raises(ValueError, match="new destination"):
        tool.prepare(legacy, legacy, release)
    alias = tmp_path / "alias"
    alias.symlink_to(legacy, target_is_directory=True)
    with pytest.raises(ValueError, match="outside"):
        tool.prepare(legacy, alias / "nested", release)
