"""TAL-213: ``profiles.list`` carries each profile's Bot Mode identity and canonical Bot Chat, read-only."""

from __future__ import annotations

import pathlib
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, assert_matches, isolated_env, requires_agent

# Seeds one profile's state.db through the Agent's own writer: argv = agent dir, state.db, scenario.
_SEED = r"""
import pathlib, sys
sys.path.insert(0, sys.argv[1])
from hermes_state import SessionDB
db = SessionDB(pathlib.Path(sys.argv[2]))
scenario = sys.argv[3]
def chat(sid, title, source="tui"):
    db.create_session(sid, source=source)
    db.append_message(sid, role="user", content="hello")
    db.set_session_title(sid, title)
if scenario == "canonical":
    chat("scout-root", "Bot Chat")
    db.set_session_hidden("scout-root", True)
    db.end_session("scout-root", "compression")
    db.create_session("scout-tip", source="tui", parent_session_id="scout-root")
    db.append_message("scout-tip", role="user", content="continued")
    chat("scout-side", "Side chat")
    db.set_session_hidden("scout-side", True)
elif scenario == "near-titles":
    chat("default-near", "Bot Chat 2")
    chat("default-case", "bot chat")
elif scenario == "archived":
    chat("retired-chat", "Bot Chat")
    db.set_session_archived("retired-chat", True)
elif scenario == "worker":
    chat("worker-chat", "Bot Chat", source="tool")
db.close()
"""


def _seed(home: pathlib.Path, scenario: str) -> None:
    home.mkdir(parents=True, exist_ok=True)
    subprocess.run([AGENT_PYTHON, "-c", _SEED, str(AGENT_DIR), str(home / "state.db"), scenario], check=True, env=isolated_env(home, PATH="/usr/bin:/bin"))


def _db_files(home: pathlib.Path) -> dict[pathlib.Path, tuple[int, int]]:
    """``(mtime_ns, size)`` of every state.db and WAL; the shared-memory index is reader scratch space."""
    return {p: (p.stat().st_mtime_ns, p.stat().st_size) for p in home.rglob("state.db*") if not p.name.endswith("-shm")}


def _rows(proc: SidecarProcess, base: pathlib.Path) -> dict[str, dict]:
    result = proc.result("profiles.list", {"base_home": str(base)})
    assert_matches("profiles.list", result)
    return {row["name"]: row for row in result["profiles"]}


@requires_agent
def test_profiles_list_reports_identity_and_canonical_bot_chat_per_profile(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    profiles = hermes_home / "profiles"
    scout, retired, worker, broken, older = (profiles / n for n in ("scout", "retired", "worker", "broken", "older"))
    _seed(hermes_home, "near-titles")
    _seed(scout, "canonical")
    _seed(retired, "archived")
    _seed(worker, "worker")
    broken.mkdir(parents=True)
    (broken / "state.db").write_bytes(b"not a sqlite database")
    older.mkdir(parents=True)
    named = profiles / "named"
    named.mkdir(parents=True)
    (named / "profile.yaml").write_text("display_name: \"Scout\\n\\u0007" + "x" * 200 + "\"\n", encoding="utf-8")
    (scout / "profile.yaml").write_text(
        "display_name: Scout\ndescription: \"" + "Finds sources. " * 40 + "\"\n"
        "ui_meta:\n  hermes-bots:\n    title: Research lead\n    secret_note: never shipped\n",
        encoding="utf-8",
    )
    (scout / "assets").mkdir()
    (scout / "assets" / "avatar.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    before = _db_files(hermes_home)

    rows = _rows(handshaken, hermes_home)

    assert rows["scout"].get("canonical_session") == {"session_id": "scout-root", "tip_session_id": "scout-tip"}
    assert rows["scout"]["display_name"] == "Research lead"
    assert rows["scout"]["has_avatar"] is True
    assert 0 < len(rows["scout"]["description"]) <= 280 and rows["scout"]["description"].startswith("Finds sources.")
    assert rows["named"]["display_name"].startswith("Scout x") and len(rows["named"]["display_name"]) == 80
    assert rows["named"]["canonical_session"] is None
    assert "secret_note" not in rows["scout"] and "ui_meta" not in rows["scout"]
    # Exact title only, no other profile's chat or identity, and no chat for archived, worker, unreadable, or missing state.
    for name in ("default", "retired", "worker", "broken", "older"):
        row = rows[name]
        assert row["canonical_session"] is None, name
        assert (row["display_name"], row["description"], row["has_avatar"]) == ("", "", False), name
    # Read-only: no database or WAL content changes (a reader may add an empty WAL), so the archived chat stays archived.
    after = _db_files(hermes_home)
    assert {p: after[p] for p in before} == before
    assert all(size == 0 for p, (_, size) in after.items() if p not in before)
