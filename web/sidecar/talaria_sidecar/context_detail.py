"""The shared allowlist for native/resident context reads. Never includes prompt bodies or paths."""
from __future__ import annotations

import math
import re

CATEGORIES = {'system_prompt', 'tool_definitions', 'rules', 'skills', 'mcp', 'subagent_definitions', 'memory', 'conversation'}
STATUSES = {'loaded', 'truncated', 'flagged', 'shadowed', 'blocked', 'empty', 'unreadable', 'suppressed'}
FILE_NAMES = {'AGENTS.md', 'SOUL.md', '.hermes.md', 'CLAUDE.md', 'GEMINI.md', 'CONTEXT.md'}


def number(value):
    return value if type(value) in (int, float) and 0 <= value <= 2**53 - 1 and math.isfinite(value) and int(value) == value else None


def unavailable(reason='unavailable') -> dict:
    return {'available': False, 'reason': reason, 'used_tokens': None, 'window_tokens': None,
            'source': None, 'estimated': None, 'estimated_total': None, 'categories': [], 'files': [],
            'truncated': False, 'current_turn_output_tokens': None, 'last_turn_output_tokens': None}


def project(payload, *, usage=None, running=False) -> dict:
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
    return {'available': True, 'reason': None, 'used_tokens': number(payload.get('context_used')), 'window_tokens': maximum,
            'source': source, 'estimated': source != 'provider_usage' if source else None,
            'estimated_total': number(payload.get('estimated_total')), 'categories': categories, 'files': safe_files,
            'truncated': len(rows) > 64 or len(files) > 64,
            'current_turn_output_tokens': output if running else None, 'last_turn_output_tokens': output if not running else None}
