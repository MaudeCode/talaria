"""Small atomic sidecars for composer drafts.

Composer input changes frequently. Persisting a draft by rewriting the complete
session transcript makes typing contend with chat saves and scales with the full
conversation size. Draft sidecars keep that write bounded while Session.load()
continues to present the same composer_draft field to callers.
"""

from __future__ import annotations

import json
import os
import threading
import weakref
from pathlib import Path

import api.config as _cfg

_SAFE_SID_CHARS = frozenset(
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-"
)
_LOCKS_GUARD = threading.Lock()
_LOCKS: weakref.WeakValueDictionary[str, threading.Lock] = weakref.WeakValueDictionary()
_DRAFT_VERSION_KEY = "_draft_version"


class DraftVersionConflict(ValueError):
    """Raised when a stale or legacy mutation would replace a newer draft."""

    def __init__(self, current_draft: dict, current_version: str | None):
        super().__init__("Composer draft changed in another request")
        self.current_draft = current_draft
        self.current_version = current_version


def _safe_sid(sid: str) -> bool:
    return bool(sid) and isinstance(sid, str) and all(c in _SAFE_SID_CHARS for c in sid)


def _draft_dir() -> Path:
    return Path(_cfg.SESSION_DIR) / "_drafts"


def draft_path(sid: str) -> Path:
    if not _safe_sid(sid):
        raise ValueError("Invalid session_id")
    return _draft_dir() / f"{sid}.json"


def _draft_lock(sid: str) -> threading.Lock:
    with _LOCKS_GUARD:
        lock = _LOCKS.get(sid)
        if lock is None:
            lock = threading.Lock()
            _LOCKS[sid] = lock
        return lock


def normalize_draft(value) -> dict:
    draft = value if isinstance(value, dict) else {}
    text = draft.get("text", "")
    files = draft.get("files", [])
    return {
        "text": text if isinstance(text, str) else "",
        "files": files if isinstance(files, list) else [],
    }


def normalize_draft_version(value) -> str | None:
    """Return the canonical decimal draft revision accepted from a client.

    Revisions use millisecond wall time multiplied by 1000, leaving room for
    same-millisecond local increments.  Keeping the value as a decimal string
    avoids JSON/JavaScript integer-width surprises while still giving the
    server a cheap, total numeric ordering.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("Invalid draft_version")
    if isinstance(value, int):
        value = str(value)
    if not isinstance(value, str) or not value.isascii() or not value.isdigit():
        raise ValueError("Invalid draft_version")
    if not 1 <= len(value) <= 20:
        raise ValueError("Invalid draft_version")
    canonical = str(int(value))
    if canonical == "0":
        raise ValueError("Invalid draft_version")
    return canonical


def _read_record_unlocked(path: Path, *, fallback=None) -> tuple[dict, str | None]:
    if not path.exists():
        return normalize_draft(fallback), None
    value = json.loads(path.read_text(encoding="utf-8"))
    version = None
    if isinstance(value, dict) and value.get(_DRAFT_VERSION_KEY) is not None:
        version = normalize_draft_version(value[_DRAFT_VERSION_KEY])
    return normalize_draft(value), version


def read_session_draft_state(sid: str, *, fallback=None) -> tuple[dict, str | None]:
    """Return the public draft plus its persisted server-enforced revision."""
    try:
        path = draft_path(sid)
        with _draft_lock(sid):
            return _read_record_unlocked(path, fallback=fallback)
    except (OSError, ValueError, json.JSONDecodeError):
        return normalize_draft(fallback), None


def read_session_draft(sid: str, *, fallback=None) -> dict:
    """Return the sidecar draft when present, otherwise normalized fallback."""
    return read_session_draft_state(sid, fallback=fallback)[0]


def write_session_draft(sid: str, draft, *, version=None) -> dict:
    """Atomically persist a bounded, monotonically-versioned composer draft.

    Compatibility is intentionally one-way: unversioned clients may keep
    writing an unversioned sidecar, but once any current client writes a
    version, later unversioned requests fail closed instead of being allowed to
    resurrect older text.  Equal-version retries are accepted only when their
    normalized payload is identical.
    """
    normalized = normalize_draft(draft)
    normalized_version = normalize_draft_version(version)
    path = draft_path(sid)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}.{threading.get_ident()}")
    with _draft_lock(sid):
        try:
            current_draft, current_version = _read_record_unlocked(path)
        except (OSError, ValueError, json.JSONDecodeError):
            current_draft, current_version = normalize_draft(None), None
        if current_version is not None:
            if normalized_version is None or int(normalized_version) < int(current_version):
                raise DraftVersionConflict(current_draft, current_version)
            if int(normalized_version) == int(current_version):
                if normalized != current_draft:
                    raise DraftVersionConflict(current_draft, current_version)
                return current_draft
        record = dict(normalized)
        if normalized_version is not None:
            record[_DRAFT_VERSION_KEY] = normalized_version
        payload = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        try:
            with open(tmp, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
    return normalized


def delete_session_draft(sid: str) -> None:
    """Delete the composer draft sidecar for a deleted conversation."""
    try:
        path = draft_path(sid)
    except ValueError:
        return
    with _draft_lock(sid):
        path.unlink(missing_ok=True)
