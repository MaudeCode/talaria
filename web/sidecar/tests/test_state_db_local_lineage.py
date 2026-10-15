"""The server's real v0.22.1 reset fixtures must match canonical sidecar deletion targets."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, isolated_env, requires_agent

FIXTURE = Path(__file__).parents[2] / 'packages/server/src/test/fixtures/local-reset.json'


@requires_agent
@pytest.mark.parametrize('stage', ['reset', 'compressed', 'empty', 'multiple'])
def test_reset_target_plan_matches_server_fixture(hermes_home, stage):
    if not (AGENT_DIR / 'hermes_state_local_lineage.py').exists():
        pytest.skip('release predates canonical local reset receipts; legacy deletion suites apply')
    script = '''
import json, sys
from pathlib import Path
from hermes_state import SessionDB
from hermes_state_mutation_guards import delete_targets
from talaria_sidecar.methods.state_db import delete_cli_session
home = Path(sys.argv[1])
data = json.loads(Path(sys.argv[2]).read_text())['snapshots'][sys.argv[3]]
ids = [row['id'] for row in data['sessions']]
db = SessionDB(home / 'state.db')
def seed(conn):
    for table, records in [('sessions', data['sessions']), ('messages', data['messages']), ('state_meta', data['meta'])]:
        keys = list(records[0])
        conn.executemany(f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})", [tuple(r.values()) for r in records])
db._execute_write(seed)
with db._read_ctx() as conn:
    for sid in ids:
        assert set(delete_targets(conn, sid)) == set(ids)
key = 'gateway.local_policy.v1:' + ids[0]
raw = db.get_meta(key)
# An unreadable owner receipt cannot turn its physical tip into an independent delete target.
db.set_meta(key, '{malformed')
assert delete_cli_session(home, ids[-1], True) == {'ok': False}
assert len(db._read_all('SELECT id FROM sessions')) == len(ids)
db.set_meta(key, raw)
previous_config = db._read_one('SELECT model_config FROM sessions WHERE id=?', (ids[-1],))[0]
config = json.loads(previous_config or '{}')
config['_branched_from'] = ids[-2]
db._execute_write(lambda conn: conn.execute('UPDATE sessions SET model_config=? WHERE id=?', (json.dumps(config), ids[-1])))
assert delete_cli_session(home, ids[-1], True) == {'ok': False}, 'explicit branch attached to receipt'
db._execute_write(lambda conn: conn.execute('UPDATE sessions SET model_config=? WHERE id=?', (previous_config, ids[-1])))
previous_user = db._read_one('SELECT user_id FROM sessions WHERE id=?', (ids[-1],))[0]
db._execute_write(lambda conn: conn.execute('UPDATE sessions SET user_id=? WHERE id=?', ('foreign-principal', ids[-1])))
assert delete_cli_session(home, ids[-1], True) == {'ok': False}, 'foreign receipt member deleted'
db._execute_write(lambda conn: conn.execute('UPDATE sessions SET user_id=? WHERE id=?', (previous_user, ids[-1])))
assert len(db._read_all('SELECT id FROM sessions')) == len(ids)
assert len(db._read_all('SELECT id FROM messages')) == len(data['messages'])
sessions = home / 'sessions'
sessions.mkdir(exist_ok=True)
for sid in ids:
    (sessions / (sid + '.json')).write_text('synthetic transcript')
assert db.try_acquire_compression_lock(ids[0], 'other-terminal-turn')
assert delete_cli_session(home, ids[-1], True) == {'ok': False, 'refused': 'active_turn'}
assert len(db._read_all('SELECT id FROM sessions')) == len(ids)
assert len(list(sessions.iterdir())) == len(ids)
db.release_compression_lock(ids[0], 'other-terminal-turn')
deleted = delete_cli_session(home, ids[-1], True)
assert deleted['ok'] is True
assert set(deleted['deleted_ids']) == set(ids)
assert db._read_all('SELECT id FROM sessions') == [], 'orphaned reset segment'
assert db._read_all('SELECT id FROM messages') == []
assert db._read_all("SELECT key FROM state_meta WHERE key GLOB 'gateway.local_policy.v1:*'") == []
assert list(sessions.iterdir()) == []
db.close()
'''
    subprocess.run([AGENT_PYTHON, '-c', script, str(hermes_home), str(FIXTURE), stage],
                   env=isolated_env(hermes_home, PYTHONPATH=f'{SIDECAR_ROOT}:{AGENT_DIR}'), check=True, timeout=60)
