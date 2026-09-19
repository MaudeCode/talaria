"""HWEB-93: the bisect-indexed chronological insert must match the linear scan.

The reference below is the pre-HWEB-93 implementation verbatim. The indexed
helper must produce the same list and the same return value across interleaved
caller appends and inserts, including duplicate/None timestamps and tool blocks.
"""

import random

from api.models import (
    _ChronologicalInsertIndex,
    _insert_state_message_chronologically,
    _message_timestamp_as_float,
    _tool_call_assistant_should_precede_content_assistant,
)


def _reference_insert(messages: list, msg: dict) -> bool:
    timestamp = _message_timestamp_as_float(msg)
    if timestamp is None:
        messages.append(msg)
        return True
    idx = 0
    while idx < len(messages):
        existing = messages[idx]
        existing_timestamp = _message_timestamp_as_float(existing)
        should_insert = existing_timestamp is not None and (
            existing_timestamp > timestamp
            or (
                existing_timestamp == timestamp
                and (
                    (msg.get("role") == "user" and existing.get("role") == "assistant")
                    or _tool_call_assistant_should_precede_content_assistant(existing, msg)
                )
            )
        )
        if not should_insert:
            idx += 1
            continue
        if idx == 0 and existing_timestamp is not None and existing_timestamp > timestamp:
            return False
        while True:
            advanced = False
            if (
                idx < len(messages)
                and messages[idx].get("role") == "tool"
                and idx > 0
                and messages[idx - 1].get("role") == "assistant"
                and messages[idx - 1].get("tool_calls")
            ):
                while idx < len(messages) and messages[idx].get("role") == "tool":
                    idx += 1
                    advanced = True
            while (
                idx < len(messages)
                and idx > 0
                and messages[idx - 1].get("role") == msg.get("role")
                and _message_timestamp_as_float(messages[idx]) == timestamp
                and not _tool_call_assistant_should_precede_content_assistant(messages[idx], msg)
            ):
                idx += 1
                advanced = True
            if not advanced:
                break
        messages.insert(idx, msg)
        return True
    messages.append(msg)
    return True


def _random_message(rng: random.Random, seq: int) -> dict:
    role = rng.choice(["user", "assistant", "assistant", "tool"])
    msg = {"role": role, "content": f"m{seq}", "timestamp": rng.choice([None, "", *range(0, 12)])}
    if role == "assistant" and rng.random() < 0.5:
        msg["content"] = rng.choice(["", f"m{seq}"])
        msg["tool_calls"] = [{"id": f"call{seq}", "function": {"name": "t", "arguments": "{}"}}]
    if role == "tool":
        msg["tool_call_id"] = f"call{seq}"
    return msg


def test_indexed_insert_matches_linear_reference():
    rng = random.Random(93)
    for _ in range(300):
        ref: list = []
        got: list = []
        index = _ChronologicalInsertIndex()
        for seq in range(rng.randint(1, 40)):
            msg = _random_message(rng, seq)
            if rng.random() < 0.5:
                # Caller-side append, as merge_session_messages_append_only does.
                ref.append(msg)
                got.append(msg)
                continue
            assert _reference_insert(ref, dict(msg)) == _insert_state_message_chronologically(
                got, dict(msg), index=index
            )
            assert [m["content"] for m in got] == [m["content"] for m in ref]
        index.sync(got)
        assert index.timestamps == [_message_timestamp_as_float(m) for m in got]


def test_insert_without_index_still_works():
    messages = [{"role": "user", "content": "a", "timestamp": 5}]
    assert _insert_state_message_chronologically(messages, {"role": "user", "content": "b", "timestamp": 6})
    assert [m["content"] for m in messages] == ["a", "b"]
    assert not _insert_state_message_chronologically(messages, {"role": "user", "content": "c", "timestamp": 1})
    assert [m["content"] for m in messages] == ["a", "b"]

