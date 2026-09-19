import json
import os
import subprocess

import pytest

from api import talaria_releases as releases


@pytest.fixture
def source_install(tmp_path, monkeypatch):
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_AUTHOR_NAME": "Synthetic", "GIT_COMMITTER_NAME": "Synthetic",
           "GIT_AUTHOR_EMAIL": "synthetic@example.invalid", "GIT_COMMITTER_EMAIL": "synthetic@example.invalid"}

    def git(path, *args):
        return subprocess.check_output(["git", "-c", "commit.gpgsign=false", "-C", str(path), *args], env=env, text=True, stderr=subprocess.PIPE).strip()

    upstream = tmp_path / "upstream"
    git(tmp_path, "init", "-b", "main", str(upstream))
    (upstream / "web/api").mkdir(parents=True)
    (upstream / "contracts").mkdir()
    (upstream / "web/server.py").write_text("version = 'old'\n")
    (upstream / ".gitignore").write_text("web/api/_release.json\nweb/cache.txt\n")
    versions = {"appWeb": {"fixtureVersion": 1}, "webRelay": {"protocolVersion": 2}}
    pin = {"x-talaria": {"version": "0.0.1", "sourceRevision": "d" * 40},
           "services": {"hermes-agent": {"image": "docker.io/nousresearch/hermes-agent@sha256:" + "e" * 64}}}
    for relative, value in (("web/api/agent_dependency.json", pin), ("web/api/contract_versions.json", versions), ("contracts/versions.json", versions)):
        (upstream / relative).write_text(json.dumps(value))
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "synthetic old release")
    old = git(upstream, "rev-parse", "HEAD")
    (upstream / "web/server.py").write_text("version = 'new'\n")
    (upstream / "web/UPSTREAM_BASE_SHA").write_text(old + "\n")
    (upstream / "web/cache.txt").write_text("incoming tracked file\n")
    git(upstream, "add", ".")
    git(upstream, "add", "-f", "web/cache.txt")
    git(upstream, "commit", "-m", "synthetic published release")
    new = git(upstream, "rev-parse", "HEAD")
    git(upstream, "-c", "tag.gpgsign=false", "tag", "-a", "web-v2.0.0", "-m", "synthetic tag")
    client = tmp_path / "client"
    git(tmp_path, "clone", str(upstream), str(client))
    git(client, "reset", "--hard", old)
    git(client, "tag", "-d", "web-v2.0.0")
    git(client, "remote", "set-url", "origin", "https://github.com/MaudeCode/talaria.git")
    runtime = {"tag": "web-v2.0.0", "version": "2.0.0", "sourceRevision": new, "releaseSet": new, "upstreamBase": old,
               "contracts": {"appWeb": [1], "webRelay": [2]},
               "compatibleAgent": {**pin["x-talaria"], "image": pin["services"]["hermes-agent"]["image"]}}
    release = {"tag": "web-v2.0.0", "version": "2.0.0", "sourceRevision": new,
               "runtime": runtime, "release_url": "https://github.com/MaudeCode/talaria/releases/tag/release-set-" + new,
               "image": "ghcr.io/maudecode/talaria-web@sha256:" + "f" * 64}
    monkeypatch.setattr(releases, "published_web_release", lambda channel: release)
    commands = []

    def run_git(args, cwd, timeout=10):
        commands.append(args)
        # The production URL remains configured; only this fixture's transport
        # is redirected to its own synthetic repository. No network is used.
        if args[0] == "fetch":
            args = [str(upstream) if arg == "origin" else arg for arg in args]
        process = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
        return (process.stdout if process.returncode == 0 else process.stderr).strip(), process.returncode == 0

    return client, upstream, old, new, release, git, run_git, commands


@pytest.mark.parametrize("worktree", [False, True])
def test_fast_forwards_published_source_and_stamps_runtime(source_install, tmp_path, worktree, monkeypatch):
    client, _, _, new, release, git, run_git, _ = source_install
    if worktree:
        directory = tmp_path / "worktree"
        git(client, "worktree", "add", "--detach", str(directory), "HEAD")
        client = directory
        assert (client / ".git").is_file()
    result = releases.apply_web_update(client / "web", "stable", run_git)
    assert result["ok"] is True
    assert git(client, "rev-parse", "HEAD") == new
    assert (client / "web/server.py").read_text() == "version = 'new'\n"
    assert json.loads((client / "web/api/_release.json").read_text()) == release["runtime"]
    monkeypatch.setattr(releases, "RELEASE_INFO", release["runtime"])
    assert releases.apply_web_update(client / "web", "stable", run_git)["up_to_date"] is True


@pytest.mark.parametrize("file", ["web/server.py", "untracked.txt", "web/cache.txt"])
def test_never_discards_local_files(source_install, file):
    client, _, old, _, _, git, run_git, commands = source_install
    path = client / file
    path.write_text("local work must survive\n")
    result = releases.apply_web_update(client / "web", "stable", run_git)
    assert result["ok"] is False
    assert path.read_text() == "local work must survive\n"
    assert git(client, "rev-parse", "HEAD") == old
    if file != "web/cache.txt":
        assert not any(command[0] == "fetch" for command in commands)


def test_refuses_divergence_and_manifest_tag_mismatch(source_install):
    client, _, old, _, release, git, run_git, _ = source_install
    (client / "local.txt").write_text("committed local work")
    git(client, "add", ".")
    git(client, "commit", "-m", "synthetic divergent work")
    head = git(client, "rev-parse", "HEAD")
    status = releases.check_web_update(client / "web", "web-v1.0.0", "stable", run_git)
    assert status["installed_sha"] == head
    assert status["current_sha"] == old
    assert head not in status["compare_url"]
    assert status["manual_update"] is True
    assert releases.apply_web_update(client / "web", "stable", run_git)["ok"] is False
    assert git(client, "rev-parse", "HEAD") == head
    git(client, "reset", "--hard", old)
    release["sourceRevision"] = "b" * 40
    assert releases.apply_web_update(client / "web", "stable", run_git)["ok"] is False
    assert git(client, "rev-parse", "HEAD") == old


def test_legacy_or_unrelated_checkouts_require_manual_migration(source_install):
    client, _, old, _, _, git, run_git, commands = source_install
    assert releases.apply_web_update(client, "stable", run_git)["manual_update"] is True
    git(client, "remote", "set-url", "origin", "https://github.com/other/project.git")
    assert releases.apply_web_update(client / "web", "stable", run_git)["manual_update"] is True
    assert git(client, "rev-parse", "HEAD") == old
    assert not any(command[0] == "fetch" for command in commands)


def test_public_update_entrypoints_use_safe_monorepo_path(source_install, monkeypatch):
    from api import updates

    client, _, old, new, _, git, run_git, _ = source_install
    restarts = []
    monkeypatch.setattr(updates, "REPO_ROOT", client / "web")
    monkeypatch.setattr(updates, "_run_git", run_git)
    monkeypatch.setattr(updates, "_schedule_restart", lambda: restarts.append(True))
    monkeypatch.setattr(updates, "_restart_blocker_snapshot", lambda: {"restart_blocked": False})
    status = updates._check_repo(client / "web", "webui", "stable")
    assert status["behind"] == 1
    assert status["repo_url"] == releases.REPOSITORY_URL
    assert status["compare_url"].endswith(f"{old}...{new}")
    local = client / "unrelated-app-work.txt"
    local.write_text("preserve this")
    assert updates.apply_force_update("webui", "stable")["ok"] is False
    assert local.read_text() == "preserve this"
    assert restarts == []
    local.unlink()
    result = updates.apply_update("webui", "stable")
    assert result["ok"] is True and result["restart_scheduled"] is True
    assert git(client, "rev-parse", "HEAD") == new
    assert restarts == [True]


def test_web_version_ignores_app_and_relay_tags(source_install, monkeypatch):
    from api import updates

    client, _, _, _, _, git, run_git, _ = source_install
    for tag in ("web-v1.0.0", "app-v99.0.0", "relay-v99.0.0"):
        git(client, "-c", "tag.gpgsign=false", "tag", "-a", tag, "-m", "synthetic tag")
    monkeypatch.setattr(updates, "REPO_ROOT", client / "web")
    monkeypatch.setattr(updates, "_run_git", run_git)
    assert updates._detect_webui_version() == "web-v1.0.0"
    assert updates.channel_version_badge("stable") == "web-v1.0.0"


def test_private_remote_credentials_never_enter_update_status(source_install):
    client, _, _, _, _, git, run_git, _ = source_install
    git(client, "remote", "set-url", "origin", "https://x-access-token:synthetic-secret@github.com/MaudeCode/talaria.git")
    result = releases.check_web_update(client / "web", "web-v1.0.0", "stable", run_git)
    assert result["behind"] == 1
    assert "synthetic-secret" not in json.dumps(result)


def test_packaged_installs_advertise_manual_updates_without_rewinds(source_install, monkeypatch):
    _, _, _, _, _, _, run_git, _ = source_install
    monkeypatch.setattr(releases, "RELEASE_INFO", {"sourceRevision": "c" * 40})
    older = releases.check_web_update(None, "web-v1.0.0", "stable", run_git)
    assert older["behind"] == 1 and older["manual_update"] is True and older["no_git"] is True
    newer = releases.check_web_update(None, "web-exp-v3.0.0", "stable", run_git)
    assert newer["behind"] == 0


def test_web_lock_retry_preserves_git_lock_and_then_updates(source_install, monkeypatch):
    from api import updates

    client, _, old, new, _, git, run_git, _ = source_install
    monkeypatch.setattr(updates, "REPO_ROOT", client / "web")
    monkeypatch.setattr(updates, "_run_git", run_git)
    monkeypatch.setattr(updates, "_schedule_restart", lambda: None)
    monkeypatch.setattr(updates, "_read_update_channel", lambda: "stable")
    monkeypatch.setattr(updates, "_restart_blocker_snapshot", lambda: {"restart_blocked": False})
    lock = client / ".git/index.lock"
    lock.write_text("synthetic active Git operation")
    blocked = updates.apply_clear_lock("webui")
    assert blocked["ok"] is False and blocked["lock_conflict"] is True
    assert lock.read_text() == "synthetic active Git operation"
    assert git(client, "rev-parse", "HEAD") == old
    lock.unlink()  # The fixture owns the lock, exactly as a completed Git process does.
    assert updates.apply_clear_lock("webui")["ok"] is True
    assert git(client, "rev-parse", "HEAD") == new


@pytest.mark.parametrize("existing_stamp", [False, True])
@pytest.mark.parametrize("restarted", [False, True])
def test_retry_repairs_stamp_after_source_advanced_and_schedules_restart(source_install, monkeypatch, existing_stamp, restarted):
    from api import updates

    client, _, old, new, release, git, run_git, _ = source_install
    stamp = client / "web/api/_release.json"
    old_runtime = {"sourceRevision": old, "version": "1.0.0"}
    if existing_stamp:
        stamp.write_text(json.dumps(old_runtime))
    monkeypatch.setattr(releases, "RELEASE_INFO", old_runtime)
    restarts = []
    monkeypatch.setattr(updates, "REPO_ROOT", client / "web")
    monkeypatch.setattr(updates, "_run_git", run_git)
    monkeypatch.setattr(updates, "_schedule_restart", lambda: restarts.append(True))
    monkeypatch.setattr(updates, "_restart_blocker_snapshot", lambda: {"restart_blocked": False})
    with monkeypatch.context() as failure:
        def unwritable(**kwargs):
            raise PermissionError("synthetic unwritable stamp directory")
        failure.setattr(releases.tempfile, "NamedTemporaryFile", unwritable)
        assert releases.apply_web_update(client / "web", "stable", run_git)["ok"] is False
    assert git(client, "rev-parse", "HEAD") == new
    assert (json.loads(stamp.read_text()) if stamp.exists() else None) == (old_runtime if existing_stamp else None)
    if restarted:
        monkeypatch.setattr(releases, "STAMPED_RELEASE_INFO", old_runtime)
        monkeypatch.setattr(releases, "RELEASE_INFO", {"sourceRevision": None, "version": "development"})
    refreshed = updates._check_repo(client / "web", "webui", "stable")
    assert refreshed["behind"] == 0 and refreshed["metadata_repair"] is True
    assert not refreshed.get("manual_update") and not refreshed.get("error")
    repaired = updates.apply_update("webui", "stable")
    assert repaired["ok"] is True and repaired.get("restart_scheduled") is True
    assert json.loads(stamp.read_text()) == release["runtime"]
    assert restarts == [True]
    # A restarted process can now truthfully report current runtime provenance.
    monkeypatch.setattr(releases, "RELEASE_INFO", release["runtime"])
    assert releases.apply_web_update(client / "web", "stable", run_git)["up_to_date"] is True
    refreshed = updates._check_repo(client / "web", "webui", "stable")
    assert refreshed["behind"] == 0 and refreshed["metadata_repair"] is False


def test_current_source_does_not_hide_a_modified_stamp(source_install):
    client, _, _, new, _, git, run_git, _ = source_install
    git(client, "reset", "--hard", new)
    stamp = client / "web/api/_release.json"
    stamp.write_text('{"version":"unreviewed local metadata"}')
    assert releases.apply_web_update(client / "web", "stable", run_git)["ok"] is False
    status = releases.check_web_update(client / "web", "web-v2.0.0", "stable", run_git)
    assert status["behind"] is None and status["manual_update"] is True and status["error"]
    assert stamp.read_text() == '{"version":"unreviewed local metadata"}'


def test_ahead_checkout_is_manual_not_a_successful_update(source_install, monkeypatch):
    client, _, _, new, release, git, run_git, _ = source_install
    git(client, "reset", "--hard", new)
    stamp = client / "web/api/_release.json"
    original = json.dumps(release["runtime"])
    stamp.write_text(original)
    monkeypatch.setattr(releases, "RELEASE_INFO", release["runtime"])
    (client / "web/server.py").write_text("version = 'unpublished local change'\n")
    git(client, "add", ".")
    git(client, "commit", "-m", "synthetic ahead checkout")
    head = git(client, "rev-parse", "HEAD")
    status = releases.check_web_update(client / "web", release["tag"], "stable", run_git)
    assert status["manual_update"] is True and status["behind"] is None
    result = releases.apply_web_update(client / "web", "stable", run_git)
    assert result["ok"] is False and result["manual_update"] is True
    assert not result.get("up_to_date")
    assert git(client, "rev-parse", "HEAD") == head
    assert stamp.read_text() == original
