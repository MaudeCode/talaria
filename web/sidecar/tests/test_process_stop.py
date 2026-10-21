"""Stop requests target only the selected session's work; completion remains Agent-owned."""
from contextlib import nullcontext
from io import BytesIO
import json
from types import ModuleType, SimpleNamespace
import sys

import pytest

from talaria_sidecar.methods import Registry, process
from talaria_sidecar.rpc import RpcServer


@pytest.fixture
def stop_rpc(monkeypatch, tmp_path):
    monkeypatch.setattr(process, 'scoped_home', lambda home: nullcontext(home))
    registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    process.register(registry)

    def call(process_id, session_id='owner'):
        output = BytesIO()
        rpc = RpcServer(registry.methods, stdout=output)
        rpc._dispatch({'id': 1, 'method': 'process.stop', 'params': {'profile_home': str(tmp_path), 'session_id': session_id, 'process_id': process_id}})
        return json.loads(output.getvalue())
    return call


def test_stop_registered_process_and_preserve_completion(monkeypatch, stop_rpc):
    proc = SimpleNamespace(id='proc_1', session_key='owner', exited=False)
    killed = []
    def kill(pid, **kwargs):
        killed.append((pid, kwargs))
        proc.exited = True
        return {'status': 'killed'}
    monkeypatch.setattr(process, '_registry', lambda: SimpleNamespace(get=lambda pid: proc if pid == proc.id else None, kill_process=kill))
    assert stop_rpc('proc_1').get('result') == {'outcome': 'stopped'}
    assert killed == [('proc_1', {'consume_output': False})]
    assert stop_rpc('proc_1').get('result') == {'outcome': 'not_running'}
    assert stop_rpc('proc_1', 'foreign').get('result') == {'outcome': 'not_found'}
    assert stop_rpc('missing').get('result') == {'outcome': 'not_found'}
    assert len(killed) == 1


def test_stop_delegation_interrupts_only_its_children(monkeypatch, stop_rpc):
    monkeypatch.setattr(process, '_registry', lambda: None)
    monkeypatch.setattr(process, '_ledger_rows', lambda home, ids: [{'delegation_id': 'd1', 'origin_ui_session_id': 'owner', 'state': 'running'}] if ids == ['owner'] else [])
    monkeypatch.setattr(process, '_live_delegations', lambda: {'d1': {'origin_ui_session_id': 'owner'}})
    api = ModuleType('tools.delegate_tool_registry')
    api.list_active_subagents = lambda: [
        {'subagent_id': 'sa1', 'delegation_id': 'd1', 'owner_agent_session_id': 'owner'},
        {'subagent_id': 'sa2', 'delegation_id': 'd1', 'owner_agent_session_id': 'owner'},
        {'subagent_id': 'other', 'delegation_id': 'd2', 'owner_agent_session_id': 'owner'},
        {'subagent_id': 'foreign', 'delegation_id': 'd1', 'owner_agent_session_id': 'foreign'},
    ]
    interrupted = []
    api.interrupt_subagent = lambda sid: interrupted.append(sid) or True
    monkeypatch.setitem(sys.modules, 'tools.delegate_tool_registry', api)
    assert stop_rpc('d1').get('result') == {'outcome': 'stopped'}
    assert interrupted == ['sa1', 'sa2']
    assert stop_rpc('d1', 'foreign').get('result') == {'outcome': 'not_found'}
    api.list_active_subagents = lambda: []
    assert stop_rpc('d1').get('result') == {'outcome': 'not_running'}


def test_failed_kill_is_not_reported_as_stopped(monkeypatch, stop_rpc):
    monkeypatch.setattr(process, '_registry', lambda: SimpleNamespace(get=lambda pid: SimpleNamespace(session_key='owner', exited=False), kill_process=lambda *a, **kw: {'status': 'error', 'error': 'still alive'}))
    reply = stop_rpc('proc_1')
    assert 'error' in reply
    assert 'still alive' in reply['error']['message']


def test_split_delegation_never_interrupts_sibling_unit(monkeypatch, stop_rpc):
    monkeypatch.setattr(process, '_registry', lambda: None)
    monkeypatch.setattr(process, '_ledger_rows', lambda home, ids: [{'delegation_id': 'call-1', 'state': 'running'}])
    monkeypatch.setattr(process, '_live_delegations', lambda: {'call-1': {'origin_ui_session_id': 'owner', 'slot_key': 'call-1', 'task_indexes': [1, 2]}})
    api = ModuleType('tools.delegate_tool_registry')
    api.list_active_subagents = lambda: [{'subagent_id': f'sa-{i}-abcd', 'delegation_id': 'call', 'owner_agent_session_id': 'owner'} for i in range(4)]
    interrupted = []
    api.interrupt_subagent = lambda sid: interrupted.append(sid) or True
    monkeypatch.setitem(sys.modules, 'tools.delegate_tool_registry', api)
    assert stop_rpc('call-1').get('result') == {'outcome': 'stopped'}
    assert interrupted == ['sa-1-abcd', 'sa-2-abcd']


def test_finished_delegation_does_not_interrupt_live_roster(monkeypatch, stop_rpc):
    monkeypatch.setattr(process, '_registry', lambda: None)
    monkeypatch.setattr(process, '_ledger_rows', lambda home, ids: [{'delegation_id': 'done', 'state': 'completed'}])
    assert stop_rpc('done').get('result') == {'outcome': 'not_running'}


def test_partial_interrupt_is_an_error_and_attempts_every_child(monkeypatch, stop_rpc):
    monkeypatch.setattr(process, '_registry', lambda: None)
    monkeypatch.setattr(process, '_ledger_rows', lambda home, ids: [{'delegation_id': 'd1', 'state': 'running'}])
    monkeypatch.setattr(process, '_live_delegations', lambda: {'d1': {'origin_ui_session_id': 'owner'}})
    api = ModuleType('tools.delegate_tool_registry')
    api.list_active_subagents = lambda: [{'subagent_id': sid, 'delegation_id': 'd1', 'owner_agent_session_id': 'owner'} for sid in ['sa1', 'sa2']]
    interrupted = []
    api.interrupt_subagent = lambda sid: interrupted.append(sid) or sid != 'sa1'
    monkeypatch.setitem(sys.modules, 'tools.delegate_tool_registry', api)
    assert 'error' in stop_rpc('d1')
    assert interrupted == ['sa1', 'sa2']
