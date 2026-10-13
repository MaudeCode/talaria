"""``memory.*``: the Agent's ``MemoryStore`` reading of a memory page save (TAL-886)."""

from __future__ import annotations

from ..home import profile_home_param, scoped_home
from ..rpc import CallContext


def check(target: str, content: str) -> dict:
    """``content``'s char count as the Agent's memory tool parses it, and the profile's limit for ``target``."""
    from hermes_cli.config import load_config
    from tools.memory_tool_store import ENTRY_DELIMITER, MemoryStore

    mem = (load_config() or {}).get("memory") or {}
    store = MemoryStore(**{key: int(mem[key]) for key in ("memory_char_limit", "user_char_limit") if mem.get(key) is not None})
    # The store keeps each entry once (first occurrence wins), as its load and write paths do.
    entries = list(dict.fromkeys(MemoryStore._parse_entries(content)))
    return {"count": len(ENTRY_DELIMITER.join(entries)), "limit": store._char_limit(target)}


def register(registry) -> None:
    @registry.method("memory.check")
    def check_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return check(str(params["target"]), str(params["content"]))
