"""The shared allowlist for native/resident context reads. Never includes prompt bodies or paths."""
from __future__ import annotations

import math
import re
import time

CATEGORIES = {'system_prompt', 'tool_definitions', 'rules', 'skills', 'mcp', 'subagent_definitions', 'memory', 'conversation'}
STATUSES = {'loaded', 'truncated', 'flagged', 'shadowed', 'blocked', 'empty', 'unreadable', 'suppressed'}
FILE_NAMES = {'AGENTS.md', 'SOUL.md', '.hermes.md', 'CLAUDE.md', 'GEMINI.md', 'CONTEXT.md'}
# TAL-2647: the Agent's prompt-cache window (``agent.prompt_cache_clock``, v0.23.2+).
CACHE_TIERS = {'5m', '30m', '1h', '12h'}
CACHE_DISPLAY_TIERS = CACHE_TIERS | {'24h', 'in_memory'}
CACHE_CONFIDENCES = {'proven', 'declared', 'assumed'}
CACHE_UNKNOWN_REASONS = {'session_rotated', 'compacted', 'route_changed', 'storage_unavailable'}


def number(value):
    return value if type(value) in (int, float) and 0 <= value <= 2**53 - 1 and math.isfinite(value) and int(value) == value else None


def choice(value, allowed):
    return value if isinstance(value, str) and value in allowed else None


def timestamp(value):
    return float(value) if type(value) in (int, float) and math.isfinite(value) and 0 < value < 2**53 else None


def prompt_cache(window):
    """The native window with its warm/cold state at the read, decided by the Agent's own helpers in the order its
    ``/context`` line uses. None is no window: an Agent before v0.23.2, or a session that never touched a cache. A
    malformed window is unknown, never guessed; a known one with no estimated end is warm only before its guarantee."""
    if window is None:
        return None
    try:
        from agent.prompt_cache_clock import cache_certainly_cold, cache_certainly_warm
    except ImportError:
        return None
    unknown = {'state': 'unknown', 'confidence': 'unknown', 'reason': 'invalid', 'tier': None, 'guaranteed_until': None,
               'estimated_until': None, 'remaining_seconds': None, 'coverage': []}
    if not isinstance(window, dict):
        return unknown
    confidence = window.get('confidence')
    if confidence == 'unknown':
        # The Agent's unknown causes; any other (an implicit cache, a runtime whose requests it does not build) has no published window.
        return {**unknown, 'reason': choice(window.get('reason'), CACHE_UNKNOWN_REASONS) or 'no_published_window'}
    guaranteed, estimated = timestamp(window.get('guaranteed_until')), timestamp(window.get('estimated_until'))
    if not choice(confidence, CACHE_CONFIDENCES) or any(window.get(key) is not None and value is None for key, value
                                                   in (('guaranteed_until', guaranteed), ('estimated_until', estimated))):
        return unknown
    clean = {'confidence': confidence, 'guaranteed_until': guaranteed, 'estimated_until': estimated}
    now = time.time()  # one read time for the state and the warm countdown, so a client's clock never decides either
    if cache_certainly_warm(clean, now=now):
        state, remaining = 'warm', guaranteed - now
    elif estimated is None:
        return {**unknown, 'reason': 'no_published_window'}
    else:
        state, remaining = 'expired' if cache_certainly_cold(clean, now=now) else 'maybe_warm', None
    raw = window.get('coverage')
    coverage = sorted(({'tier': tier, 'until': timestamp(until)} for tier, until in (raw.items() if isinstance(raw, dict) else ())
                       if choice(tier, CACHE_TIERS) and timestamp(until) is not None), key=lambda row: row['until'])
    return {'state': state, 'confidence': confidence, 'reason': None, 'tier': choice(window.get('tier'), CACHE_DISPLAY_TIERS), **clean,
            'remaining_seconds': remaining, 'coverage': coverage}


def unavailable(reason='unavailable') -> dict:
    return {'available': False, 'reason': reason, 'used_tokens': None, 'window_tokens': None, 'window_source': None,
            'source': None, 'estimated': None, 'estimated_total': None, 'categories': [], 'files': [],
            'truncated': False, 'current_turn_output_tokens': None, 'last_turn_output_tokens': None, 'prompt_cache': None}


def project(payload, *, usage=None, running=False, window_source=None) -> dict:
    if not isinstance(payload, dict):
        return unavailable('unsupported')
    rows = payload.get('categories')
    if not isinstance(rows, list) or not rows:
        return unavailable('not_built')
    maximum = number(payload.get('context_max')) or None
    categories, seen = [], set()
    for row in rows[:64]:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) or row.get('id') not in CATEGORIES or row['id'] in seen:
            continue
        tokens = number(row.get('tokens'))
        if tokens is None:
            continue
        seen.add(row['id'])
        categories.append({'id': row['id'], 'tokens': int(tokens), 'percent': min(100, tokens / maximum * 100) if maximum else None, 'estimated': True})
    if not categories:
        return unavailable('not_built')
    source = payload.get('context_source')
    source = source if isinstance(source, str) and source in {'provider_usage', 'local_estimate', 'provider_usage_plus_estimate'} else None
    files = payload.get('context_files')
    files = files if isinstance(files, list) else []
    safe_files = []
    for row in files[:64]:
        if not isinstance(row, dict):
            continue
        # Labels from owners can include the entire private directory. Keep known context basenames only.
        name = re.split(r'[/\\]', str(row.get('path') or ''))[-1]
        label = name if name in FILE_NAMES else row.get('label') if isinstance(row.get('label'), str) and row.get('label') in FILE_NAMES else 'Context file'
        status = row.get('status') if isinstance(row.get('status'), str) and row.get('status') in STATUSES else 'unknown'
        safe_files.append({'label': label, 'characters': number(row.get('chars')), 'tokens': number(row.get('est_tokens')),
                           'status': status, 'loaded': status in {'loaded', 'truncated', 'flagged'} if status != 'unknown' else None})
    output = number(usage.get('last_turn_tokens')) if isinstance(usage, dict) else None
    return {'available': True, 'reason': None, 'used_tokens': number(payload.get('context_used')), 'window_tokens': maximum, 'window_source': window_source,
            'source': source, 'estimated': source != 'provider_usage' if source else None,
            'estimated_total': number(payload.get('estimated_total')), 'categories': categories, 'files': safe_files,
            'truncated': len(rows) > 64 or len(files) > 64,
            'current_turn_output_tokens': output if running else None, 'last_turn_output_tokens': output if not running else None,
            'prompt_cache': prompt_cache(payload.get('prompt_cache'))}
