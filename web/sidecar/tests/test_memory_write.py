"""TAL-784: ``memory.write`` replaces a memory page file only while it still holds what the server read, under the Agent's lock."""

from __future__ import annotations

import fcntl
import hashlib
import pathlib
import queue
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, assert_matches, isolated_env, requires_agent


def _sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes() if path.exists() else b"").hexdigest()


def _agent_adds(home: pathlib.Path, entry: str) -> None:
    """The Agent's memory tool storing ``entry``, as a turn does."""
    code = (
        "import sys; sys.path.insert(0, sys.argv[1]); from tools.memory_tool_store import MemoryStore; "
        "store = MemoryStore(); store.load_from_disk(); result = store.add('memory', sys.argv[2]); assert result.get('success'), result"
    )
    subprocess.run([AGENT_PYTHON, "-c", code, str(AGENT_DIR), entry], check=True, cwd=AGENT_DIR, env=isolated_env(home, PATH="/usr/bin:/bin"), timeout=120)


def _writer(proc: SidecarProcess, home: pathlib.Path):
    def write(section: str, base: str, content: str) -> dict:
        result = proc.result("memory.write", {"profile_home": str(home), "section": section, "base": base, "content": content})
        assert_matches("memory.write", result)
        return result
    return write


@requires_agent
def test_memory_write_refuses_a_save_over_an_entry_the_agent_stored_after_the_read(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    write = _writer(handshaken, hermes_home)
    memory = hermes_home / "memories" / "MEMORY.md"
    _agent_adds(hermes_home, "Entry A: user prefers tabs")
    loaded = _sha256(memory)
    _agent_adds(hermes_home, "Entry B: agent learned the deploy host")
    agent = memory.read_text(encoding="utf-8")
    assert write("memory", loaded, "Entry A: user prefers tabs\n§\nEntry C: typed in Web") == {"written": False}
    assert memory.read_text(encoding="utf-8") == agent
    # A save from the current read writes the page's text as typed.
    assert write("memory", _sha256(memory), f"{agent}\n§\nEntry C: typed in Web") == {"written": True}
    assert memory.read_text(encoding="utf-8") == f"{agent}\n§\nEntry C: typed in Web"
    # A link swapped in for USER.md is a changed file, never followed.
    victim = hermes_home / "victim.txt"
    victim.write_text("untouched", encoding="utf-8")
    (hermes_home / "memories" / "USER.md").symlink_to(victim)
    assert write("user", _sha256(victim), "overwrite") == {"written": False}
    assert victim.read_text(encoding="utf-8") == "untouched"


@requires_agent
def test_memory_write_waits_for_the_agents_lock_file_and_rechecks_under_it(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    memory = hermes_home / "memories" / "MEMORY.md"
    memory.parent.mkdir(parents=True, exist_ok=True)
    memory.write_text("Entry A", encoding="utf-8")
    loaded = _sha256(memory)
    with open(memory.with_name("MEMORY.md.lock"), "a+") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        request_id = handshaken.request("memory.write", {"profile_home": str(hermes_home), "section": "memory", "base": loaded, "content": "Entry A\n§\nEntry C"})
        with pytest.raises(queue.Empty):
            handshaken.next_message(timeout=1.0)
        # An Agent mutation inside its lock, before the save gets it.
        memory.write_text("Entry A\n§\nEntry B", encoding="utf-8")
        fcntl.flock(held, fcntl.LOCK_UN)
    message = handshaken.next_message(timeout=30)
    assert message["id"] == request_id and message["result"] == {"written": False}, message
    assert memory.read_text(encoding="utf-8") == "Entry A\n§\nEntry B"
    # SOUL.md has no Agent lock; its save is the same compare-and-write.
    write = _writer(handshaken, hermes_home)
    soul = hermes_home / "SOUL.md"
    assert write("soul", _sha256(soul), "Be brief.") == {"written": True}
    assert write("soul", _sha256(pathlib.Path("/nonexistent")), "Be terse.") == {"written": False}
    assert soul.read_text(encoding="utf-8") == "Be brief."
    assert not soul.with_name("SOUL.md.lock").exists()
