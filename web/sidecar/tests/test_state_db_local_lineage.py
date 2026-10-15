"""Use the server's real v0.22.1 reset fixtures to verify the Agent-owned deletion target plan."""
from __future__ import annotations

import json
import sqlite3
import subprocess
from pathlib import Path

import pytest
from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, isolated_env, requires_agent

FIXTURE = Path(__file__).parents[2] / 'packages/server/src/test/fixtures/local-reset.json'


@requires_agent
@pytest.mark.parametrize('stage', ['reset', 'empty', 'multiple'])
def test_reset_target_plan_matches_server_fixture(hermes_home, stage):
    if not (AGENT_DIR / 'hermes_state_local_lineage.py').exists():
        pytest.skip('release predates canonical local reset receipts; legacy deletion suites apply')
    fixture = json.loads(FIXTURE.read_text())
    data = fixture['snapshots'][stage]
    with sqlite3.connect(hermes_home / 'state.db') as conn:
        for table, records in [('sessions', data['sessions']), ('messages', data['messages']), ('state_meta', data['meta'])]:
            keys = list(records[0])
            conn.execute(f"CREATE TABLE {table} ({','.join(keys)})")
            conn.executemany(f"INSERT INTO {table} VALUES ({','.join('?' for _ in keys)})", [tuple(r.values()) for r in records])
        conn.execute('CREATE INDEX idx_messages_session ON messages(session_id, timestamp)')
    script = '''
import json, sqlite3, sys
from pathlib import Path
from talaria_sidecar.methods.state_db import _local_lineage, _delete_rows, _ActiveWriteGuard
home = Path(sys.argv[1])
ids = json.loads(sys.argv[2])
with sqlite3.connect(home / 'state.db') as conn:
    conn.row_factory = sqlite3.Row
    for sid in ids:
        assert _local_lineage(conn, sid) == ids
try:
    _delete_rows(ids[-1], True, home, home / 'state.db', lambda conn, targets: set(ids) <= set(targets))
    raise AssertionError('expected atomic refusal')
except _ActiveWriteGuard:
    pass
with sqlite3.connect(home / 'state.db') as conn:
    assert conn.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == len(ids)
# This fixture has no runtime ledger: verify target/manifest plumbing only. Ledger retirement belongs to TAL-1034.
assert _delete_rows(ids[-1], True, home, home / 'state.db', lambda conn, targets: False)
with sqlite3.connect(home / 'state.db') as conn:
    assert conn.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 0, 'orphaned reset segment'
    assert conn.execute('SELECT COUNT(*) FROM messages').fetchone()[0] == 0
'''
    subprocess.run([AGENT_PYTHON, '-c', script, str(hermes_home), json.dumps([r['id'] for r in data['sessions']])],
                   env=isolated_env(hermes_home, PYTHONPATH=f'{SIDECAR_ROOT}:{AGENT_DIR}'), check=True, timeout=60)
