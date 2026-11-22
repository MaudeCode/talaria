"""The server's real v0.22.1 reset fixtures must match canonical sidecar deletion targets."""
from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest
from conftest import requires_agent, run_store_script

FIXTURE = Path(__file__).parents[2] / 'packages/server/src/test/fixtures/local-reset.json'


@requires_agent
@pytest.mark.parametrize('stage', ['reset', 'compressed', 'empty', 'multiple'])
def test_reset_target_plan_matches_server_fixture(hermes_home, stage):
    data = json.loads(FIXTURE.read_text())['snapshots'][stage]
    ids = [row['id'] for row in data['sessions']]
    run_store_script(hermes_home, '')  # the Agent creates its schema
    with closing(sqlite3.connect(hermes_home / 'state.db')) as conn, conn:
        for table, records in [('sessions', data['sessions']), ('messages', data['messages']), ('state_meta', data['meta'])]:
            keys = list(records[0])
            conn.executemany(f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})", [tuple(r.values()) for r in records])
    script = f'''
import json, sqlite3
from talaria_sidecar.methods.state_db import delete_cli_session
ids = {ids!r}
conn = sqlite3.connect(HOME / 'state.db', isolation_level=None)
rows = lambda sql: conn.execute(sql).fetchall()
def write(sql, *args):
    conn.execute(sql, args)
if store:
    targets = lambda sid: store.sessions.delete_targets(sid)
else:
    from hermes_state_mutation_guards import delete_targets
    def targets(sid):
        with db._read_ctx() as read:
            return delete_targets(read, sid)
for sid in ids:
    assert set(targets(sid)) == set(ids)
key = 'gateway.local_policy.v1:' + ids[0]
raw = db.get_meta(key)
# An unreadable owner receipt cannot turn its physical tip into an independent delete target.
db.set_meta(key, '{{malformed')
assert delete_cli_session(HOME, ids[-1]) == {{'ok': False, 'committed': False}}
assert len(rows('SELECT id FROM sessions')) == len(ids)
db.set_meta(key, raw)
previous_config = rows(f"SELECT model_config FROM sessions WHERE id='{{ids[-1]}}'")[0][0]
config = json.loads(previous_config or '{{}}')
config['_branched_from'] = ids[-2]
write('UPDATE sessions SET model_config=? WHERE id=?', json.dumps(config), ids[-1])
assert delete_cli_session(HOME, ids[-1]) == {{'ok': False, 'committed': False}}, 'explicit branch attached to receipt'
write('UPDATE sessions SET model_config=? WHERE id=?', previous_config, ids[-1])
previous_user = rows(f"SELECT user_id FROM sessions WHERE id='{{ids[-1]}}'")[0][0]
write('UPDATE sessions SET user_id=? WHERE id=?', 'foreign-principal', ids[-1])
assert delete_cli_session(HOME, ids[-1]) == {{'ok': False, 'committed': False}}, 'foreign receipt member deleted'
write('UPDATE sessions SET user_id=? WHERE id=?', previous_user, ids[-1])
assert len(rows('SELECT id FROM sessions')) == len(ids)
assert len(rows('SELECT id FROM messages')) == {len(data['messages'])}
sessions = HOME / 'sessions'
sessions.mkdir(exist_ok=True)
for sid in ids:
    (sessions / (sid + '.json')).write_text('synthetic transcript')
assert lock(ids[0], 'other-terminal-turn')
assert delete_cli_session(HOME, ids[-1]) == {{'ok': False, 'committed': False, 'refused': 'active_turn'}}
assert len(rows('SELECT id FROM sessions')) == len(ids)
assert len(list(sessions.iterdir())) == len(ids)
unlock(ids[0], 'other-terminal-turn')
deleted = delete_cli_session(HOME, ids[-1])
assert deleted['ok'] is True
assert set(deleted['deleted_ids']) == set(ids)
assert rows('SELECT id FROM sessions') == [], 'orphaned reset segment'
assert rows('SELECT id FROM messages') == []
assert rows("SELECT key FROM state_meta WHERE key GLOB 'gateway.local_policy.v1:*'") == []
assert list(sessions.iterdir()) == []
conn.close()
'''
    run_store_script(hermes_home, script, sidecar=True)
