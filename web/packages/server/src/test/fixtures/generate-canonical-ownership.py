"""Record real v0.22.1 local receipts, queued admission and fresh diagnostic-session SQLite rows, without running a model.

Usage: <agent-python> generate-canonical-ownership.py <unmodified-agent-checkout>
The existing typed-row fixture format keeps the server regression independent of Python at runtime.
"""
import asyncio
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace

agent = Path(sys.argv[1]).resolve()
revision = subprocess.check_output(['git', '-C', str(agent), 'rev-parse', 'HEAD'], text=True).strip()
assert revision == '297552a9d646119871391d202509822cd86330df'
sys.path.insert(0, str(agent))

with tempfile.TemporaryDirectory(prefix='tal1036-') as home:
    os.environ['HERMES_HOME'] = home
    from gateway import run
    from gateway.config import GatewayConfig
    from gateway.session import SessionStore
    from gateway.session_authority import initialize_session_authority
    from gateway.session_contract import Principal
    from gateway.session_local import create_local_session
    from gateway.session_a2a import storage_source
    from hermes_state_runtime import admit_session_input
    run._load_gateway_config = lambda: {'platform_toolsets': {'cli': []}}

    async def seed():
        store = SessionStore(Path(home) / 'sessions', GatewayConfig())
        runner = SimpleNamespace(session_store=store, _session_db=store._db, adapters={}, _draining=False)
        authority = await initialize_session_authority(runner, profile_id='fixture', instance_id='fixture')
        actor = Principal('owner', 'fixture', frozenset({'session:create', 'session:read'}), 'socket')
        sessions, diagnostic = {}, {}
        for surface in ['cli', 'tui', 'acp']:
            ref = create_local_session(authority, actor, {'request_id': surface, 'source': surface, 'cwd': home, 'model': 'fixture', 'toolsets': []})
            sid = ref.session_id
            source = authority.sessions[sid].source
            authority.db.record_gateway_session_peer(sid, source=storage_source(authority.db, source, sid, 'local'), session_key=authority.sessions[sid].route, chat_id=source.chat_id)
            for role, text in [('user', 'Question one'), ('assistant', 'Answer one'), ('user', 'Question two'), ('assistant', 'Answer two')]:
                authority.db.append_message(sid, role, text)
            authority.db.set_session_title(sid, f'Canonical {surface.upper()} fixture')
            admit_session_input(authority.db, epoch=authority.epoch, principal_id=actor.subject, session_id=sid, request_id='pending', payload={'text': 'accepted but not started'})
            sessions[surface] = sid
        # TAL-1040: diagnostic sessions as the owner's session.create commits them, each with one exchange. Talaria
        # mints its own requests as `talaria-web:<id>`; the config-only one stands in for another client's.
        for mode, request_id, flags in [('safe', 'talaria-web:fixture-safe', {'safe_mode': True}),
                                        ('ignore_config', 'ignore_config', {'ignore_user_config': True})]:
            ref = create_local_session(authority, actor, {'request_id': request_id, 'source': 'cli', 'cwd': home, 'model': 'fixture', **flags})
            sid = ref.session_id
            source = authority.sessions[sid].source
            authority.db.record_gateway_session_peer(sid, source=storage_source(authority.db, source, sid, 'local'), session_key=authority.sessions[sid].route, chat_id=source.chat_id)
            for role, text in [('user', f'Diagnose {mode}'), ('assistant', f'{mode} answer')]:
                authority.db.append_message(sid, role, text)
            diagnostic[mode] = sid
        # A Web-created chat whose first turn never ran.
        ref = create_local_session(authority, actor, {'request_id': 'talaria-web:fixture-fresh', 'source': 'cli', 'cwd': home, 'model': 'fixture', 'safe_mode': True})
        source = authority.sessions[ref.session_id].source
        authority.db.record_gateway_session_peer(ref.session_id, source=storage_source(authority.db, source, ref.session_id, 'local'), session_key=authority.sessions[ref.session_id].route, chat_id=source.chat_id)
        diagnostic['fresh'] = ref.session_id
        authority.db.close()
        return sessions, diagnostic

    sessions, diagnostic = asyncio.run(seed())
    def sql_value(value):
        if value is None:
            return 'NULL'
        if isinstance(value, bytes):
            return f"X'{value.hex()}'"
        if isinstance(value, str):
            return "'" + value.replace(home, '/synthetic/agent-home').replace("'", "''") + "'"
        return repr(value)
    tables = ('sessions', 'messages', 'system_prompts', 'state_meta', 'session_admissions', 'worker_executions')
    with sqlite3.connect(Path(home) / 'state.db') as conn:
        marks = ','.join('?' for _ in tables)
        definitions = [r[0] for r in conn.execute(f"SELECT sql FROM sqlite_master WHERE tbl_name IN ({marks}) AND type IN ('table','index') AND sql IS NOT NULL ORDER BY type DESC,name", tables)]
        inserts = [f'INSERT INTO "{table}" VALUES({",".join(sql_value(v) for v in row)});' for table in tables for row in conn.execute(f'SELECT * FROM "{table}"')]
    fixture = {'agentRelease': 'v0.22.1', 'agentRevision': revision, 'sessions': sessions, 'diagnostic': diagnostic, 'schema': (';\n'.join(definitions) + ';').splitlines(), 'inserts': inserts}
    Path(__file__).with_name('canonical-ownership.json').write_text(json.dumps(fixture, indent=2) + '\n')
