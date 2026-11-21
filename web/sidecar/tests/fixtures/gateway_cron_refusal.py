"""Actual candidate refusal producer and settlement, with execution replaced by a tripwire."""
import asyncio
from contextlib import contextmanager
from importlib import import_module
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

agent = Path(os.environ['TALARIA_WEB_AGENT_DIR']).resolve()
sys.path.insert(0, str(agent))
# The runtime wire catalog advertises the API; private producer names never decide support.
assert 'cron.submit' in import_module('tui_gateway.contracts').CANONICAL_METHODS, 'this Agent does not advertise cron.submit'
from cron import scheduler
from gateway import session_cron
from gateway.session_authority import LiveSession, SessionAuthority
from gateway.session_contract import SessionRef
from gateway.session_settlement_recovery import commit_and_publish

home = Path(os.environ['HERMES_HOME'])
home.mkdir(parents=True, exist_ok=True)
fixture = json.loads((Path(__file__).resolve().parents[4] / 'contracts/fixtures/native-cron-refusal.json').read_text())

@contextmanager
def owner(session_id, payload):
    """An owner authority holding one claimed operator admission in a cron session: ``(authority, row)``."""
    owned = {'profile_id': 'fixture', 'instance_id': 'fixture'}
    request = {'principal_id': 'operator', 'session_id': session_id, 'request_id': 'ordinary-input', 'payload': payload}
    try:  # agent-shim: pre-persistence-store
        from persistence_assembly import open_persistence, profile_scope
    except ImportError:
        from hermes_state import SessionDB
        from hermes_state_runtime import admit_session_input, begin_runtime_epoch, claim_session_input
        with SessionDB(home / 'state.db') as db:
            db.create_session(session_id, source='cron')
            authority = SessionAuthority(SimpleNamespace(_draining=False), **owned, db=db,
                                         epoch=begin_runtime_epoch(db, instance_id='fixture'))
            admit_session_input(db, epoch=authority.epoch, **request)
            yield authority, claim_session_input(db, epoch=authority.epoch, session_id=session_id)
        return
    from gateway.session_authority import admission_row
    from persistence.conversation.sessions import NewSession
    with open_persistence(profile_scope(home=home), eager=True) as store:
        store.sessions.create(NewSession(session_id=session_id, source='cron'))
        authority = SessionAuthority(SimpleNamespace(_draining=False), **owned, persistence=store,
                                     epoch=store.runtime.begin_epoch(instance_id='fixture'))
        store.admissions.admit(epoch=authority.epoch, **request)
        yield authority, admission_row(store.admissions.claim(epoch=authority.epoch, session_id=session_id))

async def probe():
    with owner('native-cron-refusal', {'text': 'ordinary operator text'}) as (authority, row):
        ref = SessionRef('fixture', 'native-cron-refusal')
        live = LiveSession(SimpleNamespace(platform=None, user_id='cron-owner'), 'fixture-route')
        authority.sessions[ref.session_id] = live
        policy = SimpleNamespace(request_json=json.dumps({'extra_prompt': None, 'request_id': 'cron:job:fire', 'cron_job': {'id': 'job'}}))
        with patch.object(scheduler, 'run_job', side_effect=AssertionError('refused input ran a job')) as run_job:
            response = await session_cron.execute(authority, ref, row, policy)
            captured = authority.pending_results.pop(row['admission_id'])
            settlement = {}
            commit_and_publish(authority, live, ref, row, response, 'failed', captured, settlement)
            assert run_job.call_count == 0
        assert settlement['settled']['outcome'] == 'failed'
        events = live.event_stream.since(live.event_stream.epoch, 0)
        completion = next(event['payload'] for event in events['events'] if event['type'] == 'message.complete')
        assert {**completion, 'admission_id': 'native-input'} == fixture['completion'], completion
        print(json.dumps({'status': 'supported', 'completion': completion, 'scheduled_job_calls': run_job.call_count}))

asyncio.run(probe())
