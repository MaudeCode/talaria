"""Small, provider-neutral reasoning-title fallback for WebUI clients."""

from __future__ import annotations

import json
import re

from api.helpers import _redact_text


_BOLD_LINE = re.compile(r"^\s*\*\*(.+?)\*\*\s*$")
_COMMAND_LINE = re.compile(
    r"^(?:[$>]\s*|(?:\.{0,2}/)|(?:sudo|env|git|cd|ls|cat|python|node|curl|wget|rg|grep|npm|npx|pnpm|yarn|bun|deno|make|cmake|docker|podman|kubectl|helm|terraform|ansible|xcodebuild|xcrun|swift|go|cargo|rustc|pip|pip3|pytest|bash|sh|zsh|fish|rm|cp|mv|chmod|chown|sed|awk)\b)",
    re.IGNORECASE,
)
_TOOL_ARGUMENT_LINE = re.compile(
    r"^(?:--[\w-]+(?:\s|=)|[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S+|(?:args?|arguments?|input|params?)\s*[:=]\s*[\[{])",
    re.IGNORECASE,
)
_MARKDOWN_PREFIX = re.compile(r"^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)")
_SENSITIVE_TITLE = re.compile(
    r"\b(?:password|passwd|credentials?|secret|ssn)\b|"
    r"authorization\s*:|private\s+tool\s+output|"
    r"\b\d{3}-\d{2}-\d{4}\b",
    re.IGNORECASE,
)


def _clean_title(value: object, *, explicit: bool = False) -> str:
    title = " ".join(str(value or "").split()).strip()
    if not title or len(title) > 400:
        return ""
    title = _MARKDOWN_PREFIX.sub("", title).strip()
    if not title or title.startswith(("```", "~~~", "<", "{", "[")):
        return ""
    if _SENSITIVE_TITLE.search(title) or _redact_text(title, _enabled=True) != title:
        return ""
    if _COMMAND_LINE.match(title) or _TOOL_ARGUMENT_LINE.match(title):
        return ""
    if not explicit:
        try:
            if isinstance(json.loads(title), (dict, list)):
                return ""
        except (TypeError, ValueError, json.JSONDecodeError):
            pass
    if len(title) <= 80:
        return title
    shortened = title[:80].rsplit(" ", 1)[0].rstrip(" ,.;:-")
    return shortened if len(shortened) >= 24 else ""


def _unique_titles(values: object, *, explicit: bool = False) -> list[str]:
    if not isinstance(values, (list, tuple)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        title = _clean_title(value, explicit=explicit)
        key = title.casefold()
        if not title or key in seen:
            continue
        seen.add(key)
        out.append(title)
        if len(out) == 8:
            break
    return out


def _reasoning_lines(raw: str) -> list[tuple[str, bool]]:
    lines: list[tuple[str, bool]] = []
    fence: str | None = None
    for line in raw.splitlines(keepends=True):
        stripped = line.lstrip()
        marker = stripped[:3] if stripped.startswith(("```", "~~~")) else ""
        if marker:
            if fence is None:
                fence = marker
            elif marker == fence:
                fence = None
            lines.append((line, False))
            continue
        lines.append((line, fence is None))
    return lines


def normalize_reasoning_titles(
    text: object,
    *,
    explicit_titles: object = None,
    stable: bool = False,
) -> list[str]:
    """Return an ordered title snapshot without guessing from partial prose."""

    if explicit_titles is not None:
        return _unique_titles(explicit_titles, explicit=True)

    raw = str(text or "")
    lines = _reasoning_lines(raw)
    bold = []
    for line, is_safe in lines:
        if not is_safe:
            continue
        match = _BOLD_LINE.match(line)
        if match:
            bold.append(match.group(1))
    titles = _unique_titles(bold)
    if titles:
        return titles

    for index, (line, is_safe) in enumerate(lines):
        if not line.strip():
            continue
        if not is_safe:
            return []
        complete = line.endswith(("\n", "\r")) or stable or index < len(lines) - 1
        if not complete:
            return []
        title = _clean_title(line)
        return [title] if title else []
    return []


def reasoning_event_payload(
    delta: object,
    cumulative_text: object,
    *,
    explicit_titles: object = None,
    stable: bool = False,
) -> dict:
    payload = {"text": str(delta or "")}
    titles = normalize_reasoning_titles(
        cumulative_text if stable else delta,
        explicit_titles=explicit_titles,
        stable=stable,
    )
    if titles or explicit_titles is not None:
        payload["titles"] = titles
    return payload
