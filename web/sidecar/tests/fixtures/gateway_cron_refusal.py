"""Actual candidate refusal producer and settlement, with execution replaced by a tripwire."""
import asyncio
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.environ['HERMES_WEBUI_AGENT_DIR'])
from cron import scheduler
from gateway import session_cron
from gateway.session_authority import LiveSession, SessionAuthority
from gateway.session_contract import SessionRef
from gateway.session_settlement_recovery import commit_and_publish
from hermes_state import SessionDB
from hermes_state_runtime import admit_session_input, begin_runtime_epoch, claim_session_input

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
            response = await session_cron.execute(authority, ref, row, policy)
            captured = authority.pending_results.pop(row['admission_id'])
            settlement = {}
            commit_and_publish(authority, live, ref, row, response, 'failed', captured, settlement)
            assert run_job.call_count == 0
        assert settlement['settled']['outcome'] == 'failed'
        events = live.event_stream.since(live.event_stream.epoch, 0)
        completion = next(event['payload'] for event in events['events'] if event['type'] == 'message.complete')
        assert {**completion, 'admission_id': 'native-input'} == fixture['completion'], completion
        print(json.dumps({'completion': completion, 'scheduled_job_calls': run_job.call_count}))

asyncio.run(probe())
