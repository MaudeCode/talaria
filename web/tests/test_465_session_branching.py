"""Tests for issue #465 — session branching (/branch).

Verifies:
  1. Backend endpoint POST /api/session/branch exists in routes.py
  2. Session model supports parent_session_id field
  3. Frontend /branch slash command is registered
  4. forkFromMessage function exists in commands.js
  5. Fork button (git-branch icon) is rendered in ui.js message actions
  6. Parent session indicator uses a subtle git-branch icon in sessions.js sidebar
  7. i18n keys exist for all branch-related strings
  8. git-branch icon exists in icons.js
"""
import json
import io
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import api.routes as routes
import pytest


ROOT = Path(__file__).resolve().parents[1]
COMMANDS_JS = ROOT / "static" / "commands.js"
SESSIONS_JS = ROOT / "static" / "sessions.js"
NODE = shutil.which("node")


def _read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def _extract_async_function(source: str, name: str) -> str:
    start = source.find(f"async function {name}(")
    assert start != -1, f"Could not find async function {name}"
    brace = source.find("{", start)
    assert brace != -1, f"Could not find opening brace for {name}"
    depth = 0
    for idx in range(brace, len(source)):
        ch = source[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return source[start:idx + 1]
    pytest.fail(f"Could not extract complete function body for {name}")


def _extract_function(source: str, name: str) -> str:
    start = source.find(f"function {name}(")
    assert start != -1, f"Could not find function {name}"
    brace = source.find("{", start)
    assert brace != -1, f"Could not find opening brace for {name}"
    depth = 0
    for idx in range(brace, len(source)):
        ch = source[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return source[start:idx + 1]
    pytest.fail(f"Could not extract complete function body for {name}")


def _run_node(script: str) -> str:
    if NODE is None:
        pytest.skip("node not on PATH")
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as handle:
        handle.write(script)
        script_path = handle.name
    try:
        proc = subprocess.run(
            [NODE, script_path],
            check=True,
            capture_output=True,
            text=True,
        )
        return proc.stdout.strip()
    finally:
        Path(script_path).unlink(missing_ok=True)


def _commands_harness(body: str) -> str:
    source = COMMANDS_JS.read_text(encoding="utf-8")
    session_source = SESSIONS_JS.read_text(encoding="utf-8")
    cmd_branch = _extract_async_function(source, "cmdBranch")
    fork_from = _extract_async_function(source, "forkFromMessage")
    is_read_only = _extract_function(session_source, "_isReadOnlySession")
    is_branchable_read_only = _extract_function(session_source, "_isBranchableReadOnlySession")
    return _run_node(
        "\n".join([
            "const calls = [];",
            "const toasts = [];",
            "let ensureCalls = 0;",
            "let loadedSessions = [];",
            "let renderCalls = 0;",
            "let apiBeforeResolve = null;",
            "let _oldestIdx = 0;",
            "let _loadingSessionId = null;",
            "let _loadSessionGeneration = 0;",
            "let S = { session: null, busy: false };",
            "const t = (key) => ({",
            "  no_active_session: 'No active session',",
            "  branch_forked: 'Forked into new session',",
            "  branch_failed: 'Fork failed: ',",
            "}[key] || key);",
            "const showToast = (...args) => { toasts.push(args); };",
            "const api = async (url, opts) => {",
            "  calls.push({ url, body: JSON.parse(opts.body) });",
            "  if (apiBeforeResolve) await apiBeforeResolve(url);",
            "  return { session_id: 'forked-session' };",
            "};",
            "const loadSession = async (sid) => { loadedSessions.push(sid); _loadingSessionId=sid; _loadSessionGeneration++; S.session={session_id:sid}; _loadingSessionId=null; };",
            "const renderSessionList = async () => { renderCalls += 1; };",
            "const _ensureAllMessagesLoaded = async () => { ensureCalls += 1; };",
            "const createCommandOwnerContext = () => { const session=S.session; const sid=session&&session.session_id||null; return {sid,session,isCurrent:()=>!!(S.session&&S.session.session_id===sid&&!(_loadingSessionId&&_loadingSessionId!==sid))}; };",
            "const commandOwnerCurrent = (ctx) => !!(ctx&&ctx.isCurrent());",
            "const commandSessionChanged = () => ({sessionChanged:true});",
            is_read_only,
            is_branchable_read_only,
            cmd_branch,
            fork_from,
            "(async () => {",
            body,
            "})().catch((err) => {",
            "  console.error(err && err.stack ? err.stack : String(err));",
            "  process.exit(1);",
            "});",
        ])
    )


# ── Backend ────────────────────────────────────────────────────────────────────


class _FakeHandler:
    def __init__(self):
        self.status = None
        self.headers = {"Content-Type": "application/json", "Content-Length": "1"}
        self.rfile = io.BytesIO(b"")
        self.wfile = io.BytesIO()
        self.command = "POST"
        self.path = "/api/session/branch"
        self.client_address = ("127.0.0.1", 12345)

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.headers[key] = value

    def end_headers(self):
        pass


def _capture_route(monkeypatch):
    cap = {}

    def _bad(_handler, msg, code=400):
        cap["bad"] = (msg, code)
        return True

    def _j(_handler, obj, *_, **kwargs):
        cap["ok"] = obj
        cap["status"] = kwargs.get("status", 200)
        return True

    monkeypatch.setattr(routes, "bad", _bad)
    monkeypatch.setattr(routes, "j", _j)
    return cap

def test_branch_endpoint_exists():
    """Verify the POST /api/session/branch route handler exists."""
    src = _read('api/routes.py')
    assert '"POST /api/session/branch"' in src or '"/api/session/branch"' in src, \
        "Missing /api/session/branch route"


def test_branch_endpoint_validates_session_id():
    """Verify the branch endpoint requires session_id."""
    src = _read('api/routes.py')
    # Find the branch block
    branch_match = re.search(
        r'parsed\.path == "/api/session/branch"(.*?)(?=\n    if parsed\.path|$)',
        src, re.DOTALL
    )
    assert branch_match, "Could not find /api/session/branch handler block"
    block = branch_match.group(1)
    assert 'require(body, "session_id")' in block, \
        "Branch handler should validate session_id"


def test_branch_endpoint_consults_foreign_session_guard_on_missing_sidecar():
    """Missing sidecars should classify foreign read-only sessions before 404ing.

    The classification logic was extracted from the inline handler into the
    ``_load_branch_source_or_refuse`` helper (#5449). Assert the handler
    delegates to it, and that the helper carries the real not_claimable→403
    provenance logic — not a stale inline copy.
    """
    src = _read('api/routes.py')
    branch_match = re.search(
        r'parsed\.path == "/api/session/branch"(.*?)(?=\n    if parsed\.path|$)',
        src, re.DOTALL
    )
    assert branch_match, "Could not find /api/session/branch handler block"
    block = branch_match.group(1)
    assert '_load_branch_source_or_refuse(handler, body["session_id"])' in block, \
        "Branch handler should delegate source-load/refusal to the shared helper"

    # The helper itself must carry the foreign-session classification and pass
    # read-only cron-like sources to the branch builder without saving them.
    helper_match = re.search(
        r'def _load_branch_source_or_refuse\(.*?\)(.*?)(?=\ndef )',
        src, re.DOTALL
    )
    assert helper_match, "Could not find _load_branch_source_or_refuse helper"
    helper = helper_match.group(1)
    assert '_claim_or_synthesize_cli_session(sid)' in helper, \
        "Helper should classify missing-sidecar foreign sessions before returning"
    assert 'if _reason == "not_claimable":' in helper, \
        "Helper should branch on not_claimable foreign ownership"
    assert '_source_kind == "cron"' in helper, \
        "Helper should narrow read-only branch sources to resolved cron source metadata"
    assert 'is_cron_session(' not in helper, \
        "Helper should not use the cron_ session-id prefix as a branch permission gate"
    assert '_foreign_session._branch_source_readonly = True' in helper, \
        "Helper should mark synthesized read-only sources so branch does not save them"
    assert 'return _foreign_session' in helper, \
        "Helper should return synthesized read-only sources to the branch builder"
    assert 'bad(handler, "Read-only sessions cannot be branched from WebUI", 403)' in helper, \
        "Helper should keep non-cron not_claimable sources refused"


def test_branch_helper_gates_persisted_read_only_sources_too():
    """A PERSISTED (stored) read-only session must hit the same branch gate as a
    synthesized foreign one — not slip through `get_session(sid)` (#5555 gate fix).

    Codex found that a stored `read_only=True, source_tag="messaging"` session could
    be branched (200) and its source .save()d because the read-only check only lived
    on the missing-sidecar (except KeyError) path. The loaded-session path must:
    only allow a canonical-cron read-only source, mark it read-only-for-branch, and
    403 every other read-only source.
    """
    src = _read('api/routes.py')
    helper_match = re.search(
        r'def _load_branch_source_or_refuse\(.*?\)(.*?)(?=\ndef )',
        src, re.DOTALL
    )
    assert helper_match, "Could not find _load_branch_source_or_refuse helper"
    helper = helper_match.group(1)
    # The loaded (non-KeyError) path assigns the session to a local, not a bare return.
    assert 'source = get_session(sid)' in helper, \
        "Loaded session must be captured so it can be gated (not returned unconditionally)"
    # The loaded path applies the read-only gate.
    assert 'getattr(source, "read_only", False)' in helper, \
        "Loaded read-only sessions must be gated for branching"
    # Only canonical cron read-only sources pass, marked so the fork won't save them.
    assert 'source._branch_source_readonly = True' in helper, \
        "Loaded read-only cron sources must be marked read-only-for-branch"
    # Verify the read-only gate + 403 come BEFORE the final unconditional return.
    ro_idx = helper.index('getattr(source, "read_only", False)')
    final_return_idx = helper.rindex('return source')
    assert ro_idx < final_return_idx, \
        "The read-only gate must run before the loaded session is returned"
    # The 403 refusal exists on the loaded path (two occurrences now: synth + loaded).
    assert helper.count('bad(handler, "Read-only sessions cannot be branched from WebUI", 403)') >= 2, \
        "Both the synthesized and persisted read-only non-cron paths must 403"


def test_branch_endpoint_returns_new_session_id():
    """Verify the branch endpoint returns session_id and title."""
    src = _read('api/routes.py')
    branch_match = re.search(
        r'parsed\.path == "/api/session/branch"(.*?)(?=\n    if parsed\.path|$)',
        src, re.DOTALL
    )
    assert branch_match
    block = branch_match.group(1)
    assert '"session_id"' in block, "Branch handler should return session_id"
    assert '"title"' in block, "Branch handler should return title"
    assert '"parent_session_id"' in block, \
        "Branch handler should return parent_session_id"


def test_branch_creates_session_with_parent():
    """Verify the branch creates a Session with parent_session_id set."""
    src = _read('api/routes.py')
    branch_match = re.search(
        r'parsed\.path == "/api/session/branch"(.*?)(?=\n    if parsed\.path|$)',
        src, re.DOTALL
    )
    assert branch_match
    block = branch_match.group(1)
    assert 'parent_session_id=source.session_id' in block, \
        "Branch handler should set parent_session_id to source session"


def test_branch_marks_explicit_forks_as_fork_sessions():
    """Explicit branches must not be mistaken for compression lineage rows."""
    src = _read('api/routes.py')
    branch_match = re.search(
        r'parsed\.path == "/api/session/branch"(.*?)(?=\n    if parsed\.path|$)',
        src, re.DOTALL
    )
    assert branch_match
    block = branch_match.group(1)
    assert 'session_source="fork"' in block, \
        "Branch handler should mark explicit forks with session_source='fork'"


def test_branch_keep_count_support():
    """Verify the branch endpoint supports keep_count parameter."""
    src = _read('api/routes.py')
    branch_match = re.search(
        r'parsed\.path == "/api/session/branch"(.*?)(?=\n    if parsed\.path|$)',
        src, re.DOTALL
    )
    assert branch_match
    block = branch_match.group(1)
    assert 'keep_count' in block, "Branch handler should support keep_count"
    assert 'forked_messages = source_messages[:keep_count]' in block, \
        "Branch handler should slice messages by keep_count"


def test_branch_auto_title():
    """Verify fork title defaults to '<original> (fork)'."""
    src = _read('api/routes.py')
    branch_match = re.search(
        r'parsed\.path == "/api/session/branch"(.*?)(?=\n    if parsed\.path|$)',
        src, re.DOTALL
    )
    assert branch_match
    block = branch_match.group(1)
    assert '(fork)' in block, "Branch handler should auto-title as '(fork)'"


def test_branch_route_allows_not_claimable_cron_sessions_to_fork(monkeypatch):
    """Direct or stale branch POSTs for read-only cron sessions should create a fork."""
    handler = _FakeHandler()
    monkeypatch.setattr(routes, "_check_csrf", lambda _handler: True)
    monkeypatch.setattr(routes, "read_body", lambda _handler: {"session_id": "cron-1"})
    monkeypatch.setattr(
        routes,
        "get_session",
        lambda _sid, metadata_only=False: (_ for _ in ()).throw(KeyError("Session not found")),
    )
    source = routes.Session(
        session_id="cron-1",
        title="Cron Run",
        workspace=".",
        model="claude-sonnet",
        messages=[{"role": "user", "content": "summarize"}],
        source_tag="cron",
        raw_source="cron",
        session_source="other",
    )
    monkeypatch.setattr(routes, "_claim_or_synthesize_cli_session", lambda _sid: (source, "not_claimable"))
    cap = _capture_route(monkeypatch)
    routes.handle_post(handler, urlparse("/api/session/branch"))
    assert "bad" not in cap
    assert cap["status"] == 200
    assert cap["ok"]["title"] == "Cron Run (fork)"
    assert cap["ok"]["parent_session_id"] == "cron-1"
    assert cap["ok"]["session_id"] in routes.SESSIONS


def test_branch_route_keeps_404_for_truly_missing_sessions(monkeypatch):
    """Only real foreign read-only sessions should switch from 404 to 400."""
    handler = _FakeHandler()
    monkeypatch.setattr(routes, "_check_csrf", lambda _handler: True)
    monkeypatch.setattr(routes, "read_body", lambda _handler: {"session_id": "ghost-1"})
    monkeypatch.setattr(
        routes,
        "get_session",
        lambda _sid, metadata_only=False: (_ for _ in ()).throw(KeyError("Session not found")),
    )
    monkeypatch.setattr(
        routes,
        "_claim_or_synthesize_cli_session",
        lambda _sid: (None, "no_foreign_state"),
    )
    cap = _capture_route(monkeypatch)
    routes.handle_post(handler, urlparse("/api/session/branch"))
    assert cap["bad"] == ("Session not found", 404)


def test_branch_route_slices_merged_display_view_not_raw_sidecar(monkeypatch):
    """keep_count is an index into GET /api/session's merged display view.

    Compression-lineage stitching and the state.db append-only merge can make
    the display view diverge from the raw sidecar in BOTH length and content.
    The branch handler must slice the same merged view the frontend indexed
    into; slicing the raw sidecar landed the cut rows too early, so forks from
    the final conclusion stopped mid tool-run and dropped that conclusion.
    """
    handler = _FakeHandler()
    conclusion = {
        "role": "assistant",
        "content": "# CONCLUSION\n---\n> 🟢 final answer",
        "timestamp": 6.0,
    }
    # Raw sidecar: 6 rows (a replayed/duplicated tool-run segment survived a
    # compression continuation). The merged display view deduplicates one of
    # those rows, so the frontend sees 5 rows ending on the conclusion.
    raw_sidecar = [
        {"role": "user", "content": "question", "timestamp": 1.0},
        {"role": "assistant", "content": "checking", "tool_calls": [{"id": "t1", "name": "terminal", "arguments": {}}], "timestamp": 2.0},
        {"role": "tool", "tool_call_id": "t1", "content": '{"output":"ok"}', "timestamp": 3.0},
        {"role": "assistant", "content": "still checking", "tool_calls": [{"id": "t2", "name": "terminal", "arguments": {}}], "timestamp": 4.0},
        {"role": "tool", "tool_call_id": "t2", "content": '{"output":"ok2"}', "timestamp": 5.0},
        conclusion,
    ]
    merged_view = [
        raw_sidecar[0],
        raw_sidecar[1],
        raw_sidecar[2],
        raw_sidecar[3],
        conclusion,
    ]
    # Frontend clicked fork on the conclusion: index 4 in the merged view.
    keep_count = len(merged_view)

    source = routes.Session(
        session_id="src-merged-1",
        title="Merged source",
        workspace=".",
        model="claude-sonnet",
        messages=list(raw_sidecar),
        context_messages=[],
    )
    monkeypatch.setattr(routes, "_check_csrf", lambda _handler: True)
    monkeypatch.setattr(
        routes,
        "read_body",
        lambda _handler: {"session_id": "src-merged-1", "keep_count": keep_count},
    )
    monkeypatch.setattr(routes, "get_session", lambda _sid, metadata_only=False: source)
    monkeypatch.setattr(routes, "_session_requires_cli_metadata_lookup", lambda _s: False)
    monkeypatch.setattr(routes, "_is_messaging_session_record", lambda _s: False)
    monkeypatch.setattr(
        routes,
        "_webui_sidecar_lineage_messages_for_display",
        lambda _s: list(raw_sidecar),
    )
    monkeypatch.setattr(routes, "get_state_db_session_messages", lambda *a, **k: [])
    monkeypatch.setattr(
        routes,
        "merge_session_messages_append_only",
        lambda side, state, **k: list(merged_view),
    )
    monkeypatch.setattr(
        routes,
        "_merged_webui_lineage_messages_for_display",
        lambda _s, messages=None: list(messages if messages is not None else []),
    )
    monkeypatch.setattr(routes, "_evict_sessions_over_cap", lambda: None)
    monkeypatch.setattr(routes, "publish_session_list_changed", lambda *a, **k: None)
    monkeypatch.setattr(routes.Session, "save", lambda self: None)
    cap = _capture_route(monkeypatch)
    routes.handle_post(handler, urlparse("/api/session/branch"))
    assert "bad" not in cap
    assert cap["status"] == 200
    forked = routes.SESSIONS[cap["ok"]["session_id"]]
    assert len(forked.messages) == keep_count
    assert forked.messages[-1]["role"] == "assistant"
    assert forked.messages[-1]["content"].startswith("# CONCLUSION"), (
        "Fork sliced the raw sidecar instead of the merged display view: "
        "the final conclusion is missing and the transcript ends mid tool-run"
    )
    routes.SESSIONS.pop(cap["ok"]["session_id"], None)


def test_branch_route_uses_get_display_backstop_for_large_state_db(monkeypatch):
    """Branch coordinates must use GET's bounded state.db display reader."""
    source = routes.Session(session_id="src-large", workspace=".", messages=[])
    seen = {}
    monkeypatch.setattr(routes, "_check_csrf", lambda _handler: True)
    monkeypatch.setattr(routes, "read_body", lambda _handler: {"session_id": source.session_id})
    monkeypatch.setattr(routes, "get_session", lambda *_a, **_k: source)
    monkeypatch.setattr(routes, "_session_requires_cli_metadata_lookup", lambda _s: False)
    monkeypatch.setattr(routes, "_is_messaging_session_record", lambda _s: False)
    monkeypatch.setattr(routes, "_webui_sidecar_lineage_messages_for_display", lambda _s: [])
    monkeypatch.setattr(routes, "_state_db_backstop_limit_for_display", lambda _s, before: 50000)
    def _state_rows(*_a, **kwargs):
        seen.update(kwargs)
        return [{"role": "assistant", "content": "displayed conclusion"}]
    monkeypatch.setattr(routes, "get_state_db_session_messages", _state_rows)
    monkeypatch.setattr(routes, "merge_session_messages_append_only", lambda _side, state, **_k: state)
    monkeypatch.setattr(routes, "_merged_webui_lineage_messages_for_display", lambda _s, messages: messages)
    monkeypatch.setattr(routes, "_evict_sessions_over_cap", lambda: None)
    monkeypatch.setattr(routes, "publish_session_list_changed", lambda *_a, **_k: None)
    monkeypatch.setattr(routes.Session, "save", lambda self: None)
    cap = _capture_route(monkeypatch)
    routes.handle_post(_FakeHandler(), urlparse("/api/session/branch"))
    assert cap["status"] == 200
    assert seen["limit"] == 50000
    routes.SESSIONS.pop(cap["ok"]["session_id"], None)


def test_branch_route_messaging_empty_cli_does_not_copy_hidden_state_db(monkeypatch):
    """Messaging-empty forks must not include state.db rows GET never displayed."""
    conclusion = {"role": "assistant", "content": "displayed conclusion"}
    source = routes.Session(session_id="src-msg-empty", workspace=".", messages=[conclusion])
    monkeypatch.setattr(routes, "_check_csrf", lambda _handler: True)
    monkeypatch.setattr(routes, "read_body", lambda _handler: {"session_id": source.session_id, "keep_count": 1})
    monkeypatch.setattr(routes, "get_session", lambda *_a, **_k: source)
    monkeypatch.setattr(routes, "_session_requires_cli_metadata_lookup", lambda _s: False)
    monkeypatch.setattr(routes, "_is_messaging_session_record", lambda _s: True)
    monkeypatch.setattr(routes, "get_cli_session_messages", lambda _sid: [])
    monkeypatch.setattr(routes, "_webui_sidecar_lineage_messages_for_display", lambda _s: [conclusion])
    monkeypatch.setattr(routes, "get_state_db_session_messages", lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("hidden state.db read")))
    monkeypatch.setattr(routes, "merge_session_messages_append_only", lambda side, state, **_k: side + state)
    monkeypatch.setattr(routes, "_merged_webui_lineage_messages_for_display", lambda _s, messages: messages)
    monkeypatch.setattr(routes, "_evict_sessions_over_cap", lambda: None)
    monkeypatch.setattr(routes, "publish_session_list_changed", lambda *_a, **_k: None)
    monkeypatch.setattr(routes.Session, "save", lambda self: None)
    cap = _capture_route(monkeypatch)
    routes.handle_post(_FakeHandler(), urlparse("/api/session/branch"))
    assert cap["status"] == 200
    forked = routes.SESSIONS[cap["ok"]["session_id"]]
    assert forked.messages == [conclusion]
    routes.SESSIONS.pop(cap["ok"]["session_id"], None)


# ── Session model ──────────────────────────────────────────────────────────────

def test_session_model_parent_session_id():
    """Verify Session model supports parent_session_id."""
    src = _read('api/models.py')
    assert 'parent_session_id' in src, "Session model should have parent_session_id"
    # Check __init__ parameter
    assert 'parent_session_id: str=None' in src, \
        "Session.__init__ should accept parent_session_id parameter"
    # Check it's set on self
    assert 'self.parent_session_id = parent_session_id' in src, \
        "Session.__init__ should assign parent_session_id"


def test_session_compact_includes_parent():
    """Verify compact() includes parent_session_id."""
    src = _read('api/models.py')
    # Find the compact method and scan its full body for parent_session_id.
    # PR #1591 (May 2026) added a has_pending_user_message recompute block at
    # the top of compact() which pushed the parent_session_id field beyond a
    # 1500-char window — widen the scan to 3000 chars to cover the full
    # return-dict body without re-tightening every time compact() grows.
    # compact() accepts optional projection flags on separate lines; match the
    # method name and first parameter without pinning formatting.
    compact_def_match = re.search(r"def compact\(\s*self", src)
    assert compact_def_match, "Could not find compact() method"
    snippet = src[compact_def_match.start():compact_def_match.start() + 3000]
    assert "'parent_session_id'" in snippet, \
        "compact() should include parent_session_id"


def test_session_metadata_fields_includes_parent():
    """Verify parent_session_id is in METADATA_FIELDS for persistence."""
    src = _read('api/models.py')
    assert "'parent_session_id'" in src, \
        "METADATA_FIELDS should include parent_session_id"


# ── Frontend: slash command ────────────────────────────────────────────────────

# ── Frontend: forkFromMessage ─────────────────────────────────────────────────

# ── Frontend: fork button in messages ──────────────────────────────────────────

# ── Frontend: sidebar parent indicator ────────────────────────────────────────

# ── Frontend: i18n keys ────────────────────────────────────────────────────────

# ── Frontend: icon ─────────────────────────────────────────────────────────────
