"""``write_approval.*``: the Agent's staged skill and memory writes (TAL-819).

With ``skills.write_approval`` or ``memory.write_approval`` on, the Agent stages writes under
``<home>/pending/<kind>/<id>.json`` instead of committing them. These methods list them with
the diff an approval would apply, and approve or reject them through the Agent's own
``/skills`` and ``/memory`` review handlers.
"""

from __future__ import annotations

import contextlib
import difflib
import hashlib
import re
import tempfile
import threading
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext
from .profiles import invalidate_skill_stats

KINDS = ("skills", "memory")
# The Agent names records ``uuid4().hex[:8]`` and builds their path from the id; anything else could leave the pending dir.
_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
# One review at a time in this process, so two approvals of one record cannot both replay it.
_LOCK = threading.Lock()


def _agent():
    try:
        from hermes_cli import write_approval_commands
        from tools import write_approval
    except ImportError as exc:
        raise RpcError("This Hermes Agent cannot review staged writes", condition="write_approval_unavailable") from exc
    return write_approval, write_approval_commands


def _kind(params: dict) -> str:
    kind = str(params.get("kind") or "")
    if kind not in KINDS:
        raise InvalidParams("kind must be skills or memory")
    return kind


def _memory_diff(payload: dict) -> str:
    """Replay the record on a scratch copy of its file through the Agent's approve path; the diff is what approval commits."""
    from tools.memory_tool import ENTRY_DELIMITER, apply_memory_pending, load_on_disk_store

    store = load_on_disk_store()
    target = "user" if payload.get("target") == "user" else "memory"
    real = store._path_for(target)
    before = list(store._entries_for(target))
    with tempfile.TemporaryDirectory(prefix="talaria-pending-") as scratch:
        copy = Path(scratch) / real.name
        if real.is_file():
            copy.write_bytes(real.read_bytes())
        # The store resolves every read, lock and write through ``self._path_for``.
        store._path_for = lambda t: Path(scratch) / ("USER.md" if t == "user" else "MEMORY.md")
        result = apply_memory_pending(payload, store)
        after = list(store._entries_for(target))
    if not result.get("success"):
        raise _Unapprovable(f"(approve would fail: {result.get('error') or 'unknown error'})")
    lines = lambda entries: ENTRY_DELIMITER.join(entries).splitlines(keepends=True)  # noqa: E731
    diff = difflib.unified_diff(lines(before), lines(after), fromfile=f"a/{real.name}", tofile=f"b/{real.name}")
    return "".join(diff) or "(no textual change)"


class _Unapprovable(Exception):
    """A write with no diff the user could review: its message replaces the diff and approval is refused."""


def _skill_names(payload: dict) -> list[str]:
    ops = payload.get("operations") or [] if payload.get("action") == "batch" else [payload]
    return list(dict.fromkeys(str(op.get("name")) for op in ops if isinstance(op, dict) and op.get("name")))


def _item(wa, kind: str, record: dict) -> dict:
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    if kind == "memory":
        target = "user" if payload.get("target") == "user" else "memory"
    else:
        target = ", ".join(_skill_names(payload))
    diff, approvable = _diff(wa, kind, record)
    return {
        "id": str(record.get("id") or ""), "kind": kind, "target": target, "op": str(payload.get("action") or record.get("action") or ""),
        "summary": str(record.get("summary") or ""), "origin": str(record.get("origin") or "foreground"),
        "created_at": float(record.get("created_at") or 0), "diff": diff,
        "approvable": approvable, "revision": _revision(diff) if approvable else "",
    }


def _diff(wa, kind: str, record: dict) -> tuple[str, bool]:
    """The diff approving ``record`` applies and whether it may be approved; a diff that cannot be built is never approvable."""
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    try:
        return (_memory_diff(payload) if kind == "memory" else wa.skill_pending_diff(record)), True
    except _Unapprovable as exc:
        return str(exc), False
    except Exception as exc:  # noqa: BLE001 - one unreadable record must not hide the rest
        return f"(diff unavailable: {exc})", False


def _apply_lock(kind: str, record: dict):
    """Hold the Agent's own per-skill locks across the revision check and the apply (they are re-entrant in this thread, so
    the Agent's apply takes them again). Memory needs none: the Agent applies a staged remove/patch only to the exact entry
    it pinned at staging and an add only appends, so a concurrent write can never be dropped by an approval."""
    if kind != "skills":
        return contextlib.nullcontext()
    from tools.skill_manager_tool import _skill_mutation_locks

    return _skill_mutation_locks(_skill_names(record.get("payload") if isinstance(record.get("payload"), dict) else {}))


def _revision(diff: str) -> str:
    """What the reviewer saw: the diff changes whenever the record or the file it applies to does."""
    return hashlib.sha256(diff.encode("utf-8")).hexdigest()


def pending(kind: str) -> dict:
    try:
        wa, _ = _agent()
    except RpcError:
        return {"supported": False, "enabled": False, "items": []}
    items = [_item(wa, kind, record) for record in wa.list_pending(kind) if _ID.fullmatch(str(record.get("id") or ""))]
    return {"supported": True, "enabled": wa.write_approval_enabled(kind), "items": items}


def review(kind: str, verb: str, writes: list[dict]) -> dict:
    """``approve`` or ``reject`` each write through the Agent's handler; a record that is gone afterwards was applied or dropped.

    An approval applies only while the write's diff still has the ``revision`` the reviewer saw; a changed file or record
    is refused, so nothing lands that the user did not review.
    """
    wa, commands = _agent()
    if not writes or any(not (isinstance(w, dict) and _ID.fullmatch(str(w.get("id") or "")) and isinstance(w.get("revision"), str)) for w in writes):
        raise InvalidParams("writes must be pending write ids with the revision reviewed")
    results = []
    with _LOCK:
        for write in writes:
            pending_id = write["id"]
            record = wa.get_pending(kind, pending_id)
            if record is None:
                results.append({"id": pending_id, "done": False, "message": f"No pending {kind} write with id '{pending_id}'."})
                continue
            if verb == "reject":
                message = commands.handle_pending_subcommand(kind, [verb, pending_id]) or ""
            else:
                with _apply_lock(kind, record):
                    diff, approvable = _diff(wa, kind, record)
                    if not approvable:
                        results.append({"id": pending_id, "done": False, "message": f"This write cannot be approved: {diff}"})
                        continue
                    if _revision(diff) != write["revision"]:
                        results.append({"id": pending_id, "done": False, "message": "This write's diff changed after you reviewed it. Review the new diff, then approve again."})
                        continue
                    store = None
                    if kind == "memory":
                        from tools.memory_tool import load_on_disk_store

                        store = load_on_disk_store()
                    message = commands.handle_pending_subcommand(kind, [verb, pending_id], memory_store=store) or ""
            results.append({"id": pending_id, "done": wa.get_pending(kind, pending_id) is None, "message": message})
    return {"results": results}


def register(registry) -> None:
    @registry.method("write_approval.pending")
    def pending_(ctx: CallContext, params: dict) -> dict:
        kind = _kind(params)
        with scoped_home(profile_home_param(params)):
            return pending(kind)

    for verb in ("approve", "reject"):
        def handler(ctx: CallContext, params: dict, verb: str = verb) -> dict:
            kind = _kind(params)
            writes = list(params.get("writes") or [])
            home = profile_home_param(params)
            try:
                with scoped_home(home):
                    return review(kind, verb, writes)
            finally:
                if kind == "skills" and verb == "approve":
                    invalidate_skill_stats(home)

        registry.method(f"write_approval.{verb}")(handler)
