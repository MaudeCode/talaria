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
    (legacy / ".gitignore").write_text(".env\n")
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
    git(upstream, "add", ".")
    git(upstream, "commit", "-m", "synthetic monorepo import")
    new = git(upstream, "rev-parse", "HEAD")
    git(upstream, "tag", "-a", "web-v2.0.0", "-m", "synthetic published tag")
    pin = json.loads((upstream / "web/api/agent_dependency.json").read_text())
    release = {"tag": "web-v2.0.0", "version": "2.0.0", "sourceRevision": new,
               "runtime": {"tag": "web-v2.0.0", "version": "2.0.0", "sourceRevision": new, "releaseSet": new,
                           "upstreamBase": old, "contracts": {"appWeb": [1], "webRelay": [2]},
                           "compatibleAgent": {**pin["x-talaria"], "image": pin["services"]["hermes-agent"]["image"]}}}
    monkeypatch.setattr(tool, "REPOSITORY_URL", str(upstream).removesuffix(".git"))
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
