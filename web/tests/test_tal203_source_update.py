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


def test_main_tracks_branch_without_release_lookup_and_waits_for_restart(source_install, monkeypatch):
    from api import updates

    client, upstream, old, _, _, git, run_git, commands = source_install
    (upstream / "web/server.py").write_text("version = 'unreleased main'\n")
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "synthetic unreleased main")
    latest = git(upstream, "rev-parse", "HEAD")
    monkeypatch.setattr(releases, "published_web_release", lambda *_: pytest.fail("Main must not query releases"))
    monkeypatch.setattr(releases, "RUNNING_SOURCE_REVISION", old, raising=False)
    monkeypatch.setattr(updates, "REPO_ROOT", client / "web")
    monkeypatch.setattr(updates, "_run_git", run_git)
    monkeypatch.setattr(updates, "_read_update_channel", lambda: "experimental")
    monkeypatch.setattr(updates, "_restart_blocker_snapshot", lambda: {"restart_blocked": False})
    restarts = []
    monkeypatch.setattr(updates, "_schedule_restart", lambda: restarts.append(True))
    status = updates._check_repo(client / "web", "webui", "experimental")
    assert status["channel"] == "experimental" and status["branch"] == "origin/main"
    assert status["latest_sha"] == latest and status["behind"] == 2
    assert status["release_based"] is False
    assert "synthetic unreleased main" in updates._commit_subjects_for_update(status)
    assert updates.apply_update("webui")["restart_scheduled"] is True
    assert git(client, "rev-parse", "HEAD") == latest
    assert (client / "web/server.py").read_text() == "version = 'unreleased main'\n"
    assert not (client / "web/api/_release.json").exists()
    assert updates._check_repo(client / "web", "webui", "experimental")["metadata_repair"] is True
    assert updates.apply_clear_lock("webui")["restart_scheduled"] is True
    monkeypatch.setattr(releases, "RUNNING_SOURCE_REVISION", latest)
    assert updates.apply_update("webui")["up_to_date"] is True
    assert len(restarts) == 2
    assert not any(command[0] == "fetch" and "--tags" in command for command in commands)


@pytest.mark.parametrize("state", ["dirty", "untracked", "diverged", "ahead", "operation", "fetch_failed"])
def test_main_preserves_unsafe_checkout_states(source_install, monkeypatch, state):
    client, _, _, _, _, git, run_git, _ = source_install
    if state == "dirty":
        (client / "web/server.py").write_text("keep edits")
    elif state == "untracked":
        (client / "personal.txt").write_text("keep untracked")
    elif state in ("diverged", "ahead"):
        if state == "ahead":
            git(client, "reset", "--hard", "origin/main")
        (client / "web/server.py").write_text("keep local commit")
        git(client, "add", ".")
        git(client, "commit", "-m", "synthetic local work")
    elif state == "operation":
        (client / ".git/MERGE_HEAD").write_text("a" * 40)
    head = git(client, "rev-parse", "HEAD")
    before = (client / "web/server.py").read_bytes()
    monkeypatch.setattr(releases, "published_web_release", lambda *_: pytest.fail("Main must not query releases"))
    runner = (lambda args, cwd, **kw: ("fetch unavailable", False) if args[0] == "fetch" else run_git(args, cwd, **kw)) if state == "fetch_failed" else run_git
    assert releases.apply_web_update(client / "web", "experimental", runner)["ok"] is False
    assert git(client, "rev-parse", "HEAD") == head
    assert (client / "web/server.py").read_bytes() == before
    if state == "untracked":
        assert (client / "personal.txt").read_text() == "keep untracked"


def test_main_removes_only_its_unchanged_release_stamp(source_install, monkeypatch):
    client, upstream, _, released, release, git, run_git, _ = source_install
    assert releases.apply_web_update(client / "web", "stable", run_git)["ok"]
    stamp = client / "web/api/_release.json"
    monkeypatch.setattr(releases, "STAMPED_RELEASE_INFO", release["runtime"])
    monkeypatch.setattr(releases, "RELEASE_INFO", release["runtime"])
    monkeypatch.setattr(releases, "RUNNING_SOURCE_REVISION", released, raising=False)
    (upstream / "web/server.py").write_text("version = 'next main'\n")
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "synthetic main")
    original = stamp.read_bytes()
    stamp.write_text('{"custom":"preserve"}')
    assert releases.apply_web_update(client / "web", "experimental", run_git)["ok"] is False
    assert git(client, "rev-parse", "HEAD") == released
    assert stamp.read_text() == '{"custom":"preserve"}'
    stamp.write_bytes(original)
    assert releases.apply_web_update(client / "web", "experimental", run_git)["ok"] is True
    assert not stamp.exists()


def test_main_setting_roundtrips_and_keeps_agent_channel_independent(tmp_path, monkeypatch):
    from api import config, updates

    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    assert config.save_settings({"update_channel": "experimental"})["update_channel"] == "experimental"
    assert updates._read_update_channel() == "experimental"
    seen = []
    monkeypatch.setattr(updates, "_update_cache", {"channel": "stable", "checked_at": 0, "include_agent": True})
    def check(path, name, channel):
        seen.append((name, channel))
        return {"name": name, "behind": 0}
    monkeypatch.setattr(updates, "_check_repo", check)
    assert updates.cached_update_status()["stale_channel"] is True
    assert updates.check_for_updates(force=True)["channel"] == "experimental"
    assert seen == [("webui", "experimental"), ("agent", "stable")]
    assert config.save_settings({"update_channel": "invalid"})["update_channel"] == "experimental"


@pytest.mark.parametrize("path", ["app/client.swift", "relay/backend.ts", "README.md", "changelog.d/example.json", ".github/workflows/example.yml"])
def test_main_ignores_unrelated_changes_without_updating_or_restarting(source_install, monkeypatch, path):
    from api import updates

    client, upstream, _, source, _, git, run_git, _ = source_install
    git(client, "reset", "--hard", source)
    changed = upstream / path
    changed.parent.mkdir(parents=True, exist_ok=True)
    changed.write_text("synthetic unrelated change\n")
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "synthetic unrelated update")
    monkeypatch.setattr(releases, "RUNNING_SOURCE_REVISION", source)
    monkeypatch.setattr(releases, "published_web_release", lambda *_: pytest.fail("Main must not query releases"))
    monkeypatch.setattr(updates, "REPO_ROOT", client / "web")
    monkeypatch.setattr(updates, "_run_git", run_git)
    monkeypatch.setattr(updates, "_restart_blocker_snapshot", lambda: {"restart_blocked": False})
    restarts = []
    monkeypatch.setattr(updates, "_schedule_restart", lambda: restarts.append(True))
    status = updates._check_repo(client / "web", "webui", "experimental")
    assert status["behind"] == 0 and not status["metadata_repair"]
    assert updates._commit_subjects_for_update(status) == []
    assert updates.apply_update("webui", "experimental")["up_to_date"] is True
    assert git(client, "rev-parse", "HEAD") == source
    assert restarts == []


def test_main_counts_web_and_contract_changes_and_excludes_unrelated_summary(source_install, monkeypatch):
    from api import updates

    client, upstream, _, source, _, git, run_git, _ = source_install
    git(client, "reset", "--hard", source)
    (upstream / "README.md").write_text("unrelated root documentation")
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "synthetic unrelated update")
    (upstream / "contracts/versions.json").write_text('{"synthetic":"updated"}')
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "synthetic shared contract update")
    latest = git(upstream, "rev-parse", "HEAD")
    monkeypatch.setattr(releases, "RUNNING_SOURCE_REVISION", source)
    monkeypatch.setattr(updates, "REPO_ROOT", client / "web")
    monkeypatch.setattr(updates, "_run_git", run_git)
    status = releases.check_web_update(client / "web", "development", "experimental", run_git)
    assert status["behind"] == 1
    assert updates._commit_subjects_for_update(status) == ["synthetic shared contract update"]
    assert releases.apply_web_update(client / "web", "experimental", run_git)["ok"] is True
    assert git(client, "rev-parse", "HEAD") == latest
    # A later excluded commit cannot hide the pending restart for changed contracts.
    (upstream / "README.md").write_text("next unrelated change")
    git(upstream, "commit", "-am", "synthetic next unrelated update")
    status = releases.check_web_update(client / "web", "development", "experimental", run_git)
    assert status["behind"] == 0 and status["metadata_repair"] is True
    result = releases.apply_web_update(client / "web", "experimental", run_git)
    assert result["ok"] is True and not result.get("up_to_date")
    assert git(client, "rev-parse", "HEAD") == latest
    monkeypatch.setattr(releases, "RUNNING_SOURCE_REVISION", latest)
    assert not releases.check_web_update(client / "web", "development", "experimental", run_git)["metadata_repair"]


def test_main_does_not_offer_reverted_web_changes(source_install, monkeypatch):
    client, upstream, _, source, _, git, run_git, _ = source_install
    git(client, "reset", "--hard", source)
    original = (upstream / "web/server.py").read_bytes()
    (upstream / "web/server.py").write_text("temporary change")
    git(upstream, "commit", "-am", "synthetic temporary change")
    (upstream / "web/server.py").write_bytes(original)
    git(upstream, "commit", "-am", "synthetic revert")
    monkeypatch.setattr(releases, "RUNNING_SOURCE_REVISION", source)
    assert releases.check_web_update(client / "web", "development", "experimental", run_git)["behind"] == 0
    assert releases.apply_web_update(client / "web", "experimental", run_git)["up_to_date"] is True
    assert git(client, "rev-parse", "HEAD") == source


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
    newer = releases.check_web_update(None, "web-v3.0.0", "stable", run_git)
    assert newer["behind"] == 0


@pytest.mark.parametrize("installed,target,channel", [
    ("web-v2.0.0", "web-exp-v1.5.0", "experimental"),
    ("web-exp-v3.0.0", "web-v2.0.0", "stable"),
    ("web-v2.0.0", "web-exp-v2.0.0", "experimental"),
])
@pytest.mark.parametrize("same_source", [False, True])
def test_packaged_channel_switch_is_manual_unknown(source_install, monkeypatch, installed, target, channel, same_source):
    _, _, _, new, release, _, run_git, _ = source_install
    release.update(tag=target, version=target.rsplit("-v", 1)[1])
    monkeypatch.setattr(releases, "RELEASE_INFO", {"sourceRevision": new if same_source else "c" * 40})
    result = releases.check_web_update(None, installed, channel, run_git)
    assert result["behind"] is None
    assert result["manual_update"] is True
    assert result["release_url"] == release["release_url"]


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


def test_summary_cache_separates_filtered_experimental_commits(source_install, monkeypatch):
    from collections import OrderedDict
    from api import updates

    client, upstream, old, _, _, git, run_git, _ = source_install
    (upstream / "app").mkdir()
    (upstream / "app/client.swift").write_text("// unrelated App change\n")
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "synthetic unrelated App update")
    git(client, "fetch", str(upstream), "main")
    latest = git(upstream, "rev-parse", "HEAD")
    monkeypatch.setattr(updates, "REPO_ROOT", client / "web")
    monkeypatch.setattr(updates, "_run_git", run_git)
    monkeypatch.setattr(updates, "_summary_cache", OrderedDict())
    info = {"behind": 1, "current_sha": old, "latest_sha": latest}
    stable = updates.summarize_update_payload({"webui": {**info, "channel": "stable"}})
    experimental_payload = {"webui": {**info, "channel": "experimental"}}
    experimental = updates.summarize_update_payload(experimental_payload)
    assert "synthetic unrelated App update" in stable["summary"]
    assert "synthetic unrelated App update" not in experimental["summary"]
    assert "synthetic published release" in experimental["summary"]
    assert experimental["cached"] is False
    assert updates.summarize_update_payload(experimental_payload)["cached"] is True
