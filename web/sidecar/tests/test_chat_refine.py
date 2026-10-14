"""TAL-902: ``chat.refine`` starts the Agent's memory/skill review of the session's conversation on its agent, with the
upstream ``/refine`` arguments, and the review's writes land in the session's profile."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

pytestmark = requires_agent

MESSAGES = [{"role": "user", "content": "deploy with the blue script"}, {"role": "assistant", "content": "deployed"}]
STARTED = "⚗ Reviewing this conversation in the background{} — any memory/skill updates will be reported when done."


def test_refine_reviews_the_conversation_on_the_session_agent_in_its_profile(tmp_path: Path) -> None:
    root = tmp_path / ".hermes"
    alpha = root / "profiles" / "alpha"
    alpha.mkdir(parents=True)
    (alpha / ".env").write_text("ALPHA_ONLY=alpha\n")
    probe = Path(__file__).with_name("refine_probe.py")
    run = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR)], env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    out = json.loads(run.stdout.strip().splitlines()[-1])
    profile = {"home": str(alpha), "secret": "alpha"}
    review = {"messages_snapshot": MESSAGES, "review_memory": True, "explicit": True, "at_call": profile, "in_fork": profile}
    assert out["cached"] == {
        "output": STARTED.format(" (focus: keep deploy steps)"),
        "reviews": [{**review, "review_skills": True, "focus": "keep deploy steps"}],
        "built": 0,
    }
    # Without a cached agent the session gets the one its turn would build, cached for that turn.
    assert out["built"] == {
        "output": STARTED.format(""),
        "reviews": [{**review, "review_skills": False, "focus": None}],
        "kwargs": {"model": "gpt-5.4", "provider": "openai-codex", "enabled_toolsets": ["memory"], "max_iterations": 7, "session_id": "fresh"},
        "cached_for_turn": True,
        "held": 0,
    }
    assert out["running"] == {"output": "Agent is running — wait for the turn to finish, then /refine.", "reviews": [], "claimed": False, "held": 0}
    assert out["empty"] == {"output": "Nothing to refine yet — the conversation is empty.", "reviews": []}
