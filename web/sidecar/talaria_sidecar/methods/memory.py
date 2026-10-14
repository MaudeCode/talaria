"""``memory.*``: the Agent's ``MemoryStore`` reading of a memory page save (TAL-886) and its compare-and-write (TAL-784)."""

from __future__ import annotations

import errno
import hashlib
import os
import stat
import threading
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

# Agents without the per-file lock helper: this sidecar's saves still run one at a time.
_SAVE_LOCK = threading.Lock()


def check(target: str, content: str) -> dict:
    """``content``'s char count as the Agent's memory tool parses it, and the profile's limit for ``target``."""
    from hermes_cli.config import load_config
    from tools.memory_tool_store import ENTRY_DELIMITER, MemoryStore

    mem = (load_config() or {}).get("memory") or {}
    store = MemoryStore(**{key: int(mem[key]) for key in ("memory_char_limit", "user_char_limit") if mem.get(key) is not None})
    # The store keeps each entry once (first occurrence wins), as its load and write paths do.
    entries = list(dict.fromkeys(MemoryStore._parse_entries(content)))
    return {"count": len(ENTRY_DELIMITER.join(entries)), "limit": store._char_limit(target)}


def _digest(path: Path) -> str | None:
    """SHA-256 hex of the regular file at ``path`` (of no bytes when there is none), never following a link; None otherwise."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except FileNotFoundError:
        return hashlib.sha256(b"").hexdigest()
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            return None
        raise
    with os.fdopen(fd, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            return None
        return hashlib.sha256(handle.read()).hexdigest()


def write(home: Path, section: str, base: str, content: str) -> dict:
    """Replace ``section``'s file with ``content`` only while its bytes still hash to ``base``, the server's read.

    Each file is checked and written under the Agent's own per-file lock (``<file>.lock``), so neither a memory tool
    call nor a concurrent save can land between the two; an Agent without the lock helper gets this sidecar's lock.
    """
    from tools.memory_tool_store import MemoryStore
    from utils import atomic_write_text

    if section not in ("memory", "user", "soul"):
        raise InvalidParams("section must be memory, user, or soul")
    # The files the server read: SOUL.md in the profile home, MEMORY.md / USER.md in its memories folder.
    path = home / "SOUL.md" if section == "soul" else home / "memories" / ("USER.md" if section == "user" else "MEMORY.md")
    file_lock = getattr(MemoryStore, "_file_lock", None)
    try:
        with file_lock(path) if file_lock else _SAVE_LOCK:
            if _digest(path) != base:
                return {"written": False}
            atomic_write_text(path, content, tmp_prefix=".mem_", preserve_mode=True)
    except OSError as exc:
        if exc.errno not in (errno.EACCES, errno.EPERM, errno.EROFS):
            raise
        raise RpcError(f"{path.name} is not writable: {exc.strerror}", condition="memory_not_writable") from exc
    return {"written": True}


def register(registry) -> None:
    @registry.method("memory.check")
    def check_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return check(str(params["target"]), str(params["content"]))

    @registry.method("memory.write")
    def write_(ctx: CallContext, params: dict) -> dict:
        home = profile_home_param(params)
        with scoped_home(home):
            return write(home, str(params["section"]), str(params["base"]), str(params["content"]))
