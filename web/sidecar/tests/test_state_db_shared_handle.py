"""TAL-1191: ``state_db.*`` writes reuse the Agent's shared ``SessionDB`` for the profile home instead of a full writer
open (schema pass, WAL setup) and close-time checkpoint per RPC; a replaced ``state.db`` gets a fresh handle. Pinned
Agent, in its own interpreter."""

from __future__ import annotations

import json
import subprocess
import textwrap

from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT, isolated_env, requires_agent

pytestmark = requires_agent

_SCRIPT = textwrap.dedent("""
    import json, os, shutil, sqlite3
    from pathlib import Path
    import hermes_state
    from talaria_sidecar.methods import state_db

    home = Path(os.environ["HERMES_HOME"])
    db_path = home / "state.db"
    hermes_state.SessionDB(db_path=db_path).close()
    opens, writes = [], []
    init, execute_write = hermes_state.SessionDB.__init__, hermes_state.SessionDB._execute_write

    def counting_init(self, *args, **kwargs):
        opens.append(1)
        init(self, *args, **kwargs)

    def counting_write(self, *args, **kwargs):
        writes.append(1)
        return execute_write(self, *args, **kwargs)

    hermes_state.SessionDB.__init__, hermes_state.SessionDB._execute_write = counting_init, counting_write
    usage = dict(input_tokens=3, output_tokens=4, model="stub", title="Shared", message_count=2)
    result = {"ok": [state_db.sync_session_usage(home, "webui-1", **usage), state_db.sync_session_usage(home, "webui-1", **usage)]}
    result["opens_warm"] = len(opens)
    writes.clear()
    result["ok"].append(state_db.sync_session_usage(home, "webui-1", **{**usage, "input_tokens": 5}))
    result["writes"] = len(writes)
    # An out-of-band replace (snapshot restore): a new inode under the same path.
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    shutil.copy(db_path, home / "restored.db")
    os.replace(home / "restored.db", db_path)
    result["ok"].append(state_db.sync_session_usage(home, "webui-1", **usage))
    result["opens_replaced"] = len(opens)
    getattr(state_db, "release_all", lambda: None)()
    with sqlite3.connect(db_path) as conn:
        result["row"] = list(conn.execute("SELECT input_tokens, title, message_count FROM sessions WHERE id = 'webui-1'").fetchone())
    print(json.dumps(result))
""")


def test_sync_usage_reuses_one_handle_until_the_file_is_replaced(hermes_home) -> None:
    out = subprocess.run([AGENT_PYTHON, "-c", _SCRIPT], env=isolated_env(hermes_home, PYTHONPATH=f"{SIDECAR_ROOT}:{AGENT_DIR}"),
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result["ok"] == [True, True, True, True]
    assert result["opens_warm"] == 1
    # A warm turn-end sync: the token update, its row guard, the title and the message count; no separate ensure_session.
    assert result["writes"] == 4
    assert result["opens_replaced"] == 2
    assert result["row"] == [3, "Shared", 2]
