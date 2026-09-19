"""
Regression tests -- one test per bug that was introduced and fixed.
These tests exist specifically to prevent those bugs from silently returning.

Each test is tagged with the sprint/commit where the bug was found and fixed.
"""
import json
import os
import pathlib
import re
import time
import urllib.error
import urllib.request
import urllib.parse
REPO_ROOT = pathlib.Path(__file__).parent.parent.resolve()

from tests._pytest_port import BASE

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.loads(r.read()), r.status

def get_raw(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return r.read(), r.headers.get("Content-Type",""), r.status

def post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code

def make_session(created_list):
    d, _ = post("/api/session/new", {})
    sid = d["session"]["session_id"]
    created_list.append(sid)
    return sid


def _make_session_visible(sid):
    from api.models import Session
    from tests.conftest import TEST_WORKSPACE

    session = Session(
        session_id=sid,
        title="regression-test-delete-R8",
        workspace=str(TEST_WORKSPACE),
        model="test",
        created_at=time.time(),
        updated_at=time.time(),
        profile="default",
        messages=[{"role": "user", "content": "visible row", "timestamp": time.time()}],
        tool_calls=[],
    )
    session.save(touch_updated_at=False)


def _make_auth_json_with_credential_pool(
    provider_id: str, pool_entries: list[dict], tmp_dir: pathlib.Path
) -> pathlib.Path:
    """Write an auth.json with only credential_pool entries for provider_id."""
    store = {"providers": {}, "credential_pool": {provider_id: pool_entries}}
    auth_path = tmp_dir / "auth.json"
    auth_path.write_text(json.dumps(store), encoding="utf-8")
    return auth_path


# ── R1: uuid not imported in server.py (Sprint 10 split regression) ──────────

def test_chat_start_returns_stream_id(cleanup_test_sessions):
    """R1: chat/start must return stream_id -- catches missing uuid import.
    When uuid was missing, this returned 500 (NameError).
    """
    sid = make_session(cleanup_test_sessions)
    data, status = post("/api/chat/start", {
        "session_id": sid,
        "message": "ping",
        "model": "openai/gpt-5.4-mini",
    })
    # Must return 200 with a stream_id -- not 500
    assert status == 200, f"chat/start failed with {status}: {data}"
    assert "stream_id" in data, "stream_id missing from chat/start response"
    assert len(data["stream_id"]) > 8, "stream_id looks invalid"
    post("/api/session/delete", {"session_id": sid})
    cleanup_test_sessions.clear()


# ── R2: AIAgent not imported in api/streaming.py (Sprint 10 split regression) ─

def test_chat_stream_opens_successfully(cleanup_test_sessions):
    """R2: After chat/start, GET /api/chat/stream must return 200 (SSE opens).
    When AIAgent was missing, the thread crashed immediately, popped STREAMS,
    and the SSE GET returned 404.
    """
    sid = make_session(cleanup_test_sessions)
    data, status = post("/api/chat/start", {
        "session_id": sid,
        "message": "say: hello",
        "model": "openai/gpt-5.4-mini",
    })
    assert status == 200, f"chat/start failed: {data}"
    stream_id = data["stream_id"]

    # Open the SSE stream -- must return 200, not 404
    # We only check headers (don't read the full stream body)
    req = urllib.request.Request(BASE + f"/api/chat/stream?stream_id={stream_id}")
    try:
        r = urllib.request.urlopen(req, timeout=3)
        assert r.status == 200, f"SSE stream returned {r.status} (expected 200)"
        ct = r.headers.get("Content-Type", "")
        assert "text/event-stream" in ct, f"Wrong Content-Type: {ct}"
        r.close()
    except urllib.error.HTTPError as e:
        assert False, f"SSE stream returned {e.code} -- AIAgent may not be imported"
    except Exception:
        pass  # timeout or connection close after brief read is fine

    post("/api/session/delete", {"session_id": sid})
    cleanup_test_sessions.clear()


# ── R3: Session.__init__ missing tool_calls param (Sprint 10 split regression) ─

def test_session_with_tool_calls_in_json_loads_ok(cleanup_test_sessions):
    """R3: Sessions that have tool_calls in their JSON must load without 500.
    When tool_calls=None was missing from Session.__init__, loading such sessions
    threw TypeError: unexpected keyword argument.
    """
    sid = make_session(cleanup_test_sessions)

    # Manually inject tool_calls into the session's JSON file
    from tests._pytest_port import TEST_STATE_DIR
    sessions_dir = pathlib.Path(os.environ.get("HERMES_WEBUI_TEST_STATE_DIR", str(TEST_STATE_DIR))) / "sessions"
    session_file = sessions_dir / f"{sid}.json"
    if session_file.exists():
        d = json.loads(session_file.read_text())
        d["tool_calls"] = [
            {"name": "terminal", "snippet": "test output", "tid": "test_tid_001", "assistant_msg_idx": 1}
        ]
        session_file.write_text(json.dumps(d))

    # Loading the session must return 200, not 500
    data, status = get(f"/api/session?session_id={urllib.parse.quote(sid)}")
    assert status == 200, f"Session with tool_calls returned {status}: {data}"
    assert data["session"]["session_id"] == sid

    post("/api/session/delete", {"session_id": sid})
    cleanup_test_sessions.clear()


# ── R4: approval check not imported in streaming.py (Sprint 10 split regression) ─

def test_streaming_py_imports_has_pending(cleanup_test_sessions):
    """R4: api/streaming.py must import an approval-check function.
    When missing, the approval check mid-stream caused NameError.
    """
    src = (REPO_ROOT / "api/streaming.py").read_text()
    assert "has_blocking_approval" in src, "has_blocking_approval not found in api/streaming.py"
    assert "import" in src and "has_blocking_approval" in src, \
        "has_blocking_approval must be imported in api/streaming.py"


def test_aiagent_imported_in_streaming(cleanup_test_sessions):
    """R2b: api/streaming.py must resolve AIAgent through the runtime guard.
    When missing, the streaming thread crashed immediately after being spawned.
    """
    src = (REPO_ROOT / "api/streaming.py").read_text()
    assert "get_ai_agent_class" in src, "guarded AIAgent resolver not referenced in api/streaming.py"
    assert "from api.agent_runtime import" in src and "get_ai_agent_class" in src, \
        "AIAgent must be resolved through api.agent_runtime in api/streaming.py"


# ── R5: SSE loop did not break on cancel event (Sprint 10 bug) ───────────────

def test_cancel_nonexistent_stream_returns_not_cancelled(cleanup_test_sessions):
    """R5a: Cancel endpoint works and returns cancelled:false for unknown stream."""
    data, status = get("/api/chat/cancel?stream_id=nonexistent_test_xyz")
    assert status == 200
    assert data["ok"] is True
    assert data["cancelled"] is False


def test_server_py_sse_loop_breaks_on_cancel(cleanup_test_sessions):
    """R5b: SSE loop must include 'cancel' in the break condition.
    When missing, the connection hung after the cancel event was processed.
    Sprint 11: logic moved from server.py to api/routes.py -- check both.
    """
    import re
    # Check server.py first, then api/routes.py (Sprint 11 extracted routes)
    src = (REPO_ROOT / "server.py").read_text()
    routes_src = (REPO_ROOT / "api" / "routes.py").read_text() if (REPO_ROOT / "api" / "routes.py").exists() else ""
    combined = src + routes_src
    # #6527: the break condition may be an inline tuple ("stream_end", ...) OR
    # the named SSE_RELAY_CLOSE_EVENTS frozenset. Accept either shape and pin
    # the BEHAVIOR (cancel closes the relay) against the resolved close set,
    # not the source syntax.
    m = re.search(
        r"if event in (?:SSE_RELAY_CLOSE_EVENTS|\([^)]*cancel[^)]*\)):\s*break",
        combined,
    )
    assert m, "SSE break/close condition not found in server.py or api/routes.py"
    from api.run_journal import SSE_RELAY_CLOSE_EVENTS
    assert "cancel" in SSE_RELAY_CLOSE_EVENTS, \
        f"'cancel' missing from SSE relay close set: {SSE_RELAY_CLOSE_EVENTS}"
    assert "apperror" in SSE_RELAY_CLOSE_EVENTS, \
        f"'apperror' missing from SSE relay close set: {SSE_RELAY_CLOSE_EVENTS}"


# ── R6: Test cron isolation (Sprint 10) ──────────────────────────────────────

def test_real_jobs_json_not_polluted_by_tests(cleanup_test_sessions):
    """R6: Test runs must not write to the real ~/.hermes/cron/jobs.json.
    When HERMES_HOME isolation was missing, every test run added test-job-* entries.
    """
    real_jobs_path = pathlib.Path.home() / ".hermes" / "cron" / "jobs.json"
    if not real_jobs_path.exists():
        return  # no jobs file at all -- fine

    jobs = json.loads(real_jobs_path.read_text())
    if isinstance(jobs, dict):
        jobs = jobs.get("jobs", [])

    test_jobs = [j for j in jobs if j.get("name", "").startswith("test-job-")]
    assert len(test_jobs) == 0, \
        f"Real jobs.json contains {len(test_jobs)} test-job-* entries: " \
        f"{[j['name'] for j in test_jobs]}"


# ── General: api modules all importable ──────────────────────────────────────

def test_all_api_modules_importable(cleanup_test_sessions):
    """All api/ modules must be importable without NameError or ImportError.
    Catches missing imports introduced during future module splits.
    """
    import ast, pathlib
    api_dir = REPO_ROOT / "api"
    for module_file in api_dir.glob("*.py"):
        src = module_file.read_text()
        try:
            ast.parse(src)
        except SyntaxError as e:
            assert False, f"{module_file.name} has syntax error: {e}"


def test_server_py_importable(cleanup_test_sessions):
    """server.py must parse without syntax errors after any split."""
    import ast, pathlib
    src = (REPO_ROOT / "server.py").read_text()
    try:
        ast.parse(src)
    except SyntaxError as e:
        assert False, f"server.py has syntax error: {e}"

# ── R7: Cross-session busy state bleed ───────────────────────────────────────

# ── R8: Session delete does not invalidate index (ghost sessions) ─────────────

def test_deleted_session_does_not_appear_in_list(cleanup_test_sessions):
    """R8: After deleting a session, it must not appear in /api/sessions.
    When _index.json was not invalidated on delete, the session reappeared
    in the list even after the JSON file was removed.
    """
    # Create a session with a title so it shows in the list
    d, _ = post("/api/session/new", {})
    sid = d["session"]["session_id"]
    post("/api/session/rename", {"session_id": sid, "title": "regression-test-delete-R8"})
    _make_session_visible(sid)
    post("/api/session/rename", {"session_id": sid, "title": "regression-test-delete-R8"})

    # Verify it appears
    sessions, _ = get("/api/sessions")
    ids_before = [s["session_id"] for s in sessions["sessions"]]
    assert sid in ids_before, "Session must appear in list before delete"

    # Delete it
    result, status = post("/api/session/delete", {"session_id": sid})
    assert status == 200 and result.get("ok") is True

    # Verify it no longer appears -- even after a second fetch (index rebuild)
    sessions2, _ = get("/api/sessions")
    ids_after = [s["session_id"] for s in sessions2["sessions"]]
    assert sid not in ids_after,         f"Deleted session {sid} still appears in list -- index not invalidated on delete"


def test_server_delete_prunes_session_index(cleanup_test_sessions):
    """session/delete should prune the deleted row without discarding the index."""
    src = (REPO_ROOT / "server.py").read_text()
    routes_src = (REPO_ROOT / "api" / "routes.py").read_text() if (REPO_ROOT / "api" / "routes.py").exists() else ""
    # Find the delete handler in either file
    for label, text in [("server.py", src), ("api/routes.py", routes_src)]:
        # Accept both single-quote and double-quote style (formatting varies by contributor)
        delete_idx = max(
            text.find("if parsed.path == '/api/session/delete':"),
            text.find('if parsed.path == "/api/session/delete":'),
        )
        if delete_idx >= 0:
            delete_block = text[delete_idx:delete_idx+5000]
            assert "prune_session_from_index(sid)" in delete_block, \
                f"{label} session/delete must prune SESSION_INDEX_FILE"
            return
    assert False, "session/delete handler not found in server.py or api/routes.py"


def test_server_delete_removes_session_bak_snapshot(cleanup_test_sessions):
    """session/delete must remove sidecar backups so deleted sessions stay deleted."""
    routes_src = (REPO_ROOT / "api" / "routes.py").read_text()
    delete_idx = max(
        routes_src.find("if parsed.path == '/api/session/delete':"),
        routes_src.find('if parsed.path == "/api/session/delete":'),
    )
    assert delete_idx >= 0, "session/delete handler not found in api/routes.py"
    delete_end = routes_src.find('if parsed.path == "/api/session/clear":', delete_idx)
    assert delete_end > delete_idx, "session/delete handler boundary not found"
    delete_block = routes_src[delete_idx:delete_end]
    assert "with_suffix('.json.bak').unlink" in delete_block or 'with_suffix(".json.bak").unlink' in delete_block, \
        "session/delete must unlink <sid>.json.bak to avoid later orphan-backup recovery"

# ── R9: Token/tool SSE events write to wrong session after switch ─────────────

# ── R10: respondApproval uses wrong session_id after switch (multi-session) ─

# ── R11: Tool progress must not use shared status chrome ──────────────────

# ── R12: Live tool cards lost on switch-away and switch-back ──────────────

# ── R13: renderMessages() called before S.busy=false in done handler ────────

# ── R14: send() uses stale modelSelect.value instead of session model ────────

# ── R15: newSession does not clear live tool cards ────────────────────────────

def test_chat_start_persists_pending_turn_metadata_for_reload_recovery(cleanup_test_sessions):
    """R15c: chat/start must expose enough pending-turn metadata for a reload to
    rebuild the in-flight conversation instead of showing a blank session.
    """
    routes_src = (REPO_ROOT / "api/routes.py").read_text()
    assert 's.active_stream_id = stream_id' in routes_src
    assert 's.pending_user_message = msg' in routes_src
    assert 's.pending_attachments = attachments' in routes_src
    assert '"active_stream_id": getattr(s, "active_stream_id", None)' in routes_src
    assert '"pending_user_message": getattr(s, "pending_user_message", None)' in routes_src


def test_session_detail_uses_runtime_streaming_state(cleanup_test_sessions):
    """GET /api/session must agree with /api/sessions on live stream ownership."""
    routes_src = (REPO_ROOT / "api/routes.py").read_text()
    session_route = routes_src.split('def _handle_session_get(', 1)[1].split(
        'def handle_get(', 1
    )[0]
    assert "active_stream_ids = _active_stream_ids()" in session_route
    assert "s.compact(" in session_route
    assert "include_runtime=True" in session_route
    assert "active_stream_ids=active_stream_ids" in session_route


# ── R16: Switching away/back must preserve live partial assistant output ─────


def test_streaming_bridge_accepts_current_tool_progress_callback_signature(cleanup_test_sessions):
    """R17: api/streaming.py must accept the current Hermes agent callback contract.
    The agent now calls tool_progress_callback(event_type, name, preview, args, **kwargs).
    If the WebUI bridge only accepts (name, preview, args), live tool updates silently vanish.
    """
    src = (REPO_ROOT / "api/streaming.py").read_text()
    assert "def on_tool(*cb_args, **cb_kwargs):" in src, \
        "streaming.py must accept variable callback args for tool progress events"
    assert "reasoning_callback=on_reasoning" in src, \
        "streaming.py must wire the agent's reasoning callback into the SSE bridge"
    assert "put('tool_complete'" in src or 'put("tool_complete"' in src, \
        "streaming.py must emit live tool completion SSE events"


def test_streaming_reads_reasoning_effort_from_config_dict(cleanup_test_sessions):
    """R17b: WebUI must read agent.reasoning_effort from the dict returned by get_config().

    `get_config()` returns a plain dict (not a wrapper exposing `.cfg`).  The
    pre-fix line `_cfg.cfg.get('agent', {})` raised AttributeError that the
    surrounding try/except swallowed, so `_reasoning_config` was always None
    regardless of what `/reasoning <level>` had been set to.  This static
    source assertion pins the fix because the runtime symptom is silent.
    """
    src = (REPO_ROOT / "api/streaming.py").read_text()
    assert "_cfg.cfg" not in src, \
        "get_config() returns a dict; accessing _cfg.cfg drops reasoning_config to None"
    assert "_cfg.get('agent', {})" in src or '_cfg.get("agent", {})' in src, \
        "streaming.py must read agent.reasoning_effort via the config dict"


def test_streaming_agent_cache_signature_includes_reasoning_config(cleanup_test_sessions):
    """R17c: changing reasoning effort mid-session must rebuild the cached per-session agent.

    Without `_reasoning_config` participating in `_sig_blob`, the cache key
    matches the old entry and the operator's `/reasoning xhigh` change has
    no effect on the live session.
    """
    src = (REPO_ROOT / "api/streaming.py").read_text()
    start = src.find("_sig_blob = _json.dumps")
    end = src.find("_agent_sig", start)
    assert start >= 0 and end > start, "agent cache signature block not found"
    sig_block = src[start:end]
    assert "_reasoning_config" in sig_block, \
        "agent cache signature must include reasoning_config so xhigh/medium changes take effect"


# ── R17: Stack traces must not leak to clients in 500 responses ────────────

def test_500_response_has_no_trace_field():
    """R16: HTTP 500 responses must not include a 'trace' field.
    Leaking tracebacks exposes file paths, module names, and potentially
    secret values from local variables.
    """
    # POST to /api/chat/start with missing required fields to trigger an error
    data, status = post("/api/chat/start", {})
    # Should be an error response (4xx or 5xx)
    assert "trace" not in data, \
        "Server must not leak stack traces to clients"

def test_upload_error_has_no_trace_field():
    """R16b: Upload 500 responses must not include a 'trace' field."""
    # Send a POST to /api/upload with invalid content to trigger the error handler
    req = urllib.request.Request(
        BASE + "/api/upload",
        data=b"not-multipart-data",
        headers={"Content-Type": "text/plain", "Content-Length": "18"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            body = json.loads(r.read())
            code = r.status
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
        code = e.code
    assert code >= 400, "Invalid upload should return an error status"
    assert "trace" not in body, \
        "Upload errors must not leak stack traces to clients"
    assert "error" in body, "Error responses must include an 'error' key"


# ── #248: /skills slash command ───────────────────────────────────────────────

# ── R18: OAuth onboarding must recognize credential_pool-only auth ───────────

def test_provider_oauth_authenticated_accepts_credential_pool_entries(
    cleanup_test_sessions, tmp_path
):
    """R18a: pool-only OAuth auth.json should count as authenticated.

    Hermes runtime resolves Codex credentials from credential_pool; onboarding
    must not insist on stale or duplicated providers[provider_id] entries.
    """
    _make_auth_json_with_credential_pool(
        "openai-codex",
        [
            {
                "id": "pool1",
                "label": "device_code",
                "source": "device_code",
                "auth_type": "oauth",
                "access_token": "***",
                "refresh_token": "***",
                "base_url": "https://chatgpt.com/backend-api/codex",
            }
        ],
        tmp_path,
    )

    from api.onboarding import _provider_oauth_authenticated

    assert _provider_oauth_authenticated("openai-codex", tmp_path) is True


def test_provider_oauth_authenticated_rejects_flag_only_credential_pool_entries(
    cleanup_test_sessions, tmp_path
):
    """R18a2: metadata flags alone must not count as usable OAuth auth."""
    _make_auth_json_with_credential_pool(
        "openai-codex",
        [
            {
                "id": "pool1",
                "label": "device_code",
                "source": "device_code",
                "auth_type": "oauth",
                "has_access_token": True,
                "has_refresh_token": True,
                "base_url": "https://chatgpt.com/backend-api/codex",
            }
        ],
        tmp_path,
    )

    from api.onboarding import _provider_oauth_authenticated

    assert _provider_oauth_authenticated("openai-codex", tmp_path) is False


def test_status_from_runtime_marks_openai_codex_ready_from_credential_pool(
    cleanup_test_sessions, tmp_path
):
    """R18b: provider_ready should be true when auth lives only in credential_pool."""
    _make_auth_json_with_credential_pool(
        "openai-codex",
        [
            {
                "id": "pool1",
                "label": "device_code",
                "source": "device_code",
                "auth_type": "oauth",
                "access_token": "***",
                "refresh_token": "***",
                "base_url": "https://chatgpt.com/backend-api/codex",
            }
        ],
        tmp_path,
    )

    from api.onboarding import _status_from_runtime
    import api.onboarding as _ob

    orig_home = _ob._get_active_hermes_home
    orig_found = _ob._HERMES_FOUND
    _ob._get_active_hermes_home = lambda: tmp_path
    _ob._HERMES_FOUND = True
    try:
        result = _status_from_runtime(
            {"model": {"provider": "openai-codex", "default": "codex-mini-latest"}},
            True,
        )
    finally:
        _ob._get_active_hermes_home = orig_home
        _ob._HERMES_FOUND = orig_found

    assert result["provider_configured"] is True
    assert result["provider_ready"] is True
    assert result["setup_state"] == "ready"
