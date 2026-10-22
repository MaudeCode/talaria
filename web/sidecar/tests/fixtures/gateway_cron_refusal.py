"""Actual candidate refusal producer and settlement, with execution replaced by a tripwire."""
import asyncio
from importlib import import_module
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

agent = Path(os.environ['HERMES_WEBUI_AGENT_DIR']).resolve()
sys.path.insert(0, str(agent))
try:
    contracts = import_module('tui_gateway.contracts')
except ModuleNotFoundError as exc:
    if exc.name not in {'tui_gateway', 'tui_gateway.contracts'}:
        raise
    contracts = None
# The runtime wire catalog advertises the API; private producer names never decide support.
if 'cron.submit' not in getattr(contracts, 'CANONICAL_METHODS', {}):
    print(json.dumps({'status': 'unsupported', 'method': 'cron.submit'}))
    sys.exit(0)
from cron import scheduler
from gateway import session_cron
from gateway.session_authority import LiveSession, SessionAuthority
from gateway.session_contract import SessionRef
from gateway.session_settlement_recovery import commit_and_publish
from hermes_state import SessionDB
from hermes_state_runtime import RuntimeStoreError, admit_session_input, begin_runtime_epoch, claim_session_input

home = Path(os.environ['HERMES_HOME'])
home.mkdir(parents=True, exist_ok=True)
fixture = json.loads((Path(__file__).resolve().parents[4] / 'contracts/fixtures/native-cron-refusal.json').read_text())

async def probe():
    with SessionDB(home / 'state.db') as db:
        db.create_session('native-cron-refusal', source='cron')
        authority = SessionAuthority(SimpleNamespace(_draining=False), profile_id='fixture', instance_id='fixture', db=db,
                                     epoch=begin_runtime_epoch(db, instance_id='fixture'))
        ref = SessionRef('fixture', 'native-cron-refusal')
        live = LiveSession(SimpleNamespace(platform=None, user_id='cron-owner'), 'fixture-route')
        authority.sessions[ref.session_id] = live
        admit_session_input(db, epoch=authority.epoch, principal_id='operator', session_id=ref.session_id,
                            request_id='ordinary-input', payload={'text': 'ordinary operator text'})
        row = claim_session_input(db, epoch=authority.epoch, session_id=ref.session_id)
        policy = SimpleNamespace(request_json=json.dumps({'extra_prompt': None, 'request_id': 'cron:job:fire', 'cron_job': {'id': 'job'}}))
        with patch.object(scheduler, 'run_job', side_effect=AssertionError('refused input ran a job')) as run_job:
            try:
                response = await session_cron.execute(authority, ref, row, policy)
            except RuntimeStoreError as exc:
                from talaria_sidecar.runtime import read_agent_revision
                # Only this attested older producer may lack the typed descriptor; a newer downgrade is a failure.
                legacy = {'status': 'unsupported', 'feature': 'cron_session_read_only',
                          'source_revision': read_agent_revision(agent, Path(session_cron.__file__).resolve()),
                          'reason': exc.reason, 'scheduled_job_calls': run_job.call_count,
                          'captured_result': row['admission_id'] in authority.pending_results}
                assert legacy == fixture['legacy_refusal'], legacy
                print(json.dumps(legacy))
                return
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
