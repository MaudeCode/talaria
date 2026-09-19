"""Regression coverage for long-running chat render budgets."""

import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[1]
def _function_source(src: str, name: str) -> str:
    marker = f"function {name}"
    start = src.index(marker)
    if src[max(0, start - 6) : start] == "async ":
        start -= 6
    brace = src.index("{", src.index(")", start))
    depth = 0
    for idx in range(brace, len(src)):
        if src[idx] == "{":
            depth += 1
        elif src[idx] == "}":
            depth -= 1
            if depth == 0:
                return src[start : idx + 1]
    raise AssertionError(f"{name} did not close")


def test_anchor_scene_chunk_endpoint_returns_earlier_rows_without_mutating_storage(monkeypatch):
    from api import routes

    rows = [{"role": "thinking", "row_id": f"row-{idx}", "text": str(idx)} for idx in range(250)]
    scene = {"version": "activity_scene_v1", "activity_rows": rows}
    record = {"message_ref": "a" * 64, "message_index": 7, "scene": scene}
    session = SimpleNamespace(
        profile=None,
        anchor_activity_scenes={"a" * 64: record},
        _loaded_metadata_only=False,
    )
    monkeypatch.setattr(routes, "get_session", lambda _sid: session)
    monkeypatch.setattr(routes, "_session_visible_to_active_profile", lambda *_args: True)
    monkeypatch.setattr(routes, "j", lambda _handler, payload, **_kwargs: payload)
    parsed = SimpleNamespace(
        query=f"session_id=sid&message_ref={'a' * 64}&before=170&limit=80"
    )

    result = routes._handle_get_session_anchor_scene(object(), parsed)

    assert result["start"] == 90
    assert result["end"] == 170
    assert result["total"] == 250
    assert [row["row_id"] for row in result["rows"]] == [f"row-{idx}" for idx in range(90, 170)]
    assert len(scene["activity_rows"]) == 250


def test_session_hydration_sends_preview_while_durable_record_keeps_all_rows():
    from api import routes

    messages = [{"role": "assistant", "content": "done"}]
    ref = routes._assistant_anchor_scene_message_ref(messages[0])
    rows = [
        {"role": "thinking", "row_id": f"row-{idx}", "text": f"step {idx}"}
        for idx in range(250)
    ]
    records = {
        ref: {
            "message_index": 0,
            "message_ref": ref,
            "stream_id": "stream",
            "scene": {"version": "activity_scene_v1", "activity_rows": rows},
        }
    }

    hydrated = routes._hydrate_anchor_activity_scenes(messages, records)
    preview = hydrated[0]["_anchor_activity_scene"]

    assert len(preview["activity_rows"]) == routes._ANCHOR_ACTIVITY_SCENE_PREVIEW_ROWS
    assert preview["activity_rows"][0]["row_id"] == "row-170"
    assert preview["activity_rows_offset"] == 170
    assert preview["activity_rows_total"] == 250
    assert preview["activity_scene_ref"] == ref
    assert len(records[ref]["scene"]["activity_rows"]) == 250
