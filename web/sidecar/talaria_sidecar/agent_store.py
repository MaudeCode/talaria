"""The Agent's session store: the one door every sidecar read and write of a profile's ``state.db`` goes through.

Agent v0.23.3 replaced ``hermes_state.SessionDB`` with its storage interface (``persistence_assembly`` and the
``persistence`` repositories) and kept only a limited ``SessionDB`` stand-in without ``ensure_session``, token
accounting, the compression tip, title lookups, the content decoder or the ``hermes_state_*`` modules. Older supported
Agents have no storage interface. Each verb here selects by that capability (``native()``) and calls the Agent's own
verb; the Agent keeps owning transactions, guards and handle lifetimes.

A writer handle (``acquire``) is the Agent's process-shared store handle, released with ``release``; a reader
(``reader``) is an owned read-only handle that never creates, migrates or repairs the store.
"""

from __future__ import annotations

import importlib.util
from contextlib import contextmanager
from pathlib import Path


def native() -> bool:
    """True on an Agent with the storage interface (v0.23.3+); older ones carry ``hermes_state.SessionDB``."""
    return importlib.util.find_spec("persistence_assembly") is not None


def _scope(home: Path):
    from persistence_assembly import profile_scope

    return profile_scope(home=Path(home))


# ── handles ──────────────────────────────────────────────────────────────

def acquire(home: Path):
    """A writer handle on ``home``'s store, shared with every other holder in this process (cached agents included)."""
    if native():
        from persistence_assembly import open_persistence

        return open_persistence(_scope(home), eager=True)
    from hermes_state_registry import acquire as registry_acquire

    return registry_acquire(Path(home) / "state.db")


def release(db) -> None:
    """Give back a handle ``acquire`` lent; the last one on a store closes it."""
    if native():
        db.close()
        return
    from hermes_state_registry import release_or_close

    release_or_close(db)


@contextmanager
def reader(home: Path):
    """An owned read-only handle on ``home``'s existing ``state.db``, closed on exit."""
    path = Path(home) / "state.db"
    if native():
        from persistence_assembly import open_persistence_reader

        with open_persistence_reader(path) as db:
            yield db
        return
    from hermes_state import SessionDB

    db = SessionDB(path, read_only=True)
    try:
        yield db
    finally:
        db.close()


# ── writes ───────────────────────────────────────────────────────────────

def ensure_session(db, session_id: str, *, source: str, model=None) -> None:
    """Create the row when missing; an existing row keeps every column an earlier writer set."""
    if native():
        from persistence.conversation.sessions import NewSession

        db.sessions.create(NewSession(session_id=session_id, source=source, model=model))
        return
    db.ensure_session(session_id=session_id, source=source, model=model)


def set_usage(db, session_id: str, *, input_tokens: int, output_tokens: int, cache_read_tokens: int, cache_write_tokens: int,
              api_call_count: int, estimated_cost, model, source: str) -> None:
    """Make the session's counters and estimate read these totals, creating the row with ``source`` when missing. The
    storage interface only adds, so it adds what the stored totals lack; it never lowers a counter another writer
    (the Agent's own per-call accounting) already raised past them."""
    if not native():
        db.update_token_counts(
            session_id=session_id, input_tokens=input_tokens, output_tokens=output_tokens, cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens, api_call_count=api_call_count, estimated_cost_usd=estimated_cost, model=model,
            absolute=True, source=source,
        )
        return
    from persistence.conversation.usage import BillingRoute, TokenCounts, UsageDelta

    row = db.sessions.get(session_id)

    def missing(name: str, total) -> int:
        return max(0, int(total or 0) - int((getattr(row, name) if row is not None else 0) or 0))

    stored_cost = row.estimated_cost_usd if row is not None else None
    cost = None if estimated_cost is None else max(0.0, float(estimated_cost) - float(stored_cost or 0.0))
    db.usage.queue_usage(session_id, UsageDelta(
        tokens=TokenCounts(input_tokens=missing("input_tokens", input_tokens), output_tokens=missing("output_tokens", output_tokens),
                           cache_read_tokens=missing("cache_read_tokens", cache_read_tokens),
                           cache_write_tokens=missing("cache_write_tokens", cache_write_tokens)),
        api_call_count=missing("api_call_count", api_call_count), estimated_cost_usd=cost or None,
        route=BillingRoute(model=model) if model else None, source=source,
    ))
    if not db.usage.flush_usage():
        raise TimeoutError("the Agent's usage writer did not apply the update")


def set_message_count(db, session_id: str, count: int) -> None:
    """Mirror the Web transcript's length on an Agent whose store does not count it; the storage interface counts every
    transcript row it appends itself and offers no override, so there it is left alone."""
    if native():
        return
    db._execute_write(lambda conn: conn.execute("UPDATE sessions SET message_count = ? WHERE id = ?", (count, session_id)))


def set_title(db, session_id: str, title: str, *, manual: bool, derived: bool = False, replace_automatic: bool = False) -> None:
    """A manual title lands with ``user`` provenance. An automatic one is ``llm``, or ``derived`` for a local summary,
    which ranks below ``llm`` so a later model title replaces it; neither replaces a user's. ``replace_automatic`` (an
    adaptive refresh, TAL-2631) replaces an untitled, ``derived`` or ``llm`` row at ``llm`` provenance, which the store's
    automatic write refuses at equal rank, and leaves a user's (or a pre-provenance) title. A title another session
    holds raises ``ValueError``."""
    if replace_automatic:
        _replace_automatic_title(db, session_id, title)
        return
    if native():
        from persistence.conversation.sessions import TitleSource

        if manual:
            db.sessions.set_title(session_id, title)
        else:
            db.sessions.set_auto_title(session_id, title, source=TitleSource.DERIVED if derived else TitleSource.LLM)
        return
    if manual:
        db.set_session_title(session_id, title)
    else:
        db.set_auto_title(session_id, title, source=getattr(db, "TITLE_SOURCE_DERIVED", "derived") if derived else getattr(db, "TITLE_SOURCE_LLM", "llm"))


def _replace_automatic_title(db, session_id: str, title: str) -> None:
    """One write transaction, so a rename from another thread or process lands wholly before or after it: an untitled,
    ``derived`` or ``llm`` row drops to ``derived`` and the store's own in-transaction title write lands ``title`` at
    ``llm`` (it refuses equal rank), with its sanitising, Bot Chat guard and conflict rules. A conflict raises
    ``ValueError`` and rolls the drop back. Neither store generation offers this as a public verb."""
    if native():
        from persistence.sqlite.conversation._store.titles import _set_session_title_in_transaction

        holder = db.sessions._store.holder()
        execute = holder._execute_write

        def land(conn):
            return _set_session_title_in_transaction(holder, conn, session_id, title, source="llm")
    else:
        execute = db._execute_write

        def land(conn):
            return db._set_session_title_in_transaction(conn, session_id, title, source="llm")

    def write(conn) -> None:
        row = conn.execute("SELECT title, title_source FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None or (row[0] is not None and row[1] not in ("derived", "llm")):
            return
        conn.execute("UPDATE sessions SET title_source = 'derived' WHERE id = ? AND title IS NOT NULL", (session_id,))
        if not land(conn):
            conn.execute("UPDATE sessions SET title_source = ? WHERE id = ?", (row[1], session_id))

    execute(write)


def next_title_in_lineage(db, title: str) -> str:
    return db.sessions.next_title_in_lineage(title) if native() else db.get_next_title_in_lineage(title)


def append_message(db, session_id: str, *, role: str, content: str, tool_name=None, timestamp=None) -> None:
    """One transcript row; the store bumps the session's message count with it."""
    if native():
        from persistence.conversation.messages import NewMessage

        db.messages.append(session_id, NewMessage.from_live({"role": role, "content": content, "tool_name": tool_name, "timestamp": timestamp}))
        return
    db.append_message(session_id, role, content=content, tool_name=tool_name, timestamp=timestamp)


def request_prompt_refresh(db) -> None:
    """Every continuing session rebuilds its stored system prompt once, on its next turn."""
    (db.sessions if native() else db).request_prompt_refresh()


def retain_refused_turn(db, session_id: str, *, notice: str, boundary_row_id) -> bool:
    """Take a refused turn out of the model context while keeping the user's ask on screen with ``notice``."""
    if native():
        return bool(db.messages.retain_refused_turn_for_display(session_id, notice=notice, boundary_row_id=boundary_row_id))
    from hermes_state_rewind import retain_refused_turn_for_display

    return bool(retain_refused_turn_for_display(db, session_id, notice=notice, boundary_row_id=boundary_row_id))


def emit_session_deleted(home: Path, ids: list[str], *, reason: str, primary: str, sessions_dir: Path) -> None:
    """The profile's ``on_session_delete`` plugin hook, as the Agent fires it after its own delete or archive. It opens
    no store; the Agent's emitter is fail-open."""
    if native():
        from session_retention import emit_session_deleted as emit

        emit(Path(home), ids, reason=reason, primary=primary, sessions_dir=sessions_dir)
        return
    from types import SimpleNamespace

    import hermes_state_common

    hermes_state_common.emit_session_deleted(SimpleNamespace(db_path=Path(home) / "state.db"), ids, reason=reason, primary=primary,
                                             sessions_dir=sessions_dir)


# ── reads ────────────────────────────────────────────────────────────────

def session_row(db, session_id: str) -> dict | None:
    """The stored session row as a dict of its columns, or None."""
    if native():
        record = db.sessions.get(session_id)
        return None if record is None else record.as_session_row()
    return db.get_session(session_id)


def usage_store(db):
    """Where the store keeps usage counters, ``prompt_cache_generation`` among them."""
    return db.usage if native() else db


def compression_tip(db, session_id: str) -> str | None:
    """The live end of the session's compression chain; the session itself when nothing continued it."""
    return db.lineage.tip(session_id) if native() else db.get_compression_tip(session_id)


def conversation(db, session_id: str) -> list[dict]:
    """The session's active transcript as replayable model messages, role alternation repaired."""
    if native():
        from persistence.conversation.messages import ConversationRequest

        return [message.as_openai_message() for message in db.messages.read_conversation(session_id, ConversationRequest(repair_alternation=True))]
    return db.get_messages_as_conversation(session_id, repair_alternation=True)


def transcript(db, session_id: str) -> list[dict]:
    """The session's active transcript rows with their row ids."""
    if native():
        from persistence.conversation.messages import TranscriptRead

        return [row.as_wire_row() for row in db.messages.read_transcript(session_id, TranscriptRead())]
    return db.get_messages(session_id)


def canonical_bot_chat_row(db) -> tuple[str, dict] | None:
    """Bot Mode's registry title and the row titled exactly that, or None (no such row, or an Agent without Bot Mode)."""
    if native():
        from persistence.conversation.sessions import CANONICAL_BOT_CHAT_TITLE as title

        record = db.sessions.get_by_title(title)
        return None if record is None else (title, record.as_session_row())
    title = getattr(type(db), "CANONICAL_BOT_CHAT_TITLE", None)
    row = db.get_session_by_title(title) if title else None
    return (title, row) if row else None


def decode_content(content):
    """A stored message's content with the Agent's JSON-encoded multimodal parts decoded; anything else unchanged."""
    if native():
        from session_rules.turns import decode_content as decode

        return decode(content)
    from hermes_state import SessionDB

    return SessionDB._decode_content(content)
