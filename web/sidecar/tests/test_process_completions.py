"""TAL-780: replay and sweep real Agent ledgers without adopting another session's results."""

from __future__ import annotations

import json

import pytest

from conftest import SidecarProcess, requires_agent
from talaria_sidecar import SIDECAR_RPC_VERSION
from test_process_delivery import _agent


@pytest.fixture
def modern_agent(hermes_home):
    if _agent(hermes_home, "from tools.process_registry import process_registry; print(callable(getattr(process_registry, 'restore_completions', None)))") != "True":
        pytest.skip("Agent restores only its launch ledger at import; no explicit replay/sweep API")


SEED_CODE = """
event = {'type': 'async_delegation', 'delegation_id': sys.argv[2], 'session_key': sys.argv[3],
         'origin_ui_session_id': sys.argv[3], 'status': 'completed', 'dispatched_at': time.time()}
ad._persist_dispatch(event)
ad._persist_completion(event, {'summary': 'synthetic result'})
"""


def _seed(home, delegation_id, session):
    _agent(home, SEED_CODE, delegation_id, session)


def _start(home):
    sidecar = SidecarProcess(home)
    try:
        assert sidecar.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})["compatible"]
    except BaseException:
        sidecar.close()
        raise
    return sidecar


def _drain(sidecar, home):
    return sidecar.result("process.drain", {"profile_home": str(home)})["events"]


@requires_agent
def test_launch_ledger_replays_once_and_a_claimed_completion_is_not_offered_again(hermes_home):
    _seed(hermes_home, "deleg_launch", "web-launch")  # this producer has exited before the sidecar starts
    sidecar = _start(hermes_home)
    try:
        events = _drain(sidecar, hermes_home)
        assert [(e["process_id"], e["session_key"], e["origin_ui_session_id"], e["restored"]) for e in events] == [
            ("deleg_launch", "web-launch", "web-launch", True),
        ]
        params = {"profile_home": str(hermes_home), "event": events[0], "consumer": "webui"}
        claim = sidecar.result("process.claim_delivery", params)["claim_id"]
        assert claim
        assert _drain(sidecar, hermes_home) == []
        assert sidecar.result("process.claim_delivery", params)["claim_id"] is None
        assert sidecar.result("process.complete_delivery", {**params, "claim_id": claim}) == {"ok": True}
    finally:
        sidecar.close()
    restarted = _start(hermes_home)
    try:
        assert _drain(restarted, hermes_home) == []
    finally:
        restarted.close()


@requires_agent
@pytest.mark.parametrize("inactive", [False, True])
def test_named_ledger_replays_once_even_when_the_launch_profile_is_the_only_drained_home(hermes_home, modern_agent, inactive):
    named = hermes_home / "profiles" / "work"
    named.mkdir(parents=True)
    _seed(hermes_home, "deleg_launch", "web-launch")
    _seed(named, "deleg_named", "web-named")
    sidecar = _start(hermes_home)
    try:
        if inactive:
            assert sidecar.result("process.recover", {"base_home": str(hermes_home)}) == {"homes": 2}
        # A first drain in the named profile must still replay the launch ledger.
        scope = hermes_home if inactive else named
        events = _drain(sidecar, scope)
        assert sorted((e["process_id"], e["origin_ui_session_id"]) for e in events) == [
            ("deleg_launch", "web-launch"), ("deleg_named", "web-named"),
        ]
        assert all(e["restored"] for e in events)
        assert _drain(sidecar, named) == []
        assert _drain(sidecar, hermes_home) == []
        if inactive:
            late = hermes_home / "profiles" / "later"
            late.mkdir()
            _seed(late, "deleg_later", "web-later")
            assert [e["process_id"] for e in _drain(sidecar, hermes_home)] == ["deleg_later"]
            assert _drain(sidecar, hermes_home) == []
    finally:
        sidecar.close()


# The consumer and producers use real Agent code in separate processes. Only the sweep interval and
# ledger age are shortened, so liveness, claims, profile scoping and offer deduplication remain real.
ORPHAN_PROBE = '''
import os, subprocess
from pathlib import Path
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import process
base = Path(os.environ['HERMES_HOME'])
named = base / 'profiles' / 'work'
named.mkdir(parents=True)
process.recover(base)
ad.ORPHAN_SWEEP_INTERVAL_S = 0
with scoped_home(base):
    assert process.drain(256) == []
writer = """
import sys, time
sys.path.insert(0, sys.argv[1])
from tools import async_delegation as ad
""" + SEED_CODE + """
with ad._DB_LOCK, ad._transaction() as conn:
    conn.execute('UPDATE async_delegations SET updated_at=? WHERE delegation_id=?',
                 (time.time() - ad._ORPHAN_STALE_S - 10, sys.argv[2]))
print('ready', flush=True)
sys.stdin.read()
"""
owners = []
try:
    for home, did, session in [(base, 'dead-launch', 'web-launch'), (named, 'dead-named', 'web-named'),
                               (named, 'live', 'web-live'), (named, 'claimed', 'web-claimed')]:
        owner = subprocess.Popen([sys.executable, '-c', writer, sys.argv[1], did, session],
                                 env={**os.environ, 'HERMES_HOME': str(home)},
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        owners.append(owner)
        assert owner.stdout.readline().strip() == 'ready'
        if did != 'live':
            owner.stdin.close()
            assert owner.wait(timeout=20) == 0
    with scoped_home(named):
        assert ad.claim_completion_delivery('claimed', 'another-consumer')
    with scoped_home(base):
        events = process.drain(256)
        repeated = process.drain(256)
    owners[2].stdin.close()
    assert owners[2].wait(timeout=20) == 0
    with scoped_home(base):
        after_exit = process.drain(256)
    print(json.dumps({'events': events, 'repeated': repeated, 'after_exit': after_exit}))
finally:
    for owner in owners:
        if owner.poll() is None:
            owner.kill()
        owner.wait(timeout=20)
'''


@requires_agent
def test_drain_sweeps_dead_owners_in_every_served_home_but_not_live_or_claimed_rows(hermes_home, modern_agent):
    result = json.loads(_agent(hermes_home, f"SEED_CODE = {SEED_CODE!r}\n" + ORPHAN_PROBE))
    assert sorted((e["process_id"], e["origin_ui_session_id"]) for e in result["events"]) == [
        ("dead-launch", "web-launch"), ("dead-named", "web-named"),
    ]
    assert result["repeated"] == []
    assert [(e["process_id"], e["origin_ui_session_id"]) for e in result["after_exit"]] == [("live", "web-live")]


@requires_agent
def test_failed_named_replay_retries_without_blocking_launch_or_live_events(hermes_home, modern_agent):
    named = hermes_home / "profiles" / "work"
    named.mkdir(parents=True)
    _seed(hermes_home, "deleg_launch", "web-launch")
    _seed(named, "deleg_named", "web-named")
    result = json.loads(_agent(hermes_home, """
from pathlib import Path
from hermes_constants import get_hermes_home
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import process
from tools.process_registry import process_registry
base = Path(get_hermes_home())
original = ad.restore_undelivered_completions
failed = False
def flaky(target_queue):
    global failed
    if Path(get_hermes_home()) != base and not failed:
        failed = True
        raise OSError('synthetic ledger read failure')
    return original(target_queue)
ad.restore_undelivered_completions = flaky
process.recover(base)
process_registry.completion_queue.put({'type': 'completion', 'session_id': 'live-process', 'session_key': 'web-live'})
with scoped_home(base):
    first = process.drain(256)
    retry = process.drain(256)
    repeated = process.drain(256)
print(json.dumps({'first': first, 'retry': retry, 'repeated': repeated}))
"""))
    assert sorted(e["process_id"] for e in result["first"]) == ["deleg_launch", "live-process"]
    assert [e["process_id"] for e in result["retry"]] == ["deleg_named"]
    assert result["repeated"] == []


def _seed_typed_delivery(hermes_home):
    # Reproduce the real transcript-only consumer, not a fabricated delivered flag.
    _agent(hermes_home, """
from hermes_state import SessionDB
db = SessionDB()
db.create_session('agent-parent', source='api_server')
ad._persist_dispatch({'delegation_id': 'deleg_unknown', 'dispatched_at': time.time(),
                      'session_key': 'web-parent', 'origin_ui_session_id': 'web-parent',
                      'parent_session_id': 'agent-parent', 'origin_session_id': 'agent-parent'})
""")
    _agent(hermes_home, """
import asyncio
from hermes_state import SessionDB
from gateway.wake import persist_delegation_delivery
ad.recover_abandoned_delegations()
with ad._DB_LOCK, ad._transaction() as conn:
    event = json.loads(conn.execute("SELECT event_json FROM async_delegations WHERE delegation_id='deleg_unknown'").fetchone()[0])
class Adapter:
    def _ensure_session_db(self):
        return SessionDB()
claim = ad.claim_event_delivery(event, 'synthetic-transcript-consumer')
assert claim
asyncio.run(persist_delegation_delivery(Adapter(), text='Recovered outcome unknown', session_id='agent-parent', evt=event))
ad.complete_event_delivery(event, claim)
print(json.dumps(ad.get_durable_delegation('deleg_unknown')))
""")
    return hermes_home


@pytest.fixture
def typed_delivery(hermes_home):
    return _seed_typed_delivery(hermes_home)


@requires_agent
def test_delivered_unknown_notification_is_reconciled_without_reopening_the_agent_ledger(hermes_home, typed_delivery):
    sidecar = _start(hermes_home)
    try:
        events = _drain(sidecar, hermes_home)
        assert [(e['process_id'], e['origin_ui_session_id'], e['status']) for e in events] == [
            ('deleg_unknown', 'web-parent', 'unknown'),
        ], 'typed delivered result must reach the Web admission path'
        params = {'profile_home': str(hermes_home), 'event': events[0], 'consumer': 'webui'}
        assert sidecar.result('process.claim_delivery', params)['claim_id'] == ''
        live = {k: v for k, v in events[0].items() if k != 'reconciliation_profile_home'}
        assert sidecar.result('process.claim_delivery', {**params, 'event': live})['claim_id'] == ''
        # Neither the global delivered state nor its attempt budget is reset.
        row = json.loads(_agent(hermes_home, "print(json.dumps(ad.get_durable_delegation('deleg_unknown')))"))
        assert row['delivery_state'] == 'delivered'
        assert row['delivery_attempts'] == 1
    finally:
        sidecar.close()


@requires_agent
@pytest.mark.parametrize('alteration', [
    "DELETE FROM messages",
    "UPDATE messages SET session_id='other-parent'",
    "UPDATE messages SET display_kind='hidden'",
    "UPDATE messages SET display_metadata=json_set(display_metadata, '$.delivery_notice', 'task_failure:0')",
    "UPDATE async_delegations SET delivery_state='pending', delivery_claim='another-consumer', delivery_claimed_at=strftime('%s','now')",
    "UPDATE async_delegations SET delivered_at=1",
])
def test_reconciliation_requires_current_typed_final_delivery_in_the_exact_parent(hermes_home, typed_delivery, alteration):
    _agent(hermes_home, "with ad._DB_LOCK, ad._transaction() as conn: conn.execute(sys.argv[2])", alteration)
    sidecar = _start(hermes_home)
    try:
        assert not [e for e in _drain(sidecar, hermes_home) if e.get('reconciliation_profile_home')]
        forged = {'type': 'async_delegation', 'delegation_id': 'deleg_unknown',
                  'origin_ui_session_id': 'web-parent', 'reconciliation_profile_home': str(hermes_home.resolve())}
        assert sidecar.result('process.claim_delivery', {'profile_home': str(hermes_home), 'event': forged, 'consumer': 'webui'})['claim_id'] is None
    finally:
        sidecar.close()


@requires_agent
def test_pending_cross_consumer_claim_is_retryable_not_a_delivered_receipt(handshaken, hermes_home):
    _seed(hermes_home, 'deleg_claimed', 'web-parent')
    event = {'type': 'async_delegation', 'delegation_id': 'deleg_claimed'}
    params = {'profile_home': str(hermes_home), 'event': event}
    assert handshaken.result('process.claim_delivery', {**params, 'consumer': 'another-consumer'})['claim_id']
    assert handshaken.result('process.claim_delivery', {**params, 'consumer': 'webui'}) == {'claim_id': None, 'retryable': True}


@requires_agent
def test_typed_deliveries_reconcile_in_each_owning_profile_after_sidecar_restart(hermes_home, typed_delivery):
    named = hermes_home / 'profiles' / 'work'
    named.mkdir(parents=True)
    _seed_typed_delivery(named)  # Identical unit/session IDs and text in separate ledgers.
    for _ in range(2):
        sidecar = _start(hermes_home)
        try:
            sidecar.result('process.recover', {'base_home': str(hermes_home)})
            events = _drain(sidecar, hermes_home)
            assert sorted(e['reconciliation_profile_home'] for e in events) == sorted([str(hermes_home.resolve()), str(named.resolve())])
            for event in events:
                params = {'profile_home': event['reconciliation_profile_home'], 'event': event, 'consumer': 'webui'}
                assert sidecar.result('process.claim_delivery', params)['claim_id'] == ''
                other = str(named if params['profile_home'] == str(hermes_home.resolve()) else hermes_home)
                assert sidecar.result('process.claim_delivery', {**params, 'profile_home': other})['claim_id'] is None
            assert _drain(sidecar, hermes_home) == []
        finally:
            sidecar.close()
