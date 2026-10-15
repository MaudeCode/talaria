"""TAL-792: ``state_db.delete_cli_session`` refuses a session another Agent process is writing — a live turn lease or
compression lock on the session or a delegate child that would go with it — like the Agent's own user delete
(``delete_session(exclude_active_write_guards=True)``). Expired guards are reclaimed and the delete proceeds. Real
sidecar, pinned Agent."""

from __future__ import annotations

import sqlite3
import subprocess
import textwrap
from contextlib import closing

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, SidecarProcess, assert_matches, isolated_env, requires_agent

# Every supported Agent guards: v0.21.6+ through ``_guarded_ids``, older ones through ``_write_guards_reject``.
pytestmark = requires_agent

# An unstructured holder is never probed as a pid, so it stays live until its TTL (another process's turn).
OTHER_PROCESS = "other-terminal-turn"


def _agent(home, body: str) -> None:
    script = "from pathlib import Path\nfrom hermes_state import SessionDB\n" + f"db = SessionDB(db_path=Path({str(home / 'state.db')!r}))\n" + textwrap.dedent(body) + "\ndb.close()\n"
    subprocess.run([AGENT_PYTHON, "-c", script], env=isolated_env(home, PYTHONPATH=str(AGENT_DIR)), check=True, timeout=60)


def _seed(home, session_id: str, *, delegate: str | None = None) -> None:
    _agent(home, f"""
        db.create_session(session_id={session_id!r}, source="cli")
        db.append_message({session_id!r}, "user", "hi")
        if {delegate!r}:
            db.create_session(session_id={delegate!r}, source="subagent", parent_session_id={session_id!r}, model_config={{"_delegate_from": {session_id!r}}})
    """)


def _rows(home, sql: str) -> list:
    with closing(sqlite3.connect(home / "state.db")) as db:
        return [row[0] for row in db.execute(sql).fetchall()]


def _delete(proc: SidecarProcess, home, session_id: str, *, lineage: bool = False) -> dict:
    params = {"profile_home": str(home), "session_id": session_id, **({"include_compression_lineage": True} if lineage else {})}
    result = proc.result("state_db.delete_cli_session", params)
    assert_matches("state_db.delete_cli_session", result)
    return {key: value for key, value in result.items() if key != "deleted_ids"}


def test_a_live_turn_lease_or_compression_lock_refuses_the_delete(hermes_home) -> None:
    _seed(hermes_home, "cli-a")
    _seed(hermes_home, "cli-b")
    _seed(hermes_home, "cli-c", delegate="cli-c-child")
    _agent(hermes_home, f"""
        assert db.try_acquire_session_turn_lease("cli-a", {OTHER_PROCESS!r})
        assert db.try_acquire_compression_lock("cli-b", {OTHER_PROCESS!r})
        assert db.try_acquire_session_turn_lease("cli-c-child", {OTHER_PROCESS!r})
    """)
    proc = SidecarProcess(hermes_home)
    try:
        for sid in ("cli-a", "cli-b", "cli-c"):
            assert _delete(proc, hermes_home, sid) == {"ok": False, "refused": "active_turn"}, sid
    finally:
        proc.close()
    # Nothing was removed: the rows, their transcripts, and the guards the live writer holds all remain.
    assert sorted(_rows(hermes_home, "SELECT id FROM sessions")) == ["cli-a", "cli-b", "cli-c", "cli-c-child"]
    assert sorted(_rows(hermes_home, "SELECT DISTINCT session_id FROM messages")) == ["cli-a", "cli-b", "cli-c"]
    assert sorted(_rows(hermes_home, "SELECT conversation_id FROM session_turn_leases")) == ["cli-a", "cli-c-child"]
    assert _rows(hermes_home, "SELECT session_id FROM compression_locks") == ["cli-b"]


def test_an_expired_guard_is_reclaimed_and_the_delete_proceeds(hermes_home) -> None:
    _seed(hermes_home, "cli-a", delegate="cli-a-child")
    _seed(hermes_home, "cli-b")
    _agent(hermes_home, f"""
        assert db.try_acquire_session_turn_lease("cli-a", {OTHER_PROCESS!r})
        assert db.try_acquire_compression_lock("cli-b", {OTHER_PROCESS!r})
    """)
    with closing(sqlite3.connect(hermes_home / "state.db")) as db, db:
        db.execute("UPDATE session_turn_leases SET expires_at = 1")
        db.execute("UPDATE compression_locks SET expires_at = 1")
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, "cli-a") == {"ok": True}
        assert _delete(proc, hermes_home, "cli-b") == {"ok": True}
    finally:
        proc.close()
    # An unguarded delete keeps its lineage cleanup: the delegate child goes with its parent.
    assert _rows(hermes_home, "SELECT id FROM sessions") == []
    assert _rows(hermes_home, "SELECT conversation_id FROM session_turn_leases") == []
    assert _rows(hermes_home, "SELECT session_id FROM compression_locks") == []


def test_the_lineage_is_resolved_and_guarded_inside_the_delete_transaction(hermes_home) -> None:
    """The sidecar finds the compression continuations itself, in the delete transaction: a tip the caller never
    named (a compression that finished after the caller looked) is guarded and deleted with its root."""
    _seed(hermes_home, "cli-root")
    _agent(hermes_home, f"""
        db.end_session("cli-root", "compression")
        db.create_session(session_id="cli-tip", source="cli", parent_session_id="cli-root")
        db.append_message("cli-tip", "user", "continued")
        assert db.try_acquire_compression_lock("cli-tip", {OTHER_PROCESS!r})
    """)
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, "cli-root", lineage=True) == {"ok": False, "refused": "active_turn"}
        assert sorted(_rows(hermes_home, "SELECT id FROM sessions")) == ["cli-root", "cli-tip"]
        with closing(sqlite3.connect(hermes_home / "state.db")) as db, db:
            db.execute("UPDATE compression_locks SET expires_at = 1")
        assert _delete(proc, hermes_home, "cli-root", lineage=True) == {"ok": True}
    finally:
        proc.close()
    assert _rows(hermes_home, "SELECT id FROM sessions") == []


def test_the_delete_removes_every_segment_of_a_long_compression_lineage(hermes_home) -> None:
    """TAL-893: a session the Agent compressed 29 times loses every segment, not the first 21."""
    _seed(hermes_home, "cli-000")
    _agent(hermes_home, """
        for i in range(1, 30):
            db.end_session(f"cli-{i - 1:03d}", "compression")
            db.create_session(session_id=f"cli-{i:03d}", source="cli", parent_session_id=f"cli-{i - 1:03d}")
            db.append_message(f"cli-{i:03d}", "user", "continued")
    """)
    assert len(_rows(hermes_home, "SELECT id FROM sessions")) == 30
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, "cli-000", lineage=True) == {"ok": True}
    finally:
        proc.close()
    assert _rows(hermes_home, "SELECT id FROM sessions") == []
    assert _rows(hermes_home, "SELECT DISTINCT session_id FROM messages") == []


def test_the_delete_removes_the_legacy_session_transcript(hermes_home) -> None:
    """TAL-892: like the Agent's own delete, the legacy ``session_<id>.json`` snapshot goes with the session, directly and
    through a pending cleanup manifest; another session's snapshot stays."""
    _seed(hermes_home, "cli-a")
    _seed(hermes_home, "cli-b")
    sessions = hermes_home / "sessions"
    sessions.mkdir(exist_ok=True)
    for name in ("session_cli-a.json", "session_cli-ab.json", "session_cli-b.json", "session_cli-gone.json"):
        (sessions / name).write_text("{}", encoding="utf-8")
    # An earlier delete of cli-gone left its artifacts pending.
    (sessions / ".cleanup_manifest_pending.json").write_text('["cli-gone"]', encoding="utf-8")
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, "cli-a") == {"ok": True}
    finally:
        proc.close()
    assert sorted(p.name for p in sessions.iterdir()) == ["session_cli-ab.json", "session_cli-b.json"]


def test_the_legacy_name_of_a_live_prefixed_session_is_its_own_transcript(hermes_home) -> None:
    """``session_<id>.json`` is also the current transcript of a live session whose id is ``session_<id>``: deleting
    ``<id>`` keeps it."""
    _seed(hermes_home, "cli-a")
    _seed(hermes_home, "session_cli-a")
    sessions = hermes_home / "sessions"
    sessions.mkdir(exist_ok=True)
    (sessions / "session_cli-a.json").write_text("{}", encoding="utf-8")
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, "cli-a") == {"ok": True}
    finally:
        proc.close()
    assert sorted(p.name for p in sessions.iterdir()) == ["session_cli-a.json"]


requires_ledger = pytest.mark.skipif(
    AGENT_DIR is None or not (AGENT_DIR / "hermes_state_mutation_retirement.py").exists(),
    reason="Agent predates runtime-ledger retirement",
)


def _settled(home, sid="cli-a") -> None:
    _agent(home, f"""
        import hermes_state_runtime as rt
        epoch = rt.begin_runtime_epoch(db, instance_id="fixture")
        request = dict(epoch=epoch, principal_id="human", session_id={sid!r}, request_id="once", payload={{"text": "private prompt"}})
        admitted = rt.admit_session_input(db, **request)
        claim = rt.claim_session_input(db, epoch=epoch, session_id={sid!r})
        rt.settle_session_input(db, epoch=epoch, admission_id=admitted["admission_id"], generation=claim["generation"],
            outcome="completed", result={{"result": {{"messages": [{{"role": "user", "content": "private prompt"}}], "last_reasoning": "private reasoning", "final_response": "done"}}}})
        db.save_gateway_routing_entry("route:" + {sid!r}, '{{"session_id": "{sid}"}}')
    """)


@requires_ledger
def test_terminal_ledger_retirement_cleans_files_and_fences_retries(hermes_home) -> None:
    _seed(hermes_home, "cli-a")
    _seed(hermes_home, "cli-b")
    _settled(hermes_home)
    sessions = hermes_home / "sessions"
    sessions.mkdir(exist_ok=True)
    for name in ("cli-a.json", "cli-a.jsonl", "session_cli-a.json", "request_dump_cli-a_1.json", "cli-b.json"):
        (sessions / name).write_text("private prompt", encoding="utf-8")
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, "cli-a") == {"ok": True}
        assert _delete(proc, hermes_home, "cli-a") == {"ok": True}
    finally:
        proc.close()
    assert _rows(hermes_home, "SELECT id FROM sessions") == ["cli-b"]
    assert _rows(hermes_home, "SELECT DISTINCT session_id FROM messages") == ["cli-b"]
    assert sorted(p.name for p in sessions.iterdir()) == ["cli-b.json"]
    _agent(hermes_home, """
        import json
        import hermes_state_runtime as rt
        from hermes_state_terminal import RESULT_PREFIX
        from hermes_state_mutation_retirement import retired_session
        epoch = rt.begin_runtime_epoch(db, instance_id="retry")
        assert retired_session(db, "cli-a")
        retry = rt.admit_session_input(db, epoch=epoch, principal_id="human", session_id="cli-a", request_id="once", payload={"text": "private prompt"})
        assert retry["status"] == "terminal" and retry["payload"] == {}
        result = json.loads(db._read_one("SELECT value FROM state_meta WHERE key=?", (RESULT_PREFIX + retry["admission_id"],))[0])["result"]
        assert result["messages"] == [] and "last_reasoning" not in result
        assert result["final_response"] == "done"
        assert db.load_gateway_routing_entries() == {}
        for late in (lambda: db.ensure_session("cli-a", source="cli"),
                     lambda: db.update_token_counts("cli-a", input_tokens=1, output_tokens=1, model="m")):
            try:
                late()
            except rt.RuntimeStoreError as exc:
                assert exc.reason == "not_found"
            else:
                raise AssertionError("deleted session was recreated")
        assert db.get_session("cli-a") is None
        assert not db._read_one("SELECT COUNT(*) FROM session_admissions")[0]
        assert not db._read_one("SELECT COUNT(*) FROM worker_executions")[0]
    """)


@requires_ledger
@pytest.mark.parametrize("state", ["queued", "started", "unknown", "registered_worker", "running_worker", "unknown_worker"])
def test_live_ledger_obligations_refuse_the_entire_delete(hermes_home, state) -> None:
    _seed(hermes_home, "cli-a", delegate="cli-child")
    _agent(hermes_home, f"""
        import hermes_state_runtime as rt
        epoch = rt.begin_runtime_epoch(db, instance_id="fixture")
        state = {state!r}
        if state.endswith("_worker"):
            generation = db.get_session("cli-child")["runtime_generation"]
            rt.register_worker_execution(db, epoch=epoch, execution_id="worker", session_id="cli-child", generation=generation, kind="compute", adoption_secret="test-secret")
            if state != "registered_worker":
                db._execute_write(lambda c: c.execute("UPDATE worker_executions SET status=?", (state.removesuffix("_worker"),)))
        else:
            rt.admit_session_input(db, epoch=epoch, principal_id="human", session_id="cli-child", request_id="live", payload={{"text": "working"}})
            if state != "queued":
                rt.claim_session_input(db, epoch=epoch, session_id="cli-child")
            if state == "unknown":
                rt.begin_runtime_epoch(db, instance_id="restart")
    """)
    sessions = hermes_home / "sessions"
    sessions.mkdir(exist_ok=True)
    (sessions / "session_cli-a.json").write_text("keep", encoding="utf-8")
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, "cli-a", lineage=True) == {"ok": False, "refused": "active_turn"}
    finally:
        proc.close()
    assert sorted(_rows(hermes_home, "SELECT id FROM sessions")) == ["cli-a", "cli-child"]
    assert _rows(hermes_home, "SELECT DISTINCT session_id FROM messages") == ["cli-a"]
    assert sorted(p.name for p in sessions.iterdir()) == ["session_cli-a.json"]


@requires_ledger
@pytest.mark.parametrize("target", ["root", "tip"])
def test_canonical_compression_targets_include_delegates_and_preserve_forks(hermes_home, target) -> None:
    _seed(hermes_home, "root")
    _agent(hermes_home, """
        db.end_session("root", "compression")
        db.create_session("tip", source="cli", parent_session_id="root")
        db.create_session("branch", source="cli", parent_session_id="root", model_config={"_branched_from": "root"})
        db.create_session("reset-fork", source="cli", parent_session_id="root", model_config={"_reset_from": "root"})
        db.create_session("delegate", source="subagent", parent_session_id="tip", model_config={"_delegate_from": "tip"},
            user_id="human", session_key="delegate-route", chat_id="delegate-peer")
        db.append_message("delegate", "user", "delegate")
        db.end_session("delegate", "compression")
        db.create_session("delegate-tip", source="subagent", parent_session_id="delegate",
            user_id="human", session_key="delegate-route", chat_id="delegate-peer")
        for sid in ("tip", "delegate-tip", "branch", "reset-fork"):
            db.append_message(sid, "user", sid)
    """)
    _settled(hermes_home, "delegate-tip")
    other_profile = hermes_home / "profiles" / "other"
    other_profile.mkdir(parents=True)
    _seed(other_profile, "root")
    sessions = hermes_home / "sessions"
    sessions.mkdir(exist_ok=True)
    for sid in ("root", "tip", "delegate", "delegate-tip", "branch", "reset-fork"):
        (sessions / f"session_{sid}.json").write_text(sid, encoding="utf-8")
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, target, lineage=True) == {"ok": True}
    finally:
        proc.close()
    assert sorted(_rows(hermes_home, "SELECT id FROM sessions")) == ["branch", "reset-fork"]
    assert sorted(_rows(hermes_home, "SELECT DISTINCT session_id FROM messages")) == ["branch", "reset-fork"]
    assert sorted(p.name for p in sessions.iterdir()) == ["session_branch.json", "session_reset-fork.json"]
    assert _rows(other_profile, "SELECT id FROM sessions") == ["root"]


@requires_ledger
@pytest.mark.parametrize("tip", [False, True])
def test_receipt_backed_reset_conversation_deletes_from_either_end(hermes_home, tip) -> None:
    _agent(hermes_home, """
        from dataclasses import asdict
        import hermes_state_runtime as rt
        from hermes_state_local import commit_local_session
        from hermes_state_local_lineage import reset_local_target
        from gateway.config import Platform
        from gateway.session import SessionEntry, SessionSource
        from gateway.session_lifecycle import _now
        from gateway.session_local_recovery import local_identity
        from gateway.session_policy import build_policy
        epoch = rt.begin_runtime_epoch(db, instance_id="fixture")
        sid = local_identity("profile", "human", "once")
        source = SessionSource(platform=Platform.LOCAL, chat_id=sid, user_id="human", chat_type="dm")
        now = _now()
        entry = SessionEntry("local:" + sid, sid, now, now, origin=source, platform=Platform.LOCAL)
        policy = build_policy({"source": "cli", "cwd": str(Path(db.db_path).parent), "model": "m", "toolsets": []},
                              {"platform_toolsets": {"cli": []}}, private_secrets={})
        commit_local_session(db, epoch=epoch, receipt={"profile_id": "profile", "principal_id": "human", "request_id": "once",
            "session_id": sid, "route": entry.session_key, "entry": entry.to_dict(), "policy": asdict(policy)})
        db.append_message(sid, "user", "before reset")
        reset = SessionEntry(entry.session_key, "reset-tip", now, now, origin=source, platform=Platform.LOCAL, is_fresh_reset=True)
        reset_local_target(db, epoch=epoch, parent_session_id=sid, entry=reset.to_dict())
        db.append_message("reset-tip", "user", "after reset")
    """)
    ids = sorted(_rows(hermes_home, "SELECT id FROM sessions"))
    target = "reset-tip" if tip else next(sid for sid in ids if sid != "reset-tip")
    sessions = hermes_home / "sessions"
    sessions.mkdir(exist_ok=True)
    for sid in ids:
        (sessions / f"session_{sid}.json").write_text(sid, encoding="utf-8")
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, target, lineage=True) == {"ok": True}
    finally:
        proc.close()
    assert _rows(hermes_home, "SELECT id FROM sessions") == []
    assert list(sessions.iterdir()) == []
    assert _rows(hermes_home, "SELECT session_key FROM gateway_routing") == []
    assert _rows(hermes_home, "SELECT key FROM state_meta WHERE key GLOB 'gateway.local_policy.v1:*'") == []


@requires_ledger
@pytest.mark.parametrize("failure", ["manifest", "artifact", "media"])
def test_runtime_delete_cleanup_failure_recovers_after_restart(hermes_home, failure) -> None:
    _seed(hermes_home, "cli-a")
    _settled(hermes_home)
    sessions = hermes_home / "sessions"
    sessions.mkdir(exist_ok=True)
    artifact = sessions / "session_cli-a.json"
    artifact.write_text("keep until committed", encoding="utf-8")
    _agent(hermes_home, f"""
        import sys
        sys.path.insert(0, {str(SIDECAR_ROOT)!r})
        from talaria_sidecar.methods import state_db
        if {failure!r} == "manifest":
            original = Path.write_text
            def fail_manifest(path, *args, **kwargs):
                if path.name.startswith(".cleanup_manifest_"):
                    raise OSError("injected manifest failure")
                return original(path, *args, **kwargs)
            Path.write_text = fail_manifest
        elif {failure!r} == "artifact":
            state_db._clean_artifacts = lambda *args, **kwargs: False
        else:
            import hermes_state_media
            def fail_media(db):
                raise OSError("injected media failure")
            hermes_state_media.collect_retired_media = fail_media
        result = state_db.delete_cli_session(Path({str(hermes_home)!r}), "cli-a")
        assert result["ok"] is False
        if {failure!r} != "manifest":
            assert result["deleted_ids"] == ["cli-a"]
    """)
    assert artifact.exists()
    assert bool(_rows(hermes_home, "SELECT id FROM sessions")) == (failure == "manifest")
    assert bool(list(sessions.glob(".cleanup_manifest_*.json"))) == (failure in ("artifact", "media"))
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, "cli-a") == {"ok": True}
    finally:
        proc.close()
    assert _rows(hermes_home, "SELECT id FROM sessions") == []
    assert list(sessions.iterdir()) == []


@requires_ledger
def test_terminal_worker_receipts_keep_only_the_closing_result(hermes_home) -> None:
    _seed(hermes_home, "cli-a")
    _agent(hermes_home, """
        import hermes_state_runtime as rt
        epoch = rt.begin_runtime_epoch(db, instance_id="fixture")
        rt.register_worker_execution(db, epoch=epoch, execution_id="worker", session_id="cli-a", generation=0,
            kind="compute", adoption_secret="test-secret")
        history = rt.mutate_worker_execution(db, epoch=epoch, execution_id="worker", session_id="cli-a", generation=0,
            sequence=1, operation="compression.history", payload={"target": "cli-a", "include_ancestors": False,
                "include_inactive": False, "repair_alternation": False, "include_row_ids": False, "include_compacted": False})
        assert history["messages"]
        rt.mutate_worker_execution(db, epoch=epoch, execution_id="worker", session_id="cli-a", generation=0,
            sequence=2, operation="execution.finish", payload={})
    """)
    proc = SidecarProcess(hermes_home)
    try:
        assert _delete(proc, hermes_home, "cli-a") == {"ok": True}
    finally:
        proc.close()
    _agent(hermes_home, """
        import json
        import hermes_state_runtime as rt
        from hermes_state_terminal import terminal_worker_receipt, WORKER_PREFIX
        receipt = json.loads(db._read_one("SELECT value FROM state_meta WHERE key=?", (WORKER_PREFIX + "worker",))[0])
        assert receipt["receipts"][0]["result_json"] is None
        digest = rt.admission_fingerprint(canonical_target="cli-a", payload={"operation": "execution.finish", "payload": {}})
        closing = terminal_worker_receipt(db, execution_id="worker", session_id="cli-a", generation=0, sequence=2,
            adoption_secret="test-secret", payload_digest=digest)
        assert closing == {"status": "terminal"}
        assert db._read_one("SELECT COUNT(*) FROM worker_receipts")[0] == 0
    """)
