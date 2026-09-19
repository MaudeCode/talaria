"""Behavioral coverage for failed multi-file chat-upload rollback receipts."""

import api.upload as upload


def _reset_receipts():
    with upload._UPLOAD_ROLLBACK_RECEIPTS_LOCK:
        upload._UPLOAD_ROLLBACK_RECEIPTS.clear()


def test_rollback_removes_only_receipt_owned_file_and_retry_reuses_name(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_WEBUI_ATTACHMENT_DIR", str(tmp_path))
    _reset_receipts()
    session_id = "rollback-session"
    session_dir = upload._session_attachment_dir(session_id)
    session_dir.mkdir(parents=True)
    preexisting = session_dir / "kept.txt"
    preexisting.write_text("keep", encoding="utf-8")

    first = upload._upload_destination(session_id, "retry.txt")
    first.write_text("attempt-one", encoding="utf-8")
    token = upload._register_upload_rollback_receipt(session_id, first)

    assert upload._rollback_upload_receipts(session_id, [token]) == {
        "ok": True,
        "rolled_back": 1,
        "failed": 0,
    }
    assert preexisting.read_text(encoding="utf-8") == "keep"
    assert not first.exists()
    assert upload._upload_destination(session_id, "retry.txt").name == "retry.txt"


def test_rollback_failure_preserves_replaced_target_and_retry_uses_collision(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_WEBUI_ATTACHMENT_DIR", str(tmp_path))
    _reset_receipts()
    session_id = "rollback-race"
    session_dir = upload._session_attachment_dir(session_id)
    session_dir.mkdir(parents=True)
    target = session_dir / "same.txt"
    target.write_text("uploaded", encoding="utf-8")
    token = upload._register_upload_rollback_receipt(session_id, target)

    # Replacement after receipt issuance must never be mistaken for the file
    # created by the failed send attempt.
    target.unlink()
    target.write_text("pre-existing replacement", encoding="utf-8")

    assert upload._rollback_upload_receipts(session_id, [token]) == {
        "ok": False,
        "rolled_back": 0,
        "failed": 1,
    }
    assert target.read_text(encoding="utf-8") == "pre-existing replacement"
    assert upload._upload_destination(session_id, "same.txt").name == "same-1.txt"


def test_rollback_receipt_is_scoped_to_its_session(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_WEBUI_ATTACHMENT_DIR", str(tmp_path))
    _reset_receipts()
    owner = "owner-session"
    target = upload._session_attachment_dir(owner) / "owned.txt"
    target.parent.mkdir(parents=True)
    target.write_text("owned", encoding="utf-8")
    token = upload._register_upload_rollback_receipt(owner, target)

    result = upload._rollback_upload_receipts("other-session", [token])
    assert result == {"ok": False, "rolled_back": 0, "failed": 1}
    assert target.exists()
