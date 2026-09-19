"""Logging boundaries for dependencies embedded in the WebUI process."""

from __future__ import annotations

import logging
import os
import shutil
import stat
from pathlib import Path

try:  # pragma: no cover - fcntl is unavailable on Windows.
    import fcntl as _fcntl
except ImportError:  # pragma: no cover
    _fcntl = None

logger = logging.getLogger(__name__)


# Hermes Agent 2026.8.3 can ask a TypeScript language server that does not
# implement textDocument/diagnostic to pull diagnostics for every open file.
# The agent records each expected -32601 response at DEBUG. If any embedded
# component has lowered the process root logger to DEBUG, hundreds of thousands
# of identical records are synchronously written to the WebUI's stderr log and
# can starve unrelated HTTP request threads. WebUI-created agents run in quiet
# mode, so DEBUG from this dependency is never part of the browser contract.
_WEBUI_DEPENDENCY_LOG_FLOORS = {
    "agent.lsp.client": logging.INFO,
}


def install_webui_dependency_log_floors() -> None:
    """Suppress dependency DEBUG floods without hiding warnings or errors.

    Preserve any stricter operator-configured level. Setting the named logger
    (rather than only filtering a handler) makes ``logger.debug`` return before
    allocating and formatting a ``LogRecord``, which is the important hot-path
    protection when the embedded agent emits thousands of repeats per second.
    """

    for logger_name, floor in _WEBUI_DEPENDENCY_LOG_FLOORS.items():
        dependency_logger = logging.getLogger(logger_name)
        configured_level = dependency_logger.level
        if configured_level == logging.NOTSET or configured_level < floor:
            dependency_logger.setLevel(floor)


# ── WebUI log rotation ──────────────────────────────────────────────────────
# bootstrap.py starts the server with stdout/stderr redirected into
# ``{STATE_DIR}/bootstrap-{PORT}.log`` at the file-descriptor level, so nothing
# in-process owns that sink and no ``RotatingFileHandler`` can bound it. On a
# server that runs for weeks the log grows without limit (HWEB-45).
_WEBUI_LOG_MAX_BYTES_ENV = "HERMES_WEBUI_LOG_MAX_BYTES"
_WEBUI_LOG_FILE_ENV = "HERMES_WEBUI_LOG_FILE"
_WEBUI_LOG_DEFAULT_MAX_BYTES = 32 * 1024 * 1024


def _path_for_fd(fd: int) -> Path | None:
    """Where this descriptor actually points, asked of the OS.

    Launchers keep inventing new sinks — ``ctl.sh`` uses ``webui.log``, the WSL
    autostart script ``hermes_webui.log``, a launchd plist its own
    ``StandardOutPath``/``StandardErrorPath`` — and each one that forgets to
    tell us leaves its log unbounded. So do not rely on being told: read the
    descriptor the server is already writing to.

    Returns ``None`` for anything that is not a regular file on disk (a
    terminal, a pipe, ``/dev/null``), and on platforms offering neither probe.
    """
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
    except OSError:
        return None

    resolved: str | None = None
    proc_link = f"/proc/self/fd/{fd}"  # Linux, including WSL
    try:
        if os.path.exists(proc_link):
            resolved = os.readlink(proc_link)
    except OSError:
        resolved = None
    if resolved is None and _fcntl is not None:  # macOS, including launchd
        get_path = getattr(_fcntl, "F_GETPATH", None)
        if get_path is not None:
            try:
                raw = _fcntl.fcntl(fd, get_path, bytes(1024))
                resolved = os.fsdecode(raw.split(b"\0", 1)[0])
            except (OSError, ValueError):
                resolved = None
    if not resolved or not resolved.startswith("/"):
        return None
    # A deleted-but-open sink has nothing worth rotating.
    if resolved.endswith(" (deleted)"):
        return None
    return Path(resolved)


def webui_log_paths() -> list[Path]:
    """Every on-disk sink this server's stdout/stderr is redirected into.

    Usually one file, because most launchers point both descriptors at the same
    place; a launchd plist with separate ``StandardOutPath`` and
    ``StandardErrorPath`` gives two, and both need bounding. An explicit
    ``HERMES_WEBUI_LOG_FILE`` wins, then the descriptors themselves, then
    ``bootstrap.py``'s detached sink.
    """
    from api.config import PORT, STATE_DIR

    configured = os.environ.get(_WEBUI_LOG_FILE_ENV, "").strip()
    if configured:
        override = Path(configured).expanduser()
        # Only an absolute override is authoritative. A relative one was opened
        # by the launcher against *its* cwd, and bootstrap chdirs before we get
        # here, so resolving it now would point at a different file than the one
        # the descriptors are actually writing to. The descriptors always win
        # over a path we cannot resolve the same way its opener did.
        if override.is_absolute():
            return [override]

    found: list[Path] = []
    for fd in (1, 2):
        path = _path_for_fd(fd)
        if path is not None and path not in found:
            found.append(path)
    if found:
        return found
    return [Path(STATE_DIR) / f"bootstrap-{PORT}.log"]


def webui_log_path() -> Path:
    """The primary sink. Kept for callers that want exactly one path."""
    return webui_log_paths()[0]


def _webui_log_max_bytes() -> int:
    raw = os.environ.get(_WEBUI_LOG_MAX_BYTES_ENV, str(_WEBUI_LOG_DEFAULT_MAX_BYTES))
    try:
        return int(raw)
    except (TypeError, ValueError):
        return _WEBUI_LOG_DEFAULT_MAX_BYTES


def rotate_webui_log(
    *,
    path: Path | None = None,
    max_bytes: int | None = None,
) -> bool:
    """Copy-truncate every WebUI log sink that has exceeded its size cap.

    Copy-truncate, not rename: the writers hold an inherited ``O_APPEND``
    descriptor on the open file. Renaming would leave every one of them writing
    into the rotated inode while the new path stayed empty forever. Truncating
    in place is the only rotation a raw inherited descriptor honours — with
    ``O_APPEND`` the kernel recomputes the offset from the file size before each
    write, so the log resumes at zero with no sparse gap.

    One previous generation is kept as ``<log>.1``. Lines written during the
    copy are lost, which is the same trade ``logrotate``'s ``copytruncate``
    makes. Set ``HERMES_WEBUI_LOG_MAX_BYTES`` to ``0`` to disable. Returns
    ``True`` when at least one sink was rotated.
    """
    limit = _webui_log_max_bytes() if max_bytes is None else int(max_bytes)
    if limit <= 0:
        return False
    targets = [Path(path)] if path is not None else webui_log_paths()
    # Materialize before reducing: `any()` over a generator short-circuits, and
    # a launchd plist's second sink would never be rotated once the first was.
    rotated = [_rotate_one(target, limit) for target in targets]
    return any(rotated)


def _rotate_one(target: Path, limit: int) -> bool:
    """Rotate a single sink, operating on one descriptor throughout.

    The whole check-copy-truncate sequence runs against the descriptor opened
    here, never by re-resolving the path. An external rotator (``newsyslog``,
    ``logrotate``) that renames the file mid-sequence would otherwise have this
    truncate land on a *fresh* replacement log while the server kept writing,
    unbounded, to the old inode.
    """
    try:
        fd = os.open(target, os.O_RDWR)
    except OSError:
        return False
    try:
        with os.fdopen(fd, "r+b") as fh:
            size = os.fstat(fh.fileno()).st_size
            if size <= limit:
                return False
            previous = target.with_name(target.name + ".1")
            with open(previous, "wb") as dst:
                shutil.copyfileobj(fh, dst)
            # Same descriptor, so this is certainly the inode just copied.
            os.ftruncate(fh.fileno(), 0)
    except OSError:
        logger.warning("Could not rotate the WebUI log at %s", target, exc_info=True)
        return False
    logger.info(
        "Rotated the WebUI log at %s (%d bytes) into %s", target, size, previous
    )
    return True
