"""Real Agent persistence/cache APIs with in-memory config IO and parked requests.

No commands execute. The save boundary deterministically interleaves a revocation
and another approval check after the sidecar has captured its proposed grants.
"""

import contextlib
import os
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.append(sys.argv[1])

from hermes_constants import hermes_home_key
from hermes_cli import config
from tools import approval
from tools.approval_gateway_wait import _ApprovalEntry
from talaria_sidecar import home
from talaria_sidecar.methods import Registry, chat

# Keep real context-local home binding; credentials, terminals and processes are unrelated.
home._secret_scope = home._terminal_scope = contextlib.nullcontext
home._recover_processes = lambda _: None
base = Path(os.environ["HERMES_HOME"])
named = base / "profiles" / "named"
disk = {}
fail_write = False


def read():
    return {"command_allowlist": sorted(disk.get(hermes_home_key(), set()))}


def write(value):
    if fail_write:
        raise OSError("synthetic persistence failure")
    disk[hermes_home_key()] = set(value["command_allowlist"])


config.load_config = config.load_config_readonly = read
config.save_config = write
registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
chat.register(registry)
respond = registry.methods["approval.respond"]


def seed(profile, patterns):
    with home.scoped_home(profile):
        disk[hermes_home_key()] = set(patterns)
        approval.load_permanent_allowlist()


def pending(sid, rid, keys):
    entry = _ApprovalEntry({"request_id": rid, "pattern_keys": keys})
    approval._gateway_queues.setdefault(sid, []).append(entry)
    return entry


def answer(profile, sid, rid, choice="always"):
    return respond(None, {"profile_home": str(profile), "session_id": sid, "request_id": rid, "choice": choice})


seed(base, {"launch-only"})
seed(named, {"rm -rf build", "ls *"})
chosen = pending("chosen", "chosen", ["docker *", "chmod *"])
untouched = pending("chosen", "other", ["other *"])
save = approval.save_permanent_allowlist


def revoke_then_save(grants):
    disk[hermes_home_key()].remove("rm -rf build")
    # Oldest retained Agents refresh explicitly; newer ones sync on every check.
    if not hasattr(approval, "_sync_permanent_from_disk"):
        approval.load_permanent_allowlist()
    assert not approval.is_approved("observer", "rm -rf build")
    save(grants)


approval.save_permanent_allowlist = revoke_then_save
assert answer(named, "chosen", "chosen") == {"ok": True, "resolved": 1, "choice": "always"}
with home.scoped_home(named):
    assert "rm -rf build" not in disk[hermes_home_key()], f"revoked grant restored: {disk[hermes_home_key()]}"
    assert not approval.is_approved("observer", "rm -rf build")
    assert disk[hermes_home_key()] == {"ls *", "docker *", "chmod *"}
    assert approval.is_approved("observer", "docker *")
    assert approval.is_approved("chosen", "chmod *")
    assert not approval.is_approved("chosen", "other *")
assert chosen.result == "always" and chosen.event.is_set()
assert untouched.result is None and not untouched.event.is_set()
with home.scoped_home(base):
    assert disk[hermes_home_key()] == {"launch-only"}
    assert not approval.is_approved("observer", "docker *")

# A second independent grant commits while the first save is paused.
pending("first", "first", ["first *"])
pending("second", "second", ["second *"])


def second_then_save(grants):
    approval.save_permanent_allowlist = save
    assert answer(named, "second", "second")["resolved"] == 1
    save(grants)


approval.save_permanent_allowlist = second_then_save
assert answer(named, "first", "first")["resolved"] == 1
with home.scoped_home(named):
    assert {"first *", "second *"} <= disk[hermes_home_key()]

# Native best-effort persistence keeps the explicit grant in memory after an IO failure.
approval.save_permanent_allowlist = save
fail_write = True
pending("failed", "failed", ["unsaved *"])
assert answer(named, "failed", "failed")["resolved"] == 1
with home.scoped_home(named):
    assert "unsaved *" not in disk[hermes_home_key()]
    assert approval.is_approved("observer", "unsaved *")
fail_write = False
pending("retry", "retry", ["retry *"])
assert answer(named, "retry", "retry")["resolved"] == 1
with home.scoped_home(named):
    assert {"unsaved *", "retry *"} <= disk[hermes_home_key()]
print("revocation, profile isolation, independent grants and persistence failure passed")
