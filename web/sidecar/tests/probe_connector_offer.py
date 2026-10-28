"""Real native schedule, file CAS and sightings over disposable records and a controlled clock."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import os
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
from talaria_sidecar.methods import connectors
home = Path(os.environ['HERMES_HOME'])
home.mkdir(parents=True, exist_ok=True)
if importlib.util.find_spec('hermes_cli.free_tier_offer') is None:
    assert connectors.sign_in_offer(home)['available'] is False
    print('Older Agent: no offer')
    raise SystemExit(0)
from hermes_cli import anon_auth as anon, free_tier_offer as native
if not hasattr(native, 'CONNECTOR'):
    assert connectors.sign_in_offer(home)['available'] is False
    print('Older Agent: no connector offer')
    raise SystemExit(0)
clock = [1000.0]
state = {'auth_method': 'anonymous', 'anon_token': 'synthetic-private-guest'}
allowed = [True]
with patch.object(native, '_path', lambda kind: home / 'free_tier' / native._RECORDS[kind]), \
     patch.object(native, '_clock', lambda: clock[0]), \
     patch.object(anon, 'current_nous_state', lambda: state), \
     patch.object(anon, 'guest_allowed', lambda: allowed[0]), \
     patch.object(anon, 'set_guest_flag', lambda key: state.update({key: True})):
    assert connectors.sign_in_offer(home)['due_in'] is None  # no app
    native.note_connected_apps_seen([{'connected': True}])
    assert connectors.sign_in_offer(home)['due_in'] == native.OFFER_DELAY_S
    clock[0] += native.OFFER_DELAY_S
    due = connectors.sign_in_offer(home)
    assert due['eligible'] and due['due_in'] == 0
    assert 'synthetic-private-guest' not in str(due)
    for scenario in ('trial', 'signed_in', 'opted_out'):
        original = state.copy()
        if scenario == 'trial': state[anon.WELCOME_CLAIM_FLAG] = True
        if scenario == 'signed_in': state['auth_method'] = 'oauth'
        if scenario == 'opted_out': allowed[0] = False
        assert connectors.sign_in_offer(home)['due_in'] is None, scenario
        state.clear(); state.update(original); allowed[0] = True
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: connectors.sign_in_offer(home, due['guest_id']), range(8)))
    assert sum(row['claimed'] for row in results) == 1
    clock[0] += native.REOFFER_AFTER_S[0] * 2
    assert connectors.sign_in_offer(home)['due_in'] is None  # Not now needs a later task
    native.note_connected_apps_seen([{'connected': True}])
    assert connectors.sign_in_offer(home)['due_in'] is None  # repeat sightings do not re-arm
    native.note_app_connected()
    assert connectors.sign_in_offer(home)['due_in'] == native.OFFER_DELAY_S
    clock[0] += native.OFFER_DELAY_S
    assert connectors.sign_in_offer(home, due['guest_id'])['claimed']
print('Native eligibility, sightings, claim-once and backoff passed')
