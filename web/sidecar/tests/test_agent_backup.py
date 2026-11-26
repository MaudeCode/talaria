"""``backup.create`` runs the Agent's own ``hermes backup`` for the root home into a private server directory (TAL-2661)."""

from __future__ import annotations

import fcntl
import io
import os
import sqlite3
import stat
import threading
import types
import zipfile
from pathlib import Path

import pytest

from conftest import SidecarProcess, requires_agent
from talaria_sidecar import SIDECAR_RPC_VERSION
from talaria_sidecar.errors import InvalidParams
from talaria_sidecar.methods import backup


class _Ctx:
    def __init__(self) -> None:
        self.cancel_event = threading.Event()
        self.events: list[tuple[str, dict]] = []

    @property
    def cancelled(self) -> bool:
        return self.cancel_event.is_set()

    def emit(self, event: str, data: dict) -> None:
        self.events.append((event, data))


def _handler():
    """The registered ``backup.create`` handler, as the RPC server calls it."""
    methods = {}
    registry = types.SimpleNamespace(method=lambda name, **_: lambda func: methods.setdefault(name, func))
    backup.register(registry)
    return methods["backup.create"]


@pytest.fixture
def root(tmp_path, monkeypatch) -> Path:
    """A root home the stand-in Agent names ``default``; its profiles name themselves."""
    home = tmp_path / ".hermes"
    (home / "profiles" / "work").mkdir(parents=True)
    monkeypatch.setattr(backup, "_profile_selector", lambda h: "default" if Path(h) == home else Path(h).name)
    monkeypatch.setattr(backup, "_child_env", lambda h, profile, action: {"HERMES_HOME": str(h)})
    monkeypatch.setattr(backup, "_hermes_command", lambda: "hermes")
    return home


@pytest.fixture
def out(tmp_path) -> Path:
    private = tmp_path / "staging"
    private.mkdir(mode=0o700)
    return private / "agent.zip"


def _cli(monkeypatch, stdout: str, code: int, *, archive: bool, stderr: str = "", hang: bool = False) -> list:
    """An in-memory CLI: it writes the archive (when asked) and exits with ``code``, or runs until terminated."""
    seen: list = []

    def popen(cmd, **kwargs):
        seen.append((cmd, kwargs))
        if archive:
            Path(cmd[cmd.index("--output") + 1]).write_bytes(b"PK-archive")
        proc = types.SimpleNamespace(stdout=io.StringIO(stdout), stderr=io.StringIO(stderr), returncode=None if hang else code)
        proc.poll = lambda: proc.returncode
        proc.terminate = lambda: setattr(proc, "returncode", -15)
        proc.kill = lambda: setattr(proc, "returncode", -9)
        proc.wait = lambda **_: proc.returncode
        return proc

    monkeypatch.setattr(backup.subprocess, "Popen", popen)
    return seen


def test_a_complete_backup_reports_the_cli_progress_and_archive_size(root, out, monkeypatch) -> None:
    seen = _cli(monkeypatch, "Scanning ~/.hermes ...\nBacking up 3 files ...\n  2/3 files ...\n\nBackup complete: x.zip\n", 0, archive=True)
    ctx = _Ctx()
    assert _handler()(ctx, {"profile_home": str(root), "scope": "agent_home", "output": str(out)}) == {"status": "completed", "size_bytes": 10, "returncode": 0}
    assert seen[0][0] == ["hermes", "--profile", "default", "backup", "--output", str(out), "--keep", "0"]
    assert seen[0][1]["stdin"] is backup.subprocess.DEVNULL
    assert ctx.events == [("progress", {"phase": "scanning"}), ("progress", {"phase": "archiving", "completed": 0, "total": 3}),
                          ("progress", {"phase": "archiving", "completed": 2, "total": 3})]


@pytest.mark.parametrize(("stdout", "stderr", "code", "archive", "expected"), [
    ("Backing up 3 files ...\n  Archive kept, but 1 file(s) could not be added:\n", "", 1, True, {"status": "incomplete", "size_bytes": 10, "returncode": 1}),
    ("Error: another Hermes backup is already running\n", "", 2, False, {"status": "busy", "reason": "another Hermes backup is already running", "returncode": 2}),
    ("Error: Hermes home directory not found at /x\n", "", 1, False, {"status": "failed", "reason": "Hermes home directory not found at /x", "returncode": 1}),
    ("", "Traceback (most recent call last):\nConfigBackendUnavailable: no config file\n", 1, False, {"status": "failed", "reason": "ConfigBackendUnavailable: no config file", "returncode": 1}),
    ("No files to back up.\n", "", 0, False, {"status": "failed", "reason": "The Agent found no files to back up.", "returncode": 0}),
], ids=["incomplete", "busy", "refused", "crashed", "empty"])
def test_each_cli_outcome_maps_to_one_status(root, out, monkeypatch, stdout, stderr, code, archive, expected) -> None:
    _cli(monkeypatch, stdout, code, archive=archive, stderr=stderr)
    assert backup.create(root, out, _Ctx()) == expected


def test_cancellation_terminates_the_cli(root, out, monkeypatch) -> None:
    _cli(monkeypatch, "Scanning ...\n", 0, archive=False, hang=True)
    ctx = _Ctx()
    ctx.cancel_event.set()
    assert backup.create(root, out, ctx) == {"status": "cancelled"}


@pytest.mark.parametrize("params", [
    {"profile_home": "{root}/profiles/work", "scope": "agent_home", "output": "{out}"},
    {"profile_home": "{root}", "output": "{out}"},
    {"profile_home": "{root}", "scope": "agent_home", "output": "relative.zip"},
    {"profile_home": "{root}", "scope": "agent_home", "output": "{open}/agent.zip"},
    {"profile_home": "{root}", "scope": "agent_home", "output": "{out}.tar"},
], ids=["named-profile", "no-scope", "relative", "shared-directory", "not-zip"])
def test_a_request_outside_the_root_home_or_a_private_directory_is_refused(root, out, tmp_path, monkeypatch, params) -> None:
    seen = _cli(monkeypatch, "", 0, archive=False)
    shared = tmp_path / "shared"
    shared.mkdir(mode=0o755)
    shared.chmod(0o755)
    params = {k: v.format(root=root, out=out, open=shared) for k, v in params.items()}
    with pytest.raises(InvalidParams):
        _handler()(_Ctx(), params)
    assert seen == []


def _synthetic_root(home: Path) -> None:
    (home / "config.yaml").write_text("model:\n  default: test/model\n")
    (home / ".env").write_text("OPENROUTER_API_KEY=root-secret\n")
    with sqlite3.connect(home / "state.db") as db:
        db.execute("create table marker (value text)")
        db.execute("insert into marker values ('root-state')")
    work = home / "profiles" / "work"
    (work / "memories").mkdir(parents=True)
    (work / "config.yaml").write_text("model: {}\n")
    (work / "memories" / "MEMORY.md").write_text("work memory\n")


def _private_output(home: Path) -> Path:
    """Where the Web server stages it by default: a 0700 directory under its state directory inside the Agent home."""
    staging = home / "webui" / "agent-backups" / ("a" * 32)
    staging.mkdir(parents=True)
    for path in (staging, staging.parent):
        path.chmod(0o700)
    return staging / "hermes-agent-home.zip"


@requires_agent
def test_native_backup_archives_every_profile_into_a_private_file(hermes_home, tmp_path) -> None:
    _synthetic_root(hermes_home)
    out = _private_output(hermes_home)
    proc = SidecarProcess(hermes_home)
    try:
        assert proc.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})["compatible"]
        message, frames = proc.call("backup.create", {"profile_home": str(hermes_home), "scope": "agent_home", "output": str(out)}, timeout=120)
    finally:
        proc.close()
    assert message["result"]["status"] == "completed", (message, proc.stderr_lines[-20:])
    assert message["result"]["size_bytes"] == out.stat().st_size
    phases = [frame["data"]["phase"] for frame in frames if frame["event"] == "progress"]
    assert phases[0] == "scanning" and "archiving" in phases
    assert stat.S_IMODE(out.stat().st_mode) == 0o600
    assert stat.S_IMODE(out.parent.stat().st_mode) == 0o700
    assert sorted(os.listdir(out.parent)) == [out.name], "staging left beside the archive"
    with zipfile.ZipFile(out) as archive:
        names = set(archive.namelist())
        assert {"config.yaml", ".env", "state.db", "profiles/work/config.yaml", "profiles/work/memories/MEMORY.md"} <= names, names
        assert not any(name.startswith("webui/agent-backups/") for name in names), names
        snapshot = tmp_path / "state.db"
        snapshot.write_bytes(archive.read("state.db"))
    with sqlite3.connect(snapshot) as db:
        assert db.execute("select value from marker").fetchall() == [("root-state",)]
    assert "root-secret" not in repr(frames)


@requires_agent
def test_a_held_native_backup_lock_reports_busy(hermes_home) -> None:
    _synthetic_root(hermes_home)
    out = _private_output(hermes_home)
    proc = SidecarProcess(hermes_home)
    with (hermes_home / ".backup.lock").open("a+b") as held:
        fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            assert proc.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})["compatible"]
            result = proc.result("backup.create", {"profile_home": str(hermes_home), "scope": "agent_home", "output": str(out)}, timeout=120)
        finally:
            proc.close()
    assert result["status"] == "busy", result
    assert not out.exists()


def test_restore_fence_seals_only_after_the_last_worker_handle_closes(tmp_path) -> None:
    with backup.backup_restore.worker_fence(tmp_path) as launcher:
        worker_fd = os.dup(launcher.fileno())
    try:
        assert not backup.backup_restore.seal_worker(tmp_path)
    finally:
        os.close(worker_fd)
    assert backup.backup_restore.seal_worker(tmp_path)
    with backup.backup_restore.worker_fence(tmp_path) as delayed:
        assert delayed.read() == b"sealed"


def test_restore_reports_unavailable_without_the_native_contract(root, monkeypatch) -> None:
    def missing():
        raise ImportError("Agent restore helper unavailable")

    monkeypatch.setattr(backup.backup_restore, "_native", missing)
    methods = {}
    registry = types.SimpleNamespace(method=lambda name, **_: lambda func: methods.setdefault(name, func))
    backup.register(registry)
    assert methods["backup.restore"](_Ctx(), {"profile_home": str(root), "scope": "agent_home"}) == {"status": "unavailable"}


@requires_agent
def test_native_restore_recovers_config_and_sessions_with_a_private_undo_archive(hermes_home) -> None:
    _synthetic_root(hermes_home)
    web_state = hermes_home / "webui"
    folder = web_state / ".cache" / "agent-restores" / "one"
    folder.mkdir(parents=True, mode=0o700)
    incoming = folder / "incoming.zip"
    recovery = folder / "recovery.zip"
    proc = SidecarProcess(hermes_home)
    params = {"profile_home": str(hermes_home), "scope": "agent_home"}
    try:
        message, _ = proc.call("backup.create", {**params, "output": str(incoming)}, timeout=120)
        assert message["result"]["status"] == "completed", message
        (hermes_home / "config.yaml").write_text("model:\n  default: before/restore\n")
        with sqlite3.connect(hermes_home / "state.db") as db:
            db.execute("update marker set value = 'before-restore'")
        message, _ = proc.call("backup.restore", {
            **params, "input": str(incoming), "output": str(recovery), "state_dir": str(web_state),
        }, timeout=120)
        assert message.get("result", {}).get("status") == "restored", message
    finally:
        proc.close()

    assert (hermes_home / "config.yaml").read_text() == "model:\n  default: test/model\n"
    with sqlite3.connect(hermes_home / "state.db") as db:
        assert db.execute("select value from marker").fetchall() == [("root-state",)]
    assert stat.S_IMODE(recovery.stat().st_mode) == 0o600
    with zipfile.ZipFile(recovery) as archive:
        assert archive.read("config.yaml") == b"model:\n  default: before/restore\n"
        assert not any("agent-restores" in name for name in archive.namelist())
    assert sorted(os.listdir(folder)) == [incoming.name, recovery.name, "result.json", "worker.lock"]


@requires_agent
@pytest.mark.parametrize("invalid", ["corrupt", "outside-destination", "active-agent"])
def test_native_restore_refuses_before_live_files_change(hermes_home, tmp_path, invalid) -> None:
    _synthetic_root(hermes_home)
    state = hermes_home / "webui"
    folder = state / ".cache" / "agent-restores" / "one"
    folder.mkdir(parents=True, mode=0o700)
    incoming, recovery = folder / "incoming.zip", folder / "recovery.zip"
    config = hermes_home / "config.yaml"
    original = config.read_bytes()
    outside = tmp_path / "outside.txt"
    outside.write_bytes(original)
    if invalid == "corrupt":
        incoming.write_bytes(b"invalid zip")
    else:
        with zipfile.ZipFile(incoming, "w") as archive:
            archive.writestr("config.yaml", "model: {}\n")
    lock = None
    if invalid == "outside-destination":
        config.unlink()
        config.symlink_to(outside)
    elif invalid == "active-agent":
        lock = (hermes_home / "gateway.lock").open("w")
        fcntl.flock(lock, fcntl.LOCK_EX)
    proc = SidecarProcess(hermes_home)
    try:
        reply, _ = proc.call("backup.restore", {"scope": "agent_home", "profile_home": str(hermes_home),
                                              "input": str(incoming), "output": str(recovery), "state_dir": str(state)})
        expected = {"corrupt": "invalid_archive", "outside-destination": "refused", "active-agent": "busy"}[invalid]
        assert reply.get("result", {}).get("status") == expected, reply
    finally:
        proc.close()
        if lock:
            lock.close()
    assert config.read_bytes() == outside.read_bytes() == original
    assert not recovery.exists()
