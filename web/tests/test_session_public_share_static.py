from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
def test_share_snapshot_redaction_is_always_on_regardless_of_setting():
    # The public-share boundary must redact credentials + local paths and drop
    # non-text/tool/system content EVEN IF the operator disabled api_redact_enabled.
    import os, tempfile
    os.environ.setdefault("HERMES_WEBUI_STATE_DIR", tempfile.mkdtemp())
    import api.config as config
    import api.shares as shares
    # Force the user-toggleable API redaction OFF (redact_session_data reads
    # api.config.load_settings() at call time).
    _orig = config.load_settings
    config.load_settings = lambda: {"api_redact_enabled": False}
    try:
        class _S:
            pass
        s = _S()
        s.title = "Deploy sk-ABCDEF1234567890TOKEN"
        s.workspace = "/very/private/workspace"
        s.messages = [
            {"role": "system", "content": "internal system prompt stays private"},
            {"role": "user", "content": "key sk-SECRET1234567890abcdef path /very/private/workspace/x.py"},
            {"role": "assistant", "content": {"tool": "terminal", "output": "raw structured tool payload"}},
            # dict-valued "text" inside a text block (possible via /api/session/import)
            {"role": "assistant", "content": [{"type": "text", "text": {"tool": "terminal", "output": "STRUCTURED_SECRET_IN_TEXTBLOCK"}}]},
            {"role": "tool", "content": "raw tool output"},
            {"role": "assistant", "content": "Here is the answer."},
        ]
        snap = shares.build_share_snapshot(s)
        import json
        blob = json.dumps(snap)
        # credentials masked (in both title and message text)
        assert "sk-SECRET1234567890" not in blob
        assert "sk-ABCDEF1234567890" not in blob
        # local paths scrubbed
        assert "/very/private/workspace" not in blob
        # structured/dict content never stringified into the public payload
        assert "raw structured tool payload" not in blob
        assert "STRUCTURED_SECRET_IN_TEXTBLOCK" not in blob
        # system + tool roles excluded
        roles = [m["role"] for m in snap["messages"]]
        assert "system" not in roles and "tool" not in roles
        # the real answer is preserved
        assert any("Here is the answer" in m["content"] for m in snap["messages"])

    finally:
        config.load_settings = _orig


def test_share_snapshot_rejects_dict_valued_title():
    # A dict-valued title (possible via /api/session/import) must not be
    # stringified into the public snapshot — fall back to "Untitled".
    import os, tempfile
    os.environ.setdefault("HERMES_WEBUI_STATE_DIR", tempfile.mkdtemp())
    import api.shares as shares

    class _S:
        pass
    s = _S()
    s.title = {"leak": "STRUCTURED_TITLE_SECRET"}
    s.workspace = ""
    s.messages = [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi"}]
    snap = shares.build_share_snapshot(s)
    import json
    assert "STRUCTURED_TITLE_SECRET" not in json.dumps(snap)
    assert snap["title"] == "Untitled"
