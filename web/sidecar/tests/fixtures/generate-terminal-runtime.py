"""Record disposable v0.22.1 terminal history for deletion on older Agents.

Run with the base Agent interpreter: python generate-terminal-runtime.py <agent-dir>.
Like generate-canonical-ownership.py, this records real Agent SQL rather than emulating its ledger.
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

agent = Path(sys.argv[1]).resolve()
revision = subprocess.check_output(['git', '-C', str(agent), 'rev-parse', 'HEAD'], text=True).strip()
assert revision == '297552a9d646119871391d202509822cd86330df'
sys.path.insert(0, str(agent))

with tempfile.TemporaryDirectory(prefix='tal1053-') as home:
    os.environ['HERMES_HOME'] = home
    os.environ['HERMES_STATE_DB_GUARD_BYPASS'] = '1'
    from hermes_state import SessionDB
    import hermes_state_runtime as rt
    with SessionDB(Path(home) / 'state.db') as db:
        db.create_session('cli-root', source='cli')
        db.append_message('cli-root', 'user', 'synthetic retained prompt')
        epoch = rt.begin_runtime_epoch(db, instance_id='fixture')
        admission = rt.admit_session_input(db, epoch=epoch, principal_id='human', session_id='cli-root', request_id='once', payload={'text': 'synthetic retained prompt'})
        claim = rt.claim_session_input(db, epoch=epoch, session_id='cli-root')
        rt.settle_session_input(db, epoch=epoch, admission_id=admission['admission_id'], generation=claim['generation'], outcome='completed')
        db.create_session('worker-child', source='subagent', parent_session_id='cli-root', model_config={'_delegate_from': 'cli-root'})
        rt.register_worker_execution(db, epoch=epoch, execution_id='worker', session_id='worker-child', generation=0, kind='compute', adoption_secret='synthetic-secret')
        rt.mutate_worker_execution(db, epoch=epoch, execution_id='worker', session_id='worker-child', generation=0, sequence=1, operation='execution.finish', payload={})
        db.end_session('cli-root', 'compression')
        db.create_session('cli-tip', source='cli', parent_session_id='cli-root')
        db.append_message('cli-tip', 'user', 'synthetic continuation')
        db.create_session('worker-only-parent', source='cli')
        db.create_session('worker-only-child', source='subagent', parent_session_id='worker-only-parent', model_config={'_delegate_from': 'worker-only-parent'})
        db.end_session('worker-only-parent', 'compression')
        db.end_session('worker-only-child', 'compression')
        db.create_session('worker-only-tip', source='subagent', parent_session_id='worker-only-child', model_config={'_delegate_from': 'worker-only-parent'})
        rt.register_worker_execution(db, epoch=epoch, execution_id='continued-worker', session_id='worker-only-tip', generation=0, kind='compute', adoption_secret='synthetic-secret')
        rt.mutate_worker_execution(db, epoch=epoch, execution_id='continued-worker', session_id='worker-only-tip', generation=0, sequence=1, operation='execution.finish', payload={})
    with sqlite3.connect(Path(home) / 'state.db') as conn:
        tables = ('sessions', 'messages', 'system_prompts', 'state_meta', 'session_admissions', 'worker_executions', 'worker_receipts')
        marks = ','.join('?' for _ in tables)
        definitions = [r[0] + ';' for r in conn.execute(f"SELECT sql FROM sqlite_master WHERE tbl_name IN ({marks}) AND type='table' ORDER BY name", tables)]
        # Keep the actual downgrade guard, without unrelated FTS virtual tables.
        guard = conn.execute("SELECT sql FROM sqlite_master WHERE name='sessions_runtime_ledger_delete_guard'").fetchone()[0]
        inserts = [sql for sql in conn.iterdump() if any(sql.startswith(f'INSERT INTO "{table}"') for table in tables)]
        dump = [*definitions, *inserts, guard + ';']
    Path(__file__).with_name('terminal-runtime.json').write_text(json.dumps({'agentRevision': revision, 'sql': dump}, indent=2) + '\n')
