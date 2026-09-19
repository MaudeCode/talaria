import queue
import sqlite3
from collections import OrderedDict

from api.agent_sessions import resolve_live_compression_tip


def _build_state_db(path, rows):
    conn = sqlite3.connect(path)
    conn.execute(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT,
            parent_session_id TEXT,
            started_at REAL,
            ended_at REAL,
            end_reason TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            role TEXT,
            content TEXT,
            timestamp REAL
        )
        """
    )
    conn.executemany(
        """
        INSERT INTO sessions (
            id, source, parent_session_id, started_at, ended_at, end_reason
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()
    conn.close()


def test_resolve_live_compression_tip_follows_multihop_same_source_lineage(tmp_path):
    db_path = tmp_path / "state.db"
    _build_state_db(
        db_path,
        [
            ("web-root", "webui", None, 1.0, 2.0, "compression"),
            ("subagent-child", "subagent", "web-root", 1.5, None, None),
            ("web-middle", "webui", "web-root", 2.0, 3.0, "compression"),
            ("web-tip", "webui", "web-middle", 3.0, None, None),
        ],
    )

    assert resolve_live_compression_tip(db_path, "web-root") == "web-tip"
    assert resolve_live_compression_tip(db_path, "web-middle") == "web-tip"
    assert resolve_live_compression_tip(db_path, "web-tip") == "web-tip"


def test_resolve_live_compression_tip_fails_closed_for_two_live_continuations(tmp_path):
    db_path = tmp_path / "state.db"
    _build_state_db(
        db_path,
        [
            ("web-root", "webui", None, 1.0, 2.0, "compression"),
            ("web-tip-a", "webui", "web-root", 2.0, None, None),
            ("web-tip-b", "webui", "web-root", 2.1, None, None),
        ],
    )

    assert resolve_live_compression_tip(db_path, "web-root") == "web-root"


def test_resolve_live_compression_tip_leaves_non_compression_session_stable(tmp_path):
    db_path = tmp_path / "state.db"
    _build_state_db(
        db_path,
        [
            ("web-root", "webui", None, 1.0, None, None),
        ],
    )

    assert resolve_live_compression_tip(db_path, "web-root") == "web-root"


def test_cold_stream_worker_constructs_agent_on_tip_and_promotes_sidecar(tmp_path, monkeypatch):
    import api.config as config
    import api.models as models
    import api.profiles as profiles
    import api.streaming as streaming

    root_sid = "web-root"
    middle_sid = "web-middle"
    tip_sid = "web-tip"
    state_db = tmp_path / "state.db"
    _build_state_db(
        state_db,
        [
            (root_sid, "webui", None, 1.0, 2.0, "compression"),
            (middle_sid, "webui", root_sid, 2.0, 3.0, "compression"),
            (tip_sid, "webui", middle_sid, 3.0, None, None),
        ],
    )

    session_dir = tmp_path / "sessions"
    session_dir.mkdir()
    index_file = session_dir / "_index.json"
    sessions = OrderedDict()
    monkeypatch.setattr(models, "SESSION_DIR", session_dir)
    monkeypatch.setattr(models, "SESSION_INDEX_FILE", index_file)
    monkeypatch.setattr(models, "SESSIONS", sessions, raising=False)
    monkeypatch.setattr(config, "SESSION_DIR", session_dir, raising=False)
    monkeypatch.setattr(config, "SESSION_INDEX_FILE", index_file, raising=False)
    monkeypatch.setattr(config, "SESSIONS", sessions, raising=False)
    monkeypatch.setattr(streaming, "SESSION_DIR", session_dir, raising=False)
    monkeypatch.setattr(streaming, "SESSIONS", sessions, raising=False)
    monkeypatch.setattr(profiles, "get_hermes_home_for_profile", lambda _profile: tmp_path)

    captured = {}

    class FakeAgent:
        def __init__(self, **kwargs):
            captured["constructed_session_id"] = kwargs["session_id"]
            self.session_id = kwargs["session_id"]
            self.context_compressor = None
            self.ephemeral_system_prompt = None
            self.session_prompt_tokens = 0
            self.session_completion_tokens = 0
            self.session_estimated_cost_usd = None
            self.session_cache_read_tokens = 0
            self.session_cache_write_tokens = 0
            self._last_error = None

        def run_conversation(self, **kwargs):
            history = list(kwargs.get("conversation_history") or [])
            return {
                "completed": True,
                "final_response": "Recovered",
                "messages": history + [
                    {"role": "user", "content": kwargs.get("persist_user_message", "")},
                    {"role": "assistant", "content": "Recovered"},
                ],
            }

        def interrupt(self, _message):
            return None

    monkeypatch.setattr(streaming, "_get_ai_agent", lambda: FakeAgent)
    monkeypatch.setattr(
        streaming,
        "resolve_model_provider",
        lambda *args, **kwargs: ("test-model", None, None),
    )
    monkeypatch.setattr(streaming, "get_config", lambda: {})
    monkeypatch.setattr(config, "get_config", lambda: {})
    monkeypatch.setattr(config, "_resolve_cli_toolsets", lambda *args, **kwargs: [])

    for mapping in (
        config.STREAMS,
        config.CANCEL_FLAGS,
        config.AGENT_INSTANCES,
        config.SESSION_AGENT_CACHE,
        streaming.STREAMS,
        streaming.CANCEL_FLAGS,
        streaming.AGENT_INSTANCES,
        streaming.STREAM_PARTIAL_TEXT,
        streaming.STREAM_REASONING_TEXT,
        streaming.STREAM_LIVE_TOOL_CALLS,
    ):
        mapping.clear()

    session = models.Session(
        session_id=root_sid,
        title="Restart recovery",
        workspace=str(tmp_path),
        model="test-model",
        messages=[
            {"role": "user", "content": "Before", "timestamp": 1.0},
            {"role": "assistant", "content": "Before answer", "timestamp": 1.5},
        ],
        context_messages=[
            {"role": "user", "content": "Before", "timestamp": 1.0},
            {"role": "assistant", "content": "Before answer", "timestamp": 1.5},
        ],
    )
    stream_id = "stream-restart-recovery"
    session.active_stream_id = stream_id
    session.pending_user_message = "Continue"
    session.pending_started_at = 4.0
    session.save(touch_updated_at=False)
    models.SESSIONS[root_sid] = session
    config.STREAMS[stream_id] = queue.Queue()

    streaming._run_agent_streaming(
        session_id=root_sid,
        msg_text="Continue",
        model="test-model",
        workspace=str(tmp_path),
        stream_id=stream_id,
        attachments=[],
    )

    assert captured["constructed_session_id"] == tip_sid
    assert session.session_id == tip_sid
    assert models.SESSIONS[tip_sid] is session
    assert root_sid not in models.SESSIONS
    assert models.Session.load(root_sid).pre_compression_snapshot is True
