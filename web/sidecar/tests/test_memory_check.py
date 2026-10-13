"""TAL-886: ``memory.check`` reads a memory page save the way the Agent's ``MemoryStore`` does, under the profile's limits."""

from __future__ import annotations

from conftest import SidecarProcess, assert_matches, requires_agent


@requires_agent
def test_memory_check_counts_parsed_entries_against_the_profile_limits(handshaken: SidecarProcess, hermes_home) -> None:
    def check(target: str, content: str) -> dict:
        result = handshaken.result("memory.check", {"profile_home": str(hermes_home), "target": target, "content": content})
        assert_matches("memory.check", result)
        return result

    # The Agent's parser drops padding and empty entries; the defaults apply without a config.
    assert check("memory", "  first  \n§\n\n§\nsecond\n") == {"count": len("first\n§\nsecond"), "limit": 2200}
    assert check("user", "x" * 1400) == {"count": 1400, "limit": 1375}
    # Repeated entries count once, as the store deduplicates them.
    assert check("user", "\n§\n".join(["y" * 1000] * 3)) == {"count": 1000, "limit": 1375}
    (hermes_home / "config.yaml").write_text("memory:\n  memory_char_limit: 40\n  user_char_limit: '30'\n", encoding="utf-8")
    assert check("memory", "User prefers tabs\n§\n" + "x" * 50) == {"count": 70, "limit": 40}
    assert check("user", "short") == {"count": 5, "limit": 30}
