"""Bounded saved-check replay over the reviewed Hermetic store (TAL-1563).

The sidecar never runs Hermetic's API, judge or background jobs. ``plan`` reads the two consented revisions and the
skill's saved cases, and builds each case's fixed fixture from the recorded turn in the session store: recorded tool
results only, and minimal definitions for the recorded tool names so a planned call can be scored without running.
``dispatch`` re-derives exactly the consented revision and fixture, refuses any drift, and sends one capped request
on the verified OpenRouter route: ``max_tokens`` bounds the output and ``provider.max_price`` makes the provider refuse
any endpoint above the reserved price, so a call cannot cost more than its reservation. Tool calls in the answer are
recorded, never executed. Job admission, persistence, cancellation and restart reconciliation are the server's.
"""
from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request

from ..errors import InvalidParams, RpcError
from . import skill_revisions as history

MAX_CASES = 12
MAX_OUTPUT_TOKENS = 1500
MAX_INPUT_TOKENS = 160_000
_MAX_CASES_BYTES = 1024 * 1024
_MAX_FIXTURE_BYTES = 120_000
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_MAX_CONTENT = 4000
_MAX_ARGUMENTS = 1000
_TIMEOUT_SECONDS = 120.0
_SKILL_VIEW = 'skill_view'
_VIEW_ID = 'talaria_replay_skill_view'


class _Unavailable(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _plan_result(state, reason=None, **fields):
    return dict(state=state, reason=reason, revisions=[], cases=[], unavailable_cases=0, route=None,
                max_output_tokens=MAX_OUTPUT_TOKENS) | fields


def _saved_cases(home, skill_names):
    """Hermetic's case log with its own update/delete semantics; a malformed row fails closed so no deleted case revives."""
    try:
        with history._directory(home, ('hermetic',)) as fd:
            data, _ = history._read(fd, 'cases.jsonl', _MAX_CASES_BYTES)
    except FileNotFoundError:
        return []
    rows = [json.loads(line) for line in data.decode('utf-8').splitlines() if line.strip()]
    if not all(isinstance(row, dict) and isinstance(row.get('id'), str) for row in rows):
        raise ValueError('Invalid saved case')
    gone = {row['id'] for row in rows if row.get('deleted')}
    updates = {}
    for row in rows:
        if isinstance(row.get('update'), dict):
            updates.setdefault(row['id'], {}).update(row['update'])
    cases = [row | updates.get(row['id'], {}) for row in rows if not row.get('deleted') and 'update' not in row and row['id'] not in gone]
    return [case for case in cases if case.get('skill') in skill_names]


def _calls(value):
    if isinstance(value, str):
        try:
            value = json.loads(value) if value else []
        except ValueError:
            return []
    return value if isinstance(value, list) else []


def _text(value):
    return value if isinstance(value, str) else json.dumps(value) if value is not None else ''


def _names(value):
    return [str(item).strip() for item in value if str(item).strip()] if isinstance(value, list) else []


def _fixture(home, case):
    """The recorded conversation up to the case's user message (Hermetic ``_aai_turn``), bounded and self-contained."""
    from hermes_state import SessionDB

    session_id, message_id = case.get('session_id'), case.get('message_id')
    if not isinstance(session_id, str) or not session_id or not str(message_id or '').isdigit():
        raise _Unavailable('case_unavailable')
    path = home / 'state.db'
    if not path.is_file() or path.is_symlink():
        raise _Unavailable('case_unavailable')
    db = SessionDB(path, read_only=True)
    try:
        messages = db.get_messages(session_id) or []
        session = db.get_session(session_id) or {}
    finally:
        db.close()
    mid = int(message_id)
    rows = [m for m in messages if isinstance(m, dict) and int(m.get('id') or 0) <= mid]
    if not any(int(m.get('id') or 0) == mid for m in rows):
        raise _Unavailable('case_unavailable')
    last_user = max((int(m.get('id') or 0) for m in rows if m.get('role') == 'user'), default=None)
    if last_user is None:
        raise _Unavailable('case_unavailable')
    reply = case.get('mode') == 'reply' and not case.get('user_override')
    out = []
    for m in rows:
        index = int(m.get('id') or 0)
        if not (index < mid if reply else index <= last_user):
            continue
        if m.get('role') == 'user':
            out.append({'role': 'user', 'content': _text(m.get('content'))})
        elif m.get('role') == 'assistant':
            message = {'role': 'assistant', 'content': _text(m.get('content'))}
            calls = [{'id': str(c.get('id') or c.get('call_id') or ''), 'type': 'function',
                      'function': {'name': str((c.get('function') or {}).get('name')), 'arguments': _text((c.get('function') or {}).get('arguments') or '{}')}}
                     for c in _calls(m.get('tool_calls')) if isinstance(c, dict) and (c.get('function') or {}).get('name')]
            if calls:
                message['tool_calls'] = calls
            out.append(message)
        elif m.get('role') == 'tool':
            out.append({'role': 'tool', 'tool_call_id': str(m.get('tool_call_id') or ''), 'content': _text(m.get('content'))})
    answered = {m['tool_call_id'] for m in out if m['role'] == 'tool'}
    for m in out:
        if m.get('tool_calls'):
            m['tool_calls'] = [c for c in m['tool_calls'] if c['id'] in answered]
            if not m['tool_calls']:
                m.pop('tool_calls')
    asked = {c['id'] for m in out for c in m.get('tool_calls', [])}
    out = [m for m in out if m['role'] != 'tool' or m['tool_call_id'] in asked]
    # Keep the newest recorded turns within the fixture bound, starting at a user message.
    total, start = 0, len(out)
    for i in range(len(out) - 1, -1, -1):
        total += len(json.dumps(out[i]).encode())
        if total > _MAX_FIXTURE_BYTES:
            break
        start = i
    while start < len(out) and out[start]['role'] != 'user':
        start += 1
    out = out[start:]
    if case.get('user_override'):
        for m in reversed(out):
            if m['role'] == 'user':
                m['content'] = _text(case['user_override'])
                break
    if not out:
        raise _Unavailable('case_unavailable')
    expect, never = _names(case.get('expect_tools')), _names(case.get('never_tools'))
    names = sorted({c['function']['name'] for m in out for c in m.get('tool_calls', [])} | {n for n in expect + never if n != 'none'} | {_SKILL_VIEW})
    tools = [{'type': 'function', 'function': {'name': n, 'description': 'Recorded tool. Replays never run it.', 'parameters': {'type': 'object'}}} for n in names]
    system = session.get('system_prompt') or session.get('_system_prompt_resolved') or ''
    return {'case_id': case['id'], 'mode': 'reply' if reply else 'plan', 'expect_tools': expect, 'never_tools': never,
            'system': _text(system), 'messages': out, 'tools': tools}


def _fixture_id(home, name, fixture):
    return hashlib.sha256(json.dumps([str(home), name, fixture], sort_keys=True).encode()).hexdigest()


def _messages(fixture, skill, text):
    messages = ([{'role': 'system', 'content': fixture['system']}] if fixture['system'] else []) + [dict(m) for m in fixture['messages']]
    messages.append({'role': 'assistant', 'content': '', 'tool_calls': [{'id': _VIEW_ID, 'type': 'function', 'function': {'name': _SKILL_VIEW, 'arguments': json.dumps({'name': skill})}}]})
    messages.append({'role': 'tool', 'tool_call_id': _VIEW_ID, 'content': text})
    return messages


def input_bound(messages, tools):
    """A conservative prompt-token ceiling: byte-level tokenizers never spend under one byte per token, plus template overhead."""
    return len(json.dumps([messages, tools]).encode()) + 16 * len(messages) + 256


def _route():
    from .cron import _main_model_pin

    provider, model = _main_model_pin()
    return {'provider': provider, 'model': model} if isinstance(provider, str) and isinstance(model, str) and model else None


def _endpoint(route):
    """Only OpenRouter honors a per-request price ceiling, so only its exact HTTPS API may execute a replay."""
    from .chat import _resolve_runtime

    if not route or route.get('provider') != 'openrouter' or not isinstance(route.get('model'), str):
        raise RpcError('This provider route cannot enforce a replay budget', condition='route_unsupported')
    runtime = _resolve_runtime('openrouter', route['model'])
    base = urllib.parse.urlsplit(str(runtime.get('base_url') or ''))
    key = runtime.get('api_key')
    if base.scheme != 'https' or base.hostname != 'openrouter.ai' or base.port not in (None, 443) or base.path.rstrip('/') != '/api/v1' or base.query or not key:
        raise RpcError('This provider route cannot enforce a replay budget', condition='route_unsupported')
    return 'https://openrouter.ai/api/v1/chat/completions', str(key)


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_open = urllib.request.build_opener(_RefuseRedirects()).open


def _post(url, key, body):
    """Exactly one request: no retry, no redirect, bounded response."""
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
                                     headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'User-Agent': 'Talaria-Web/1.0'})
    with _open(request, timeout=_TIMEOUT_SECONDS) as response:
        data = response.read(_MAX_RESPONSE_BYTES + 1)
    if len(data) > _MAX_RESPONSE_BYTES:
        raise ValueError('Provider response is too large')
    return json.loads(data.decode('utf-8'))


def _checks(fixture, calls, content, malformed):
    """Hermetic's code checks (``_aai_checks``); no judge."""
    known = {tool['function']['name'] for tool in fixture['tools']} - {_SKILL_VIEW}
    names = [call['name'] for call in calls]
    checks = {'not_empty': bool(content.strip()) or bool(names),
              'valid_tools': (all(n in known for n in names) and not malformed) if names else True}
    expect, never = fixture['expect_tools'], fixture['never_tools']
    if expect == ['none']:
        checks['no_tools'] = not names
    elif expect:
        remaining = iter(names)
        checks['expected_tools'] = all(any(n == e for n in remaining) for e in expect)
    if never:
        checks['never_tools'] = not any(n in never for n in names)
    return checks


def _number(value):
    return value if type(value) in (int, float) and value == value and abs(value) != float('inf') else None


def _state(home, name, baseline, candidate):
    if not isinstance(baseline, str) or not isinstance(candidate, str) or baseline == candidate:
        raise InvalidParams('Replay needs two different revisions')
    selected = history.inspect_revisions(home, name, candidate, baseline)
    if selected['state'] != 'available':
        raise _Unavailable(selected['reason'] or 'history_unavailable')
    other = history.inspect_revisions(home, name, baseline, candidate)
    rows = {row['id']: row for row in selected['revisions']}
    texts = {candidate: selected['selected']['content'], baseline: other['selected']['content']}
    revisions = [dict(id=rid, sha256=rows[rid]['sha256'], label=rows[rid]['label'], role=role) for role, rid in (('baseline', baseline), ('candidate', candidate))]
    from .skills import _skill_helper
    catalog = _skill_helper('skill_catalog')
    identity = history._identity(catalog, name) if catalog else None
    if identity is None:
        raise _Unavailable('identity_unavailable')
    return revisions, texts, identity['name']


def plan(home, name, baseline, candidate):
    """The consent summary: exact revisions, case fixtures, the verified route and each case's prompt bound."""
    try:
        revisions, texts, declared = _state(home, name, baseline, candidate)
        route = _route()
        try:
            _endpoint(route)
        except RpcError:
            return _plan_result('unavailable', 'route_unsupported', revisions=revisions, route=route)
        cases, missing = [], 0
        for case in _saved_cases(home, {name, declared})[:MAX_CASES]:
            try:
                fixture = _fixture(home, case)
            except _Unavailable:
                missing += 1
                continue
            bound = max(input_bound(_messages(fixture, declared, text), fixture['tools']) for text in texts.values())
            if bound > MAX_INPUT_TOKENS:
                missing += 1
                continue
            title = ' '.join(str(case.get('title') or case['id']).split())[:120]
            cases.append(dict(id=_fixture_id(home, name, fixture), case_id=case['id'], title=title, mode=fixture['mode'], input_tokens_bound=bound))
        if not cases:
            return _plan_result('unavailable', 'no_cases', revisions=revisions, route=route, unavailable_cases=missing)
        return _plan_result('ready', revisions=revisions, cases=cases, unavailable_cases=missing, route=route)
    except _Unavailable as exc:
        return _plan_result('unavailable', exc.reason if exc.reason in ('backend_unavailable', 'identity_unavailable', 'history_unavailable', 'invalid_history') else 'invalid_history')
    except (OSError, ValueError, TypeError, KeyError, ImportError, AttributeError):
        return _plan_result('unavailable', 'invalid_history')


def dispatch(home, name, params):
    """One consented case on one consented revision. Drift refuses before any request; nothing retries.

    Every failure before the request raises ``invalid_params`` or ``replay_refused``, so the server knows nothing
    was sent; once sent, the call returns ``completed``, ``error`` or ``unknown`` and never raises."""
    try:
        url, key, body, fixture, bound = _prepare(home, name, params)
    except InvalidParams:
        raise
    except RpcError as exc:
        raise RpcError(str(exc), condition='replay_refused') from None
    except Exception as exc:  # noqa: BLE001 - anything before the request refuses it
        raise RpcError(f'Replay refused: {type(exc).__name__}', condition='replay_refused') from None
    result = dict(outcome='completed', error=None, finish_reason=None, provider=None, content='', tool_calls=[],
                  input_tokens=None, output_tokens=None, cost_usd=None, checks={}, passed=None, input_tokens_bound=bound)
    try:
        data = _post(url, key, body)
    except urllib.error.HTTPError as exc:
        # The provider answered: it refused or failed the request, and reports what it charged nowhere we can read.
        return result | dict(outcome='error', error=f'Provider answered HTTP {exc.code}')
    except (OSError, ValueError) as exc:
        # The request may or may not have reached the provider.
        return result | dict(outcome='unknown', error=type(exc).__name__)
    try:
        return _answer(result, fixture, data)
    except Exception:  # noqa: BLE001 - a sent call never raises; its answer was unreadable
        return result | dict(outcome='error', error='Provider answer could not be read')


def _prepare(home, name, params):
    revision, sha256, fixture_id = params.get('revision'), params.get('sha256'), params.get('fixture')
    baseline, candidate = params.get('baseline'), params.get('candidate')
    route, limit, price = params.get('route'), params.get('max_input_tokens'), params.get('max_price_per_million')
    output = params.get('max_output_tokens')
    if revision not in (baseline, candidate) or type(limit) is not int or type(output) is not int or not 0 < output <= MAX_OUTPUT_TOKENS \
            or not 0 < limit <= MAX_INPUT_TOKENS or _number(price) is None or not price > 0:
        raise InvalidParams('Invalid replay bounds')
    try:
        revisions, texts, declared = _state(home, name, baseline, candidate)
        cases = _saved_cases(home, {name, declared})[:MAX_CASES]
    except _Unavailable as exc:
        raise InvalidParams('Saved history changed; replay refused', reason=exc.reason) from None
    except (OSError, ValueError, TypeError, KeyError, ImportError, AttributeError):
        raise InvalidParams('Saved history changed; replay refused') from None
    if next(r['sha256'] for r in revisions if r['id'] == revision) != sha256:
        raise InvalidParams('Saved revision changed; replay refused')
    fixture = None
    for case in cases:
        try:
            built = _fixture(home, case)
        except _Unavailable:
            continue
        if _fixture_id(home, name, built) == fixture_id:
            fixture = built
            break
    if fixture is None:
        raise InvalidParams('Saved case changed; replay refused')
    messages = _messages(fixture, declared, texts[revision])
    bound = input_bound(messages, fixture['tools'])
    if bound > limit:
        raise InvalidParams('Case exceeds its reserved input bound; replay refused')
    if _route() != route:
        raise InvalidParams('Provider route changed; replay refused')
    url, key = _endpoint(route)
    body = {'model': route['model'], 'messages': messages, 'tools': fixture['tools'], 'tool_choice': 'none' if fixture['mode'] == 'reply' else 'auto',
            'max_tokens': output, 'stream': False, 'usage': {'include': True},
            'provider': {'max_price': {'prompt': price, 'completion': price, 'request': 0, 'image': 0}}}
    return url, key, body, fixture, bound


def _answer(result, fixture, data):
    choice = ((data or {}).get('choices') or [None])[0] if isinstance(data, dict) else None
    usage = data.get('usage') if isinstance(data, dict) and isinstance(data.get('usage'), dict) else {}
    result |= dict(provider=str(data.get('provider'))[:80] if isinstance(data, dict) and data.get('provider') else None,
                   input_tokens=_number(usage.get('prompt_tokens')), output_tokens=_number(usage.get('completion_tokens')), cost_usd=_number(usage.get('cost')))
    if not isinstance(choice, dict) or not isinstance(choice.get('message'), dict):
        error = (data.get('error') or {}).get('message') if isinstance(data, dict) and isinstance(data.get('error'), dict) else None
        return result | dict(outcome='error', error=str(error or 'Provider returned no answer')[:240])
    message = choice['message']
    content = message.get('content') if isinstance(message.get('content'), str) else ''
    calls, malformed = [], False
    for call in message.get('tool_calls') or []:
        function = (call or {}).get('function') or {} if isinstance(call, dict) else {}
        arguments = function.get('arguments') if isinstance(function.get('arguments'), str) else '{}'
        try:
            json.loads(arguments or '{}')
        except ValueError:
            malformed = True
        calls.append({'name': str(function.get('name') or '')[:128], 'arguments': arguments[:_MAX_ARGUMENTS]})
    checks = _checks(fixture, calls, content, malformed)
    return result | dict(finish_reason=str(choice.get('finish_reason'))[:40] if choice.get('finish_reason') else None,
                         content=content[:_MAX_CONTENT], tool_calls=calls[:32], checks=checks, passed=all(checks.values()))
