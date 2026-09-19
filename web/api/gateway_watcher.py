"""
Hermes Web UI -- Gateway session watcher.

Background daemon thread that polls state.db every 5 seconds for changes
to gateway sessions (telegram, discord, slack, etc.). When changes are
detected, it pushes notifications to all subscribed SSE clients.

This enables real-time session list updates in the sidebar without
requiring any changes to hermes-agent.
"""
import hashlib
import logging
import os
import queue
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path

from api.config import HOME
from api.agent_sessions import open_state_db_readonly, read_importable_agent_session_rows

logger = logging.getLogger(__name__)


# ── State hash tracking ─────────────────────────────────────────────────────

def _snapshot_hash(sessions: list) -> str:
    """Create a lightweight hash of session IDs and timestamps for change detection."""
    key = '|'.join(
        f"{s['session_id']}:{s.get('updated_at', 0)}:{s.get('message_count', 0)}"
        for s in sorted(sessions, key=lambda x: x['session_id'])
    )
    return hashlib.md5(key.encode(), usedforsecurity=False).hexdigest()


def _cheap_change_fingerprint(db_path: Path, *, on_error=None) -> str | None:
    """Return an O(1) change signal for ``state.db``, or ``None`` when unreadable.

    Two ``MAX(rowid)`` index lookups — the trick already used by
    ``api.models._sqlite_content_fingerprint`` — plus the file stamps of the DB
    and its WAL. The cost is constant: unlike the per-row ``sessions`` hash and
    the ``COUNT``/``MAX(timestamp)`` messages join this replaces, it does not
    grow with session or message count, so an idle server no longer pays for the
    whole store every five seconds (HWEB-41, superseding the #3506 fingerprint).

    ``MAX(rowid)`` advances on every INSERT. The file stamps move on every
    commit, which covers the in-place UPDATEs (a title rename, an archive flag,
    a ``role`` retag) and the mid-table DELETEs that ``MAX(rowid)`` alone cannot
    see.

    That stamp coverage is very good but not total: in WAL mode a checkpoint can
    restart the WAL at a size the file already had, and the main-file change
    counter only advances at checkpoint, so a pure UPDATE in that window is
    visible solely through mtime — which collides on a coarse-granularity
    filesystem (the failure mode already documented in ``api/models.py``). The
    bounded ``GatewayWatcher.PROJECTION_PARITY_INTERVAL`` projection exists for
    exactly that residue; it is not on the hot path.

    Unlike the old fingerprint this is not scoped to sidebar-visible sources, so
    cron/webui write churn invalidates it too. That costs one bounded projection
    while those sources are being written, never an unbounded scan, and
    ``_snapshot_hash`` still suppresses the resulting no-op notification.

    Returns ``None`` on any error so the caller falls back to running the full
    projection rather than risk skipping a change; ``on_error`` (when given) is
    called from inside the handler so the failure can be logged with its
    traceback instead of vanishing.
    """
    try:
        parts: list = []
        with closing(open_state_db_readonly(db_path)) as conn:
            for table in ("sessions", "messages"):
                try:
                    row = conn.execute(f"SELECT MAX(rowid) FROM {table}").fetchone()
                except sqlite3.Error:
                    parts.append(None)  # missing/renamed table: stamps still signal
                else:
                    parts.append(row[0] if row else None)
        for path in (db_path, Path(f"{db_path}-wal")):
            try:
                stat = path.stat()
            except OSError:
                parts.append(None)
            else:
                parts.append((stat.st_size, stat.st_mtime_ns))
        # SQLite's file-change counter (header bytes 24:28) advances on every
        # rollback-journal commit. In WAL mode it only moves at checkpoint, but
        # there the WAL grows by a frame per commit, so the pair covers both
        # journal modes without leaning on filesystem mtime granularity — the
        # collision that already flaked ``gateway_sync`` (see api/models.py).
        try:
            with open(db_path, 'rb') as fh:
                header = fh.read(28)
        except OSError:
            parts.append(None)
        else:
            parts.append(int.from_bytes(header[24:28], 'big') if len(header) >= 28 else None)
        return repr(parts)
    except Exception:
        if on_error is not None:
            on_error("change check failed")
        return None


# ── DB resolution (shared pattern with state_sync.py) ──────────────────────

def _get_state_db_path(hermes_home: Path | None = None) -> Path:
    """Resolve state.db path for the active profile."""
    if hermes_home is not None:
        return Path(hermes_home).expanduser().resolve() / 'state.db'
    try:
        from api.profiles import get_active_hermes_home
        hermes_home = Path(get_active_hermes_home()).expanduser().resolve()
    except Exception:
        hermes_home = Path(os.getenv('HERMES_HOME', str(HOME / '.hermes'))).expanduser().resolve()
    return hermes_home / 'state.db'


def _get_agent_sessions_from_db(db_path: Path | None = None, *, on_error=None) -> list | None:
    """Read all non-webui sessions from state.db.

    Returns a list of session dicts (including an empty list for a successful
    empty projection), or ``None`` when the projection fails. A failure here is
    the watcher's main silent-death mode (a schema change, a permission error),
    so ``on_error`` — called from inside the handler — is how it reaches the log
    with its traceback rather than being swallowed into ``None``.
    """
    db_path = Path(db_path) if db_path is not None else _get_state_db_path()
    if not db_path.exists():
        return []

    try:
        sessions = []
        for row in read_importable_agent_session_rows(db_path, limit=200, log=logger):
            sessions.append({
                'session_id': row['id'],
                'title': row['title'] or 'Agent Session',
                'model': row['model'] or None,
                'message_count': row['message_count'] or row['actual_message_count'] or 0,
                'created_at': row['started_at'],
                'updated_at': row['last_activity'] or row['started_at'],
                'source': row['source'] or 'cli',
                'raw_source': row.get('raw_source'),
                'session_source': row.get('session_source'),
                'source_label': row.get('source_label'),
            })
        return sessions
    except Exception:
        if on_error is not None:
            on_error("session projection failed")
        return None


# ── GatewayWatcher ──────────────────────────────────────────────────────────

class GatewayWatcher:
    """Background thread that polls state.db for agent session changes.

    Usage:
        watcher = GatewayWatcher()
        watcher.start()
        q = watcher.subscribe()
        # ... receive change events via q.get() ...
        watcher.unsubscribe(q)
        watcher.stop()
    """

    POLL_INTERVAL = 5  # seconds between polls
    # Backstop for the one gap the O(1) fingerprint cannot close: a pure UPDATE
    # committed into a post-checkpoint WAL that neither grows the file nor moves
    # the main-file change counter, on a filesystem whose mtime granularity
    # hides it. Rare enough to run 5x less often than the 60s pass it replaces,
    # and it never runs on the hot path — only when the fingerprint says idle.
    PROJECTION_PARITY_INTERVAL = 300.0
    # A watcher failure that stays at debug stops the sidebar updating with
    # nothing in the log; one that logs every 5s tick floods it. Rate limit the
    # warning to this interval instead of choosing one of those.
    ERROR_LOG_INTERVAL = 60.0
    SUBSCRIBER_TIMEOUT = 30  # seconds before sending keepalive comment

    def __init__(
        self,
        *,
        hermes_home: Path | None = None,
        profile_name: str | None = None,
        state_db_path: Path | None = None,
    ):
        self._subscribers: list[queue.Queue] = []
        self._sub_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._hermes_home = Path(hermes_home).expanduser().resolve() if hermes_home else None
        self._state_db_path = (
            Path(state_db_path).expanduser().resolve()
            if state_db_path is not None
            else _get_state_db_path(self._hermes_home) if self._hermes_home is not None else _get_state_db_path()
        )
        self.profile_name = profile_name or ""
        self._last_hash: str = ''
        self._last_sessions: list = []
        # O(1) fingerprint from the previous poll. When it is unchanged nothing
        # was committed to state.db and we skip the expensive projection
        # entirely. Empty string forces the first poll to run the full read.
        self._last_cheap_fp: str = ''
        self._last_full_projection_at: float | None = None
        self._last_error_log_at: float = float('-inf')

    def start(self):
        """Start the watcher daemon thread."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._poll_loop, daemon=True, name='gateway-watcher')
        self._thread.start()

    def is_alive(self) -> bool:
        """Return True when the poll thread is running.

        Public accessor used by ``/api/sessions/gateway/stream`` probe mode and
        the live SSE handler to detect a watcher instance whose poll thread
        died silently (e.g. uncaught exception in ``_poll_loop``).  Callers
        use this to decide whether to return 503 and trigger the client-side
        polling fallback, instead of handing out an SSE connection that would
        never emit events.
        """
        t = self._thread
        return t is not None and t.is_alive()

    def stop(self):
        """Stop the watcher thread."""
        self._stop_event.set()
        # Wake up any subscribers
        with self._sub_lock:
            for q in self._subscribers:
                try:
                    q.put(None)  # sentinel
                except Exception:
                    logger.debug("Failed to send sentinel to subscriber")
        if self._thread:
            self._thread.join(timeout=3)
            self._thread = None

    def subscribe(self) -> queue.Queue:
        """Subscribe to change events. Returns a queue.Queue.
        Events are dicts: {'type': 'sessions_changed', 'sessions': [...]}
        A None sentinel means the watcher is stopping.
        """
        q = queue.Queue(maxsize=10)
        with self._sub_lock:
            self._subscribers.append(q)
            # Stop-race safety: if stop() already ran (set _stop_event and drained
            # the then-current subscriber list) before we appended, this queue would
            # never receive the sentinel and the SSE loop would hang open with
            # keepalives but no events. Enqueue the sentinel ourselves so the handler
            # closes and reconnects to the live registry watcher. (#3629 / Codex gate)
            if self._stop_event.is_set():
                try:
                    q.put_nowait(None)
                except Exception:
                    logger.debug("Failed to send stop sentinel to late subscriber")
        return q

    def unsubscribe(self, q: queue.Queue):
        """Remove a subscriber queue."""
        with self._sub_lock:
            try:
                self._subscribers.remove(q)
            except ValueError:
                pass

    def _notify_subscribers(self, sessions: list):
        """Push change event to all subscribers."""
        event = {
            'type': 'sessions_changed',
            'sessions': sessions,
        }
        with self._sub_lock:
            dead = []
            for q in self._subscribers:
                try:
                    q.put_nowait(event)
                except queue.Full:
                    dead.append(q)  # remove slow consumers
                except Exception:
                    dead.append(q)
            for q in dead:
                try:
                    self._subscribers.remove(q)
                except ValueError:
                    pass
                # Send a None sentinel so the SSE handler unblocks, closes,
                # and lets the browser's EventSource auto-reconnect.
                try:
                    q.put_nowait(None)
                except Exception:
                    logger.debug("Failed to send sentinel to dead subscriber")

    def _warn_failure(self, reason: str):
        """Surface a watcher failure at warning, rate limited, with its traceback.

        Must be called from inside an ``except`` handler so ``exc_info`` resolves.
        Every failure path routes here — the poll loop, the change check, and the
        session projection, which is the one that actually swallows a schema or
        permission error into ``None`` and stalls the sidebar silently.
        """
        now = time.monotonic()
        if now - self._last_error_log_at >= self.ERROR_LOG_INTERVAL:
            self._last_error_log_at = now
            logger.warning(
                "Gateway watcher %s for %s; the session sidebar will not update "
                "until it recovers",
                reason,
                self._state_db_path,
                exc_info=True,
            )
        else:
            logger.debug("Gateway watcher %s", reason, exc_info=True)

    def _poll_once(self, *, now: float | None = None) -> bool:
        """Run one change-detection pass and report whether projection ran.

        The expensive projection runs when the O(1) fingerprint moved (or could
        not be read, in which case we fail closed and project), plus one bounded
        parity pass per ``PROJECTION_PARITY_INTERVAL`` as the backstop described
        on ``_cheap_change_fingerprint``.
        """
        db_path = self._state_db_path
        # A watcher may start before the agent has created state.db. Publishing an
        # empty first snapshot would make an already-rendered sidebar disappear;
        # wait for the first real database instead. If a previously observed DB
        # disappears, the normal projection path still publishes that change.
        if (
            not db_path.exists()
            and self._last_full_projection_at is None
            and not self._last_hash
        ):
            return False

        cheap_fp = (
            _cheap_change_fingerprint(db_path, on_error=self._warn_failure)
            if db_path.exists()
            else ''
        )
        current_time = time.monotonic() if now is None else now
        parity_due = (
            self._last_full_projection_at is None
            or current_time - self._last_full_projection_at
            >= self.PROJECTION_PARITY_INTERVAL
        )
        if cheap_fp is not None and cheap_fp == self._last_cheap_fp and not parity_due:
            return False

        sessions = _get_agent_sessions_from_db(db_path, on_error=self._warn_failure)
        if sessions is None:
            return False
        current_hash = _snapshot_hash(sessions)
        if cheap_fp is not None:
            self._last_cheap_fp = cheap_fp
        self._last_full_projection_at = current_time

        if current_hash != self._last_hash:
            self._last_hash = current_hash
            self._last_sessions = sessions
            self._notify_subscribers(sessions)
        return True

    def _poll_loop(self):
        """Main polling loop. Runs in a daemon thread."""
        while not self._stop_event.is_set():
            try:
                self._poll_once()
            except Exception:
                self._warn_failure("poll loop raised")

            # Sleep in small increments so we can stop promptly
            for _ in range(self.POLL_INTERVAL * 10):
                if self._stop_event.is_set():
                    return
                time.sleep(0.1)


# ── Module-level watcher registry ──────────────────────────────────────────

_watchers: dict[str, GatewayWatcher] = {}
_watcher_lock = threading.Lock()

def _resolve_watcher_target(
    *,
    profile_name: str | None = None,
    hermes_home: Path | None = None,
) -> tuple[str, Path | None]:
    """Resolve the watcher profile/home pair for the current request context."""
    resolved_profile = str(profile_name or "").strip()
    resolved_home = Path(hermes_home).expanduser().resolve() if hermes_home is not None else None

    try:
        from api.profiles import get_active_profile_name, get_hermes_home_for_profile

        if not resolved_profile:
            resolved_profile = get_active_profile_name() or "default"
        if resolved_home is None and resolved_profile:
            resolved_home = Path(get_hermes_home_for_profile(resolved_profile)).expanduser().resolve()
    except Exception:
        if resolved_home is None:
            try:
                resolved_home = _get_state_db_path().parent.resolve()
            except Exception:
                resolved_home = None

    return resolved_profile, resolved_home


def _watcher_registry_key(profile_name: str | None = None, hermes_home: Path | None = None) -> str:
    """Return the stable registry key for a watcher target."""
    if hermes_home is not None:
        return str(Path(hermes_home).expanduser().resolve())
    return str(profile_name or "").strip() or "__default__"


def _watcher_has_subscribers(watcher: GatewayWatcher) -> bool:
    subscribers = getattr(watcher, "_subscribers", None)
    sub_lock = getattr(watcher, "_sub_lock", None)
    if subscribers is None or sub_lock is None:
        return False
    with sub_lock:
        return bool(subscribers)


def _pop_idle_watchers_locked(*, exclude_key: str) -> list[GatewayWatcher]:
    stale: list[GatewayWatcher] = []
    for key, watcher in list(_watchers.items()):
        if key == exclude_key or _watcher_has_subscribers(watcher):
            continue
        if _watchers.get(key) is watcher:
            stale.append(_watchers.pop(key))
    return stale


def start_watcher(*, profile_name: str | None = None, hermes_home: Path | None = None):
    """Start the watcher for the resolved profile home (idempotent)."""
    resolved_profile, resolved_home = _resolve_watcher_target(
        profile_name=profile_name,
        hermes_home=hermes_home,
    )
    key = _watcher_registry_key(resolved_profile, resolved_home)
    with _watcher_lock:
        watcher = _watchers.get(key)
        if watcher is None or not watcher.is_alive():
            if watcher is not None:
                watcher.stop()
            watcher = GatewayWatcher(profile_name=resolved_profile, hermes_home=resolved_home)
            watcher.start()
            _watchers[key] = watcher
        return watcher


def stop_watcher(*, profile_name: str | None = None, hermes_home: Path | None = None):
    """Stop either one profile watcher or the entire registry."""
    with _watcher_lock:
        if profile_name is None and hermes_home is None:
            watchers = list(_watchers.values())
            _watchers.clear()
        else:
            resolved_profile, resolved_home = _resolve_watcher_target(
                profile_name=profile_name,
                hermes_home=hermes_home,
            )
            key = _watcher_registry_key(resolved_profile, resolved_home)
            watcher = _watchers.pop(key, None)
            watchers = [watcher] if watcher is not None else []
    for watcher in watchers:
        watcher.stop()


def restart_watcher_for_profile(name: str):
    """Restart only the watcher pinned to the target profile home."""
    from api.profiles import get_hermes_home_for_profile

    hermes_home = Path(get_hermes_home_for_profile(name)).expanduser().resolve()
    key = _watcher_registry_key(name, hermes_home)
    watcher = GatewayWatcher(profile_name=name, hermes_home=hermes_home)
    watcher.start()
    with _watcher_lock:
        existing = _watchers.pop(key, None)
        stale_watchers = [] if existing is not None else _pop_idle_watchers_locked(exclude_key=key)
        _watchers[key] = watcher
    for old_watcher in ([existing] if existing is not None else stale_watchers):
        old_watcher.stop()
    return watcher


def get_watcher(*, profile_name: str | None = None, hermes_home: Path | None = None) -> GatewayWatcher | None:
    """Get or lazily start the watcher for the resolved request profile."""
    resolved_profile, resolved_home = _resolve_watcher_target(
        profile_name=profile_name,
        hermes_home=hermes_home,
    )
    key = _watcher_registry_key(resolved_profile, resolved_home)
    with _watcher_lock:
        watcher = _watchers.get(key)
    if watcher is None or not watcher.is_alive():
        watcher = start_watcher(profile_name=resolved_profile, hermes_home=resolved_home)
    return watcher
