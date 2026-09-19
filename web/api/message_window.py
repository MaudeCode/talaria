"""Shared bounded transcript-window helpers for WebUI display payloads."""

import json

from api.models import _is_empty_partial_activity_message


def message_counts_as_renderable(message) -> bool:
    """Return true when a bounded display window should count this row."""
    if not isinstance(message, dict):
        return False
    if _is_empty_partial_activity_message(message):
        return False
    role = str(message.get("role") or "").strip().lower()
    return bool(role and role != "tool")


def _tool_call_ids_in_messages(messages) -> set:
    ids = set()
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        for key in ("tool_calls", "_partial_tool_calls"):
            for call in msg.get(key) or []:
                if isinstance(call, dict):
                    cid = call.get("id") or call.get("tool_call_id")
                    if cid:
                        ids.add(str(cid))
        content = msg.get("content")
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "tool_use":
                    cid = part.get("id")
                    if cid:
                        ids.add(str(cid))
    return ids


def _tool_result_matches_call_ids(message, call_ids) -> bool:
    if not call_ids or not isinstance(message, dict):
        return False
    if str(message.get("role") or "").lower() != "tool":
        return False
    tid = message.get("tool_call_id") or message.get("tool_use_id") or ""
    return bool(tid) and str(tid) in call_ids


def message_window_for_display(
    messages,
    msg_limit=None,
    msg_before=None,
    expand_renderable=False,
) -> tuple[list, int]:
    """Return a visible-row-bounded window and its full-transcript offset.

    Tool results do not consume the visible-row budget, but a result immediately
    following a visible tool call is retained so the browser can build its card.
    """
    _ = expand_renderable
    messages = list(messages or [])
    if msg_before is not None:
        before_idx = max(0, min(int(msg_before), len(messages)))
    else:
        before_idx = len(messages)
    source = messages[:before_idx]
    if not source:
        return [], 0
    if not msg_limit:
        return source, 0
    limit = max(1, int(msg_limit))
    end_idx = len(source)
    last_renderable_idx = None
    for idx in range(end_idx - 1, -1, -1):
        if message_counts_as_renderable(source[idx]):
            last_renderable_idx = idx
            break
    if last_renderable_idx is None:
        start_idx = max(0, end_idx - limit)
        return source[start_idx:end_idx], start_idx

    end_idx = last_renderable_idx + 1
    window_tool_call_ids = _tool_call_ids_in_messages(source[: last_renderable_idx + 1])
    while end_idx < len(source) and not message_counts_as_renderable(source[end_idx]):
        if _tool_result_matches_call_ids(source[end_idx], window_tool_call_ids):
            end_idx += 1
        else:
            break

    start_idx = 0
    renderable_count = 0
    for idx in range(last_renderable_idx, -1, -1):
        if not message_counts_as_renderable(source[idx]):
            continue
        renderable_count += 1
        if renderable_count >= limit:
            start_idx = idx
            break
    return source[start_idx:end_idx], start_idx


def tool_calls_for_message_window(tool_calls, start_idx: int, message_count: int) -> list:
    """Filter and rebase session-level tool calls into a message window."""
    if not isinstance(tool_calls, list) or message_count <= 0:
        return []
    end_idx = start_idx + message_count
    filtered = []
    for tool_call in tool_calls:
        if not isinstance(tool_call, dict):
            continue
        assistant_idx = tool_call.get("assistant_msg_idx")
        if isinstance(assistant_idx, bool) or not isinstance(assistant_idx, int):
            continue
        if start_idx <= assistant_idx < end_idx:
            rebased = dict(tool_call)
            rebased["assistant_msg_idx"] = assistant_idx - start_idx
            filtered.append(rebased)
    return filtered


_LIMITED_TOOL_CONTENT_MAX_CHARS = 4096
_LIMITED_TOOL_CONTENT_NOTICE = (
    "\n\n[Tool output truncated in paginated session response; "
    "load the full transcript to inspect the complete result.]"
)


def _tool_message_for_limited_payload(message):
    if not isinstance(message, dict) or str(message.get("role") or "").lower() != "tool":
        return message
    content = message.get("content")
    if content in (None, ""):
        return message
    if isinstance(content, str):
        text = content
    else:
        try:
            text = json.dumps(content, ensure_ascii=False, default=str)
        except Exception:
            text = str(content)
    if len(text) <= _LIMITED_TOOL_CONTENT_MAX_CHARS:
        return message
    clipped = dict(message)
    preview = text[:_LIMITED_TOOL_CONTENT_MAX_CHARS] + _LIMITED_TOOL_CONTENT_NOTICE
    if isinstance(content, str):
        clipped["content"] = preview
    elif isinstance(content, list):
        clipped["content"] = [{"type": "text", "text": preview}]
    elif isinstance(content, dict):
        clipped["content"] = {"_truncated": True, "preview": preview}
    else:
        clipped["content"] = preview
    clipped["_content_truncated"] = True
    clipped["_content_original_chars"] = len(text)
    return clipped


def messages_for_limited_payload(messages) -> list:
    """Bound hidden tool-result payloads before sending a display window."""
    return [_tool_message_for_limited_payload(msg) for msg in list(messages or [])]
