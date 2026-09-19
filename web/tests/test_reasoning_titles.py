"""Reasoning-title contract shared by local and Gateway-backed chat."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

import api.reasoning_titles as reasoning_titles

from api.reasoning_titles import normalize_reasoning_titles, reasoning_event_payload
from api.gateway_chat import _gateway_tool_progress_event
from api.routes import (
    _anchor_scene_content_rows,
    _anchor_scene_message_reasoning_titles,
    _anchor_scene_thinking_row,
    _complete_hydrated_anchor_scene,
)
from api.streaming import _build_partial_message


ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def _js_function(source: str, name: str) -> str:
    start = source.index(f"function {name}")
    brace = source.index("{", start)
    depth = 0
    for index in range(brace, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(f"function {name} body not found")


def test_explicit_titles_override_derived_titles():
    assert normalize_reasoning_titles(
        "**Derived title**\nMore detail",
        explicit_titles=["Gateway title", "Gateway title", "Second title"],
        stable=True,
    ) == ["Gateway title", "Second title"]


def test_explicit_empty_titles_clear_the_snapshot_without_deriving_fallback():
    assert normalize_reasoning_titles(
        "Derived fallback",
        explicit_titles=[],
        stable=True,
    ) == []
    assert reasoning_event_payload(
        "later delta",
        "Derived fallback\nlater delta",
        explicit_titles=[],
    ) == {"text": "later delta", "titles": []}
    partial = _build_partial_message("", "Derived fallback", [], [])
    assert partial["reasoning_titles"] == []


def test_present_malformed_title_snapshots_fail_closed():
    assert _anchor_scene_message_reasoning_titles({
        "reasoning": "Derived fallback",
        "reasoning_titles": None,
    }) == []
    rows = _anchor_scene_content_rows(
        {
            "content": [
                {"type": "reasoning", "text": "Derived fallback", "titles": None},
                {"type": "tool_use", "id": "call-1", "name": "read_file"},
            ]
        },
        0,
        1,
    )
    thinking = next(row for row in rows if row["role"] == "thinking")
    assert thinking["thinking"]["titles"] == []


def test_hydration_prefers_authoritative_segmented_title_rows():
    messages = [
        {"role": "user", "content": "question"},
        {
            "role": "assistant",
            "content": "answer",
            "reasoning": "first detail\nsecond detail",
            "reasoning_titles": ["Repeated title"],
        },
    ]
    scene = {
        "version": "activity_scene_v1",
        "mode": "compact_worklog",
        "activity_rows": [
            {
                "row_id": "reasoning-1",
                "local_id": "reasoning-1",
                "role": "thinking",
                "kind": "reasoning",
                "source_event_type": "reasoning",
                "status": "completed",
                "text": "first detail",
                "group": {"group_key": "segment:1", "activity_segment_seq": 1},
                "thinking": {"text": "first detail", "titles": ["Repeated title"]},
                "payload": {"text": "first detail", "titles": ["Repeated title"]},
            },
            {
                "row_id": "tool-1",
                "local_id": "tool-1",
                "role": "tool",
                "kind": "tool_completed",
                "source_event_type": "tool_complete",
                "status": "completed",
                "tool_call_id": "call-1",
                "tool": {"id": "call-1", "name": "read_file", "done": True},
                "payload": {"id": "call-1", "name": "read_file"},
            },
            {
                "row_id": "reasoning-2",
                "local_id": "reasoning-2",
                "role": "thinking",
                "kind": "reasoning",
                "source_event_type": "reasoning",
                "status": "completed",
                "text": "second detail",
                "group": {"group_key": "segment:2", "activity_segment_seq": 2},
                "thinking": {"text": "second detail", "titles": ["Repeated title"]},
                "payload": {"text": "second detail", "titles": ["Repeated title"]},
            },
        ],
    }
    hydrated = _complete_hydrated_anchor_scene(messages, scene, 1)
    assert [row["role"] for row in hydrated["activity_rows"]] == ["thinking", "tool", "thinking"]
    assert [
        row["text"] for row in hydrated["activity_rows"] if row["role"] == "thinking"
    ] == ["first detail", "second detail"]


def test_complete_bold_titles_are_ordered_and_deduplicated_while_streaming():
    text = "**Planning implementation**\nnotes\n**Running tests**\n**Planning implementation**"
    assert normalize_reasoning_titles(text) == ["Planning implementation", "Running tests"]


def test_plain_title_waits_for_a_stable_boundary():
    partial = "Planning temporary script implementation"
    assert normalize_reasoning_titles(partial) == []
    assert normalize_reasoning_titles(partial, stable=True) == [partial]
    assert normalize_reasoning_titles(partial + "\nmore detail") == [partial]


def test_title_length_is_bounded_for_unbroken_text():
    title = normalize_reasoning_titles("x" * 81, stable=True)
    assert title == ["x" * 80]


@pytest.mark.parametrize(
    "unsafe",
    [
        "My password is swordfish.",
        "SSN 123-45-6789 belongs to the user.",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        "Private tool output: customer email user@example.com",
    ],
)
def test_sensitive_reasoning_never_becomes_a_derived_or_explicit_title(unsafe):
    assert normalize_reasoning_titles(unsafe, stable=True) == []
    assert normalize_reasoning_titles("", explicit_titles=[unsafe]) == []


def test_unsafe_or_unusable_lines_do_not_become_titles():
    rejected = [
        "```python\nprint('no')\n```",
        "$ rm -rf ./tmp",
        '{"cmd":"git status"}',
        "<tool_call><arg>secret</arg></tool_call>",
        "x" * 500,
        "   ",
        "npm test -- --runInBand",
        "./scripts/test.sh tests/test_reasoning_titles.py",
        "API_KEY=secret pytest -q",
    ]
    for text in rejected:
        assert normalize_reasoning_titles(text, stable=True) == []


def test_bold_commands_inside_code_fences_are_not_titles():
    text = """```bash
**npm test -- --runInBand**
```
"""
    assert normalize_reasoning_titles(text, stable=True) == []


def test_reasoning_event_payload_keeps_legacy_text_and_adds_optional_snapshot():
    assert reasoning_event_payload("delta", "unfinished") == {"text": "delta"}
    assert reasoning_event_payload(
        "\n",
        "Planning temporary script implementation\n",
        stable=True,
    ) == {
        "text": "\n",
        "titles": ["Planning temporary script implementation"],
    }


def test_unstable_reasoning_payload_derivation_is_incremental(monkeypatch):
    observed_lengths = []

    def fake_normalize(text, **_kwargs):
        observed_lengths.append(len(text))
        return []

    monkeypatch.setattr(reasoning_titles, "normalize_reasoning_titles", fake_normalize)
    cumulative = "x" * 50_000
    for _ in range(50_000):
        reasoning_titles.reasoning_event_payload("x", cumulative)

    assert sum(observed_lengths) == 50_000


def test_gateway_bridge_accepts_future_explicit_titles():
    assert _gateway_tool_progress_event({
        "event": "reasoning.available",
        "text": "**Derived title**",
        "titles": ["Gateway title"],
    }) == ("reasoning", {"text": "**Derived title**", "titles": ["Gateway title"]})
    assert _gateway_tool_progress_event({
        "event": "reasoning.available",
        "titles": [],
    }) == ("reasoning", {"text": "", "titles": []})


def test_persisted_thinking_row_carries_titles_additively():
    row = _anchor_scene_thinking_row(
        "**Planning implementation**\nDetails",
        0,
        1,
        "stream-1",
    )
    assert row["thinking"]["titles"] == ["Planning implementation"]
    assert row["payload"]["titles"] == ["Planning implementation"]

    title_only = _anchor_scene_thinking_row(
        "",
        0,
        1,
        "stream-1",
        ["Gateway title"],
    )
    assert title_only["text"] == ""
    assert title_only["thinking"]["titles"] == ["Gateway title"]

    explicit_clear = _anchor_scene_thinking_row(
        "Fallback title",
        0,
        1,
        "stream-1",
        [],
        titles_present=True,
    )
    assert explicit_clear["thinking"]["titles"] == []
    assert explicit_clear["payload"]["titles"] == []
