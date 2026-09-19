"""Regression coverage for #6068 per-turn used-model footer instrumentation."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from api.models import Session


REPO = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
STREAMING_PY = (REPO / "api" / "streaming.py").read_text(encoding="utf-8")
MODELS_PY = (REPO / "api" / "models.py").read_text(encoding="utf-8")
def _run_node(source: str) -> str:
    result = subprocess.run(
        [NODE],
        input=source,
        cwd=str(REPO),
        capture_output=True,
        encoding="utf-8",
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def test_streaming_stamps_used_model_on_assistant_message_and_usage_payload():
    assert "_dm['_usedModel'] = _used_model" in STREAMING_PY
    # The served model must be read from the agent AFTER the run — the agent
    # mutates agent.model when a fallback fires, so the pre-run resolved_model
    # would mis-attribute fallback turns.
    assert "_used_model = getattr(agent, 'model', None) or resolved_model or model" in STREAMING_PY
    assert "usage['used_model'] = _used_model" in STREAMING_PY


def test_models_allowlist_round_trips_used_model_across_save_reload():
    assert '"_usedModel"' in MODELS_PY
    assert "_usedModel" in MODELS_PY.split("_SESSION_MESSAGE_DISPLAY_METADATA_KEYS")[1].split(")")[0]

    session = Session(session_id="6068usedmodel", title="Used model")
    session.messages = [
        {
            "role": "assistant",
            "content": "done",
            "_firstTokenMs": 250,
            "_usedModel": "gpt-5-mini",
        },
    ]
    session.save()

    reloaded = Session.load("6068usedmodel")
    assert reloaded.messages[-1]["_usedModel"] == "gpt-5-mini"
    assert reloaded.messages[-1]["_firstTokenMs"] == 250
