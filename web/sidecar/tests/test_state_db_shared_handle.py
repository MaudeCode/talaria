"""TAL-1191: ``state_db.*`` writes reuse the Agent's shared store handle for the profile home instead of a full writer
open (schema pass, WAL setup) and close-time checkpoint per RPC; a replaced ``state.db`` takes the next write. TAL-2591:
the same on the v0.23.3 storage interface, each profile home on its own store, every handle given back at shutdown.
Pinned Agent, in its own interpreter."""

from __future__ import annotations

import json
import subprocess
import textwrap

from conftest import AGENT_DIR, AGENT_PYTHON, NATIVE_STORE, SIDECAR_ROOT, isolated_env, requires_agent

pytestmark = requires_agent

_SCRIPT = textwrap.dedent("""
    import json, os, shutil, sqlite3
    from pathlib import Path
    from talaria_sidecar.methods import state_db

    home = Path(os.environ["HERMES_HOME"])
    other = home / "profiles" / "other"
    other.mkdir(parents=True)
    db_path = home / "state.db"
    opens, writes = [], []
    try:
        import persistence_assembly as store
    except ImportError:  # the shared SessionDB registry: count writer opens and writes
        import hermes_state
        for path in (db_path, other / "state.db"):
            hermes_state.SessionDB(db_path=path).close()
        init, execute_write = hermes_state.SessionDB.__init__, hermes_state.SessionDB._execute_write

        def counting_init(self, *args, **kwargs):
            opens.append(1)
            init(self, *args, **kwargs)

        def counting_write(self, *args, **kwargs):
            writes.append(1)
            return execute_write(self, *args, **kwargs)

        hermes_state.SessionDB.__init__, hermes_state.SessionDB._execute_write = counting_init, counting_write
        live = None
    else:  # the storage interface: count backend assemblies; its writes are its own
        for path in (home, other):
            store.open_persistence(store.profile_scope(home=path), eager=True).close()
        assemble = store._assemble
        store._assemble = lambda *args, **kwargs: opens.append(1) or assemble(*args, **kwargs)
        live = lambda: sorted(store._shared)
    usage = dict(input_tokens=3, output_tokens=4, model="stub", title="Shared", message_count=2)
    result = {"ok": [state_db.sync_session_usage(home, "webui-1", **usage), state_db.sync_session_usage(home, "webui-1", **usage)]}
    result["opens_warm"] = len(opens)
    writes.clear()
    result["ok"].append(state_db.sync_session_usage(home, "webui-1", **{**usage, "input_tokens": 5}))
    result["writes"] = len(writes)
    # Another profile's home is another store: its rows never reach this one.
    result["ok"].append(state_db.sync_session_start(other, "webui-other"))
    # An out-of-band replace (snapshot restore): a new inode under the same path.
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    shutil.copy(db_path, home / "restored.db")
    os.replace(home / "restored.db", db_path)
    result["ok"].append(state_db.sync_session_usage(home, "webui-1", **{**usage, "input_tokens": 7, "title": "Restored"}))
    result["opens_replaced"] = len(opens)
    result["live_before_release"] = live and len(live())
    state_db.release_all()
    result["live_after_release"] = live and len(live())
    for name, path in (("rows", db_path), ("other_rows", other / "state.db")):
        with sqlite3.connect(path) as conn:
            result[name] = [list(row) for row in conn.execute("SELECT id, input_tokens, title FROM sessions ORDER BY id")]
    print(json.dumps(result))
""")


def test_sync_usage_reuses_one_handle_until_the_file_is_replaced(hermes_home) -> None:
    out = subprocess.run([AGENT_PYTHON, "-c", _SCRIPT], env=isolated_env(hermes_home, PYTHONPATH=f"{SIDECAR_ROOT}:{AGENT_DIR}"),
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result["ok"] == [True] * 5
    # The replaced file took the last write; the other profile kept only its own row.
    assert result["rows"] == [["webui-1", 7, "Restored"]]
    assert result["other_rows"] == [["webui-other", 0, None]]
    if NATIVE_STORE:
        # One backend per profile home, kept across the replace (the Agent rebinds its file), all given back at shutdown.
        assert (result["opens_warm"], result["opens_replaced"]) == (1, 2)
        assert (result["live_before_release"], result["live_after_release"]) == (2, 0)
        return
    assert result["opens_warm"] == 1
    # A warm turn-end sync: the token update, its row guard, the title and the message count; no separate ensure_session.
    assert result["writes"] == 4
    # The other profile's open, then the fresh generation for the replaced file.
    assert result["opens_replaced"] == 3
