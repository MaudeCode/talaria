"""Diagnostic creation modes on a real disposable owner, a loopback provider and pre-import witnesses.

A sitecustomize audit hook in every owner/worker interpreter records opens under the sentinel
roots, imports of sentinel modules and process launches. The worker's records prove what safe
mode never touched; the provider's requests and the witness files are the positive controls.

Usage: gateway_execution_peer.py SCENARIO, one of SCENARIOS, each on its own disposable owner (TAL-2493).
"""
import asyncio
from contextlib import ExitStack, contextmanager
import io
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import time

STARTED = time.monotonic()
agent = Path(os.environ["TALARIA_WEB_AGENT_DIR"])
sys.path[:0] = [str(agent), str(agent / "tests/gateway/fixtures"), str(Path(__file__).resolve().parents[1])]
from peer_phases import POLL_SECONDS, Phases, report_modes

SCENARIOS = ["controls", "restart-config", "restart-safe", "safe", "safe-sibling", "safe-error"]
# The MCP sentinel witnesses a safe worker's launches. Every owner boot waits out its connect timeout, so only the
# scenarios that audit those launches, or read the whole profile, configure it.
MCP_SCENARIOS = {"controls", "safe", "safe-error"}
from local_recovery_probe import Model, child_env, daemon as owner_daemon, rpc, websocket
from conftest import SidecarProcess

PHASES = Phases(STARTED)


def daemon(*args, **kwargs):
    return PHASES.daemon(owner_daemon, *args, **kwargs)


WITNESS_HOOK = '''
import json, os, sys, threading
_log = os.environ.get("TALARIA_WITNESS_LOG")
_roots = tuple(p for p in os.environ.get("TALARIA_WITNESS_ROOTS", "").split(os.pathsep) if p)
_guard = threading.local()
_worker = "agent.managed_worker" in getattr(sys, "orig_argv", [])

def _record(kind, value):
    _guard.busy = True
    try:
        fd = os.open(_log, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, (json.dumps({"pid": os.getpid(), "worker": _worker, "kind": kind, "value": value}) + "\\n").encode())
        finally:
            os.close(fd)
    finally:
        _guard.busy = False

def _hook(event, args):
    if getattr(_guard, "busy", False):
        return
    if event == "open" and args and isinstance(args[0], (str, bytes, os.PathLike)):
        path = os.fsdecode(args[0])
        if path.startswith(_roots):
            _record("open", path)
    elif event == "subprocess.Popen":
        _record("spawn", [os.fsdecode(a) for a in args[1]] if isinstance(args[1], (list, tuple)) else str(args[1]))
    elif event == "import" and args and isinstance(args[0], str) and "sentinel" in args[0]:
        _record("import", args[0])

if _log and _roots:
    sys.addaudithook(_hook)
'''
SENTINELS = ("CONFIG_SENTINEL", "SOUL_SENTINEL", "MEMORY_SENTINEL", "USER_SENTINEL", "RULES_SENTINEL")
# Everything a safe worker must never open: profile config/.env, rules, soul, skills, memory and plugins.
FORBIDDEN = ("config.yaml", ".env", "SOUL.md", "AGENTS.md", "/memories/", "/skills/", "/plugins/", "mcp_sentinel")


class Provider(Model):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        body = json.loads(raw)
        text = next((m.get("content", "") for m in reversed(body.get("messages", [])) if m["role"] == "user"), "")
        # Keyed by the prompt it carries: concurrent owners' requests arrive in any order (test-audit rule fake).
        self.server.authorization.append((text, self.headers.get("Authorization")))
        # A safe worker ignores the profile config, so it also names the chat from the held prompt. Holding that call too
        # would only make the stopped worker wait out its 10 s join of the title thread (TAL-1780).
        title = text == "BLOCK_STARTED" and body["messages"][0]["content"].startswith("You name chat sessions")
        if text == "FAIL_PROVIDER" or title:
            self.server.requests.append(body)
            payload = json.dumps({"choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": '{"title": "Fixture"}'}}]} if title
                                 else {"error": {"message": "synthetic invalid request", "type": "invalid_request_error"}}).encode()
            self.send_response(200 if title else 400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.rfile = io.BytesIO(raw)
        super().do_POST()


def write_profile(home: Path, workspace: Path, url: str, witness: Path, tag: str = "", mcp: bool = True):
    (home / "SOUL.md").write_text(f"{tag}SOUL_SENTINEL persona.\n")
    (home / "memories").mkdir(parents=True)
    (home / "memories/MEMORY.md").write_text(f"{tag}MEMORY_SENTINEL fact.\n")
    (home / "memories/USER.md").write_text(f"{tag}USER_SENTINEL fact.\n")
    skill = home / "skills/sentinel-skill"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: sentinel-skill\ndescription: SKILL_SENTINEL description\n---\nSKILL_SENTINEL body\n")
    plugin = home / "plugins/sentinel"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text("name: sentinel\nversion: 1.0.0\nkind: standalone\n")
    (plugin / "__init__.py").write_text(f"from pathlib import Path\nPath({str(witness / (tag + 'plugin-imported'))!r}).touch()\ndef register(ctx): pass\n")
    (home / "mcp_sentinel.py").write_text(f"from pathlib import Path\nPath({str(witness / (tag + 'mcp-spawned'))!r}).touch()\nimport sys\nsys.stdin.read()\n")
    (home / ".env").write_text("TALARIA_ENV_SENTINEL=present\n")
    (home / "config.yaml").write_text(json.dumps({
        "gateway": {"multiplex_profiles": False, **({"standalone": True} if tag else {})},
        "model": {"provider": "custom", "default": "owner-fixture", "base_url": url},
        "agent": {"system_prompt": f"{tag}CONFIG_SENTINEL prompt"},
        "plugins": {"enabled": ["sentinel"]},
        # The sentinel only witnesses a spawn and never answers, so each owner start waits out this connect timeout. The
        # spawn happens first; nothing here depends on how long the owner then waits for a handshake (TAL-1599, TAL-1780).
        "mcp_servers": {"sentinel": {"command": sys.executable, "args": [str(home / "mcp_sentinel.py")], "connect_timeout": 1}} if mcp else {},
        "auxiliary": {"title_generation": {"enabled": False}}, "platform_toolsets": {"cli": []},
    }))
    (workspace / "AGENTS.md").write_text("RULES_SENTINEL project rule.\n")


class Witness:
    def __init__(self, path: Path):
        self.path, self.offset = path, 0

    def take(self) -> list[dict]:
        lines = self.path.read_text().splitlines() if self.path.exists() else []
        events, self.offset = [json.loads(line) for line in lines[self.offset:]], len(lines)
        return events


def request_for(peer, text):
    return [r for r in peer.requests if next((m.get("content") for m in reversed(r.get("messages", [])) if m["role"] == "user"), None) == text]


def sentinels_in(requests, tag=""):
    blob = json.dumps(requests)
    return {s for s in SENTINELS if tag + s in blob}


def worker_opened(events):
    return [e["value"] for e in events if e["worker"] and e["kind"] == "open"]


def worker_reads(events):
    """Forbidden worker activity: a profile read, a sentinel import or a launch naming a sentinel (MCP)."""
    return sorted({json.dumps(e) for e in events if e["worker"] and (
        e["kind"] == "import" or any(f in json.dumps(e["value"]) for f in FORBIDDEN))})


def settle(call, sid, deadline=60):
    end = time.monotonic() + deadline
    while True:
        result = call("snapshot", sid)
        assert result["state"] == "attached", result
        if not result["snapshot"]["pending"] and not result["snapshot"]["running"]:
            return result
        assert time.monotonic() < end, result
        time.sleep(POLL_SECONDS)


def gone(pids, deadline=45):
    end = time.monotonic() + deadline
    while True:
        alive = []
        for pid in pids:
            try:
                os.kill(pid, 0)
                alive.append(pid)
            except ProcessLookupError:
                pass
        if not alive:
            return
        assert time.monotonic() < end, f"managed workers still alive: {alive}"
        time.sleep(.1)


def released(home: Path):
    """The Agent keeps each execution's journal; a settled worker leaves nothing undelivered or locked."""
    import fcntl
    journals = list((home / "worker-outboxes").glob("*/pending.json"))
    assert journals, "no managed worker journal"
    for journal in journals:
        assert json.loads(journal.read_text())["pending"] == [], journal.read_text()
        with (journal.parent / "owner.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


def receipt_policy(home: Path, sid: str) -> dict:
    import sqlite3
    from contextlib import closing
    with closing(sqlite3.connect((home / "state.db").as_uri() + "?mode=ro", uri=True)) as db:
        (raw,) = db.execute("SELECT value FROM state_meta WHERE key = ?", ("gateway.local_policy.v1:" + sid,)).fetchone()
    policy = json.loads(raw)["policy"]
    return {key: policy[key] for key in ("safe_mode", "ignore_user_config")}


@contextmanager
def daemons(*owners):
    """One disposable owner per (home, env), started in order."""
    with ExitStack() as stack:
        yield [stack.enter_context(daemon(agent, home, env, barrier=False)) for home, env in owners]


class Owner:
    """The sidecar calls both scenarios make against one disposable owner home."""

    def __init__(self, home: Path, workspace: Path, peer):
        self.home, self.workspace, self.peer = home, workspace, peer
        self.sidecar = SidecarProcess(home)

    def create(self, mode, request_id, **extra):
        return self.sidecar.result("gateway.create", {"profile_home": str(self.home), "request_id": request_id, "execution_mode": mode,
            "cwd": str(self.workspace), "model": "owner-fixture", "provider": "custom", "base_url": self.peer.url, **extra})

    def call(self, action, sid, target=None, **params):
        return self.sidecar.result("gateway.session", {"profile_home": str(target or self.home), "session_id": sid, "action": action, **params})

    def turn(self, sid, text, target=None):
        submitted = self.call("submit", sid, target, request_id="turn-" + text, text=text)
        assert submitted["receipt"], submitted
        return settle(lambda action, s: self.call(action, s, target), sid)


def natives(ids, workspace, owners):
    async def create():
        for name, target, desc in owners:
            async with websocket(target, desc) as native:
                created = await rpc(native, "session.create", request_id="positive-" + name, source="cli", cwd=str(workspace))
                ids[name] = created["result"]["session_id"]
    asyncio.run(create())


def probe_controls(home: Path, workspace: Path, witness: Path, peer, env):
    """Positive controls: the ordinary owner reads the profile; ignore_config drops only its config."""
    owner, audit, ids = Owner(home, workspace, peer), Witness(witness / "audit.jsonl"), {}
    try:
        with daemons((home, env)) as [(_, desc)]:
            probed = owner.sidecar.result("gateway.create", {"profile_home": str(home), "probe": True})
            assert probed == {"state": "attached", "reason": None, "snapshot": None, "receipt": None}, probed
            natives(ids, workspace, [("normal", home, desc)])
            audit.take()
            owner.turn(ids["normal"], "NORMAL_CONTROL")
            assert sentinels_in(request_for(peer, "NORMAL_CONTROL")) == set(SENTINELS), request_for(peer, "NORMAL_CONTROL")
            assert (witness / "plugin-imported").exists()
            config_only = owner.create("ignore_config", "diagnostic-config")
            assert config_only["state"] == "attached", config_only
            ids["config"] = config_only["snapshot"]["session_id"]
            owner.turn(ids["config"], "CONFIG_ONLY_CONTROL")
            assert sentinels_in(request_for(peer, "CONFIG_ONLY_CONTROL")) == set(SENTINELS) - {"CONFIG_SENTINEL"}
            config_events = audit.take()
            assert any(path.endswith("SOUL.md") for path in worker_opened(config_events)), config_events
            assert not any(path.endswith(("config.yaml", ".env")) for path in worker_opened(config_events)), config_events
        print(json.dumps({"scenario": "controls", "sessions": ids, "provider_requests": len(peer.requests)}))
    finally:
        peer.release.set()
        owner.sidecar.close()


def probe_restart(home: Path, workspace: Path, witness: Path, peer, env, mode: str):
    """One diagnostic session's frozen policy across an owner restart."""
    owner, audit = Owner(home, workspace, peer), Witness(witness / "audit.jsonl")
    call, safe = owner.call, mode == "safe"
    try:
        with daemons((home, env)):
            created = owner.create(mode, "diagnostic-" + mode)
            assert created["state"] == "attached" and created["snapshot"]["messages"] == [], created
            sid = created["snapshot"]["session_id"]

        # The frozen policy survives an owner restart. v0.22.1 binds DEFAULT_CONFIG's voice.record_key
        # as a launch-only secret, so a restarted owner refuses a bypass turn before any worker starts
        # (launch_credentials_unavailable). Either way nothing runs under a weaker policy.
        with daemons((home, env)):
            text, expected = ("SAFE_AFTER_RESTART", set()) if safe else ("CONFIG_AFTER_RESTART", set(SENTINELS) - {"CONFIG_SENTINEL"})
            assert receipt_policy(home, sid) == {"safe_mode": safe, "ignore_user_config": True}
            submitted = call("submit", sid, request_id="restart-" + mode, text=text)
            assert submitted["receipt"], submitted
            end = time.monotonic() + 60
            while True:
                current = call("snapshot", sid)
                pending = current["snapshot"]["pending"]
                if not current["snapshot"]["running"] and all(p["status"] in {"unknown", "terminal"} for p in pending):
                    break
                assert time.monotonic() < end, current
                time.sleep(POLL_SECONDS)
            if request_for(peer, text):
                assert sentinels_in(request_for(peer, text)) == expected, request_for(peer, text)
            else:
                assert [p["status"] for p in pending] == ["unknown"], pending
                discarded = call("discard", sid, admission_id=pending[0]["admission_id"],
                                 execution_generation=pending[0]["execution_generation"])
                assert discarded["state"] == "attached", discarded
                settle(call, sid)
            events = audit.take()
            gone({e["pid"] for e in events if e["worker"]})
            assert not any(path.endswith(("config.yaml", ".env")) for path in worker_opened(events)), events
        print(json.dumps({"scenario": "restart-" + mode, "session": sid, "provider_requests": len(peer.requests)}))
    finally:
        peer.release.set()
        owner.sidecar.close()


def probe_safe(home: Path, workspace: Path, witness: Path, peer, env):
    """Safe: a fresh private worker with no profile reads, imports or MCP launches, beside an ordinary session on the same
    owner, keeping its policy across cancel and interrupt."""
    owner, audit, ids = Owner(home, workspace, peer), Witness(witness / "audit.jsonl"), {}
    call, create, turn = owner.call, owner.create, owner.turn
    try:
        with daemons((home, env)) as [(_, desc)]:
            natives(ids, workspace, [("normal", home, desc)])
            audit.take()
            safe = create("safe", "diagnostic-safe")
            assert safe["state"] == "attached" and safe["snapshot"]["messages"] == [], safe
            ids["safe"] = safe["snapshot"]["session_id"]
            again = create("safe", "diagnostic-safe")
            assert again["snapshot"]["session_id"] == ids["safe"], again
            conflict = create("ignore_config", "diagnostic-safe")
            assert conflict["state"] == "refused", conflict
            blocked = call("submit", ids["safe"], request_id="safe-block", text="BLOCK_STARTED")
            assert blocked["receipt"], blocked
            assert peer.blocked.wait(30), "safe turn did not reach the provider"
            # A concurrent ordinary session on the same owner keeps its behavior and environment.
            turn(ids["normal"], "CONCURRENT_NORMAL")
            assert sentinels_in(request_for(peer, "CONCURRENT_NORMAL")) == set(SENTINELS)
            queued = call("submit", ids["safe"], request_id="safe-queued", text="NEVER_RUN_CANCELLED")
            cancelled = call("cancel", ids["safe"], admission_id=queued["receipt"]["admission_id"])
            assert cancelled["receipt"]["status"] == "terminal" and cancelled["receipt"]["outcome"] == "cancelled", cancelled
            running = call("snapshot", ids["safe"])
            stopped = call("interrupt", ids["safe"], execution_generation=running["snapshot"]["execution_generation"])
            assert stopped["state"] == "attached", stopped
            settle(call, ids["safe"])
            peer.release.set()
            events = audit.take()
            workers = {e["pid"] for e in events if e["worker"]}
            assert workers, "safe execution did not use a managed worker"
            gone(workers)
            assert worker_reads(events) == [], worker_reads(events)
            assert not request_for(peer, "NEVER_RUN_CANCELLED")
            assert sentinels_in(request_for(peer, "BLOCK_STARTED")) == set(), request_for(peer, "BLOCK_STARTED")
        released(home)
        print(json.dumps({"scenario": "safe", "sessions": ids, "provider_requests": len(peer.requests)}))
    finally:
        peer.release.set()
        owner.sidecar.close()


def probe_safe_sibling(home: Path, alpha: Path, workspace: Path, witness: Path, peer, env, alpha_env):
    """A sibling profile's own owner keeps its behavior, environment and credential while a safe turn is running."""
    owner, audit, ids = Owner(home, workspace, peer), Witness(witness / "audit.jsonl"), {}
    try:
        with daemons((home, env), (alpha, alpha_env)) as [_, (_, alpha_desc)]:
            natives(ids, workspace, [("alpha", alpha, alpha_desc)])
            safe = owner.create("safe", "diagnostic-safe")
            assert safe["state"] == "attached" and safe["snapshot"]["messages"] == [], safe
            ids["safe"] = safe["snapshot"]["session_id"]
            blocked = owner.call("submit", ids["safe"], request_id="safe-block", text="BLOCK_STARTED")
            assert blocked["receipt"], blocked
            assert peer.blocked.wait(30), "safe turn did not reach the provider"
            owner.turn(ids["alpha"], "SIBLING_NORMAL", alpha)
            # The workspace rules are shared; every profile-owned sentinel is alpha's own.
            assert sentinels_in(request_for(peer, "SIBLING_NORMAL"), "ALPHA_") == set(SENTINELS) - {"RULES_SENTINEL"}
            assert "RULES_SENTINEL" in sentinels_in(request_for(peer, "SIBLING_NORMAL"))
            assert {auth for text, auth in peer.authorization if text == "SIBLING_NORMAL"} == {"Bearer alpha-only"}, peer.authorization
            peer.release.set()
            settle(owner.call, ids["safe"])
            gone({e["pid"] for e in audit.take() if e["worker"]})
        print(json.dumps({"scenario": "safe-sibling", "sessions": ids, "provider_requests": len(peer.requests)}))
    finally:
        peer.release.set()
        owner.sidecar.close()


def probe_safe_error(home: Path, workspace: Path, witness: Path, peer, env):
    """Error cleanup keeps the policy: the turn after a provider failure is still safe."""
    owner, audit = Owner(home, workspace, peer), Witness(witness / "audit.jsonl")
    turn = owner.turn
    try:
        with daemons((home, env)):
            safe = owner.create("safe", "diagnostic-safe")
            assert safe["state"] == "attached" and safe["snapshot"]["messages"] == [], safe
            sid = safe["snapshot"]["session_id"]
            audit.take()
            failed = turn(sid, "FAIL_PROVIDER")
            assert failed["snapshot"]["pending"] == [], failed
            turn(sid, "SAFE_AFTER_ERROR")
            assert sentinels_in(request_for(peer, "SAFE_AFTER_ERROR")) == set()
            events = audit.take()
            gone({e["pid"] for e in events if e["worker"]})
            assert worker_reads(events) == [], worker_reads(events)
        released(home)
        print(json.dumps({"scenario": "safe-error", "session": sid, "provider_requests": len(peer.requests)}))
    finally:
        peer.release.set()
        owner.sidecar.close()


def main():
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(mode=0o700, exist_ok=True)
    root = home.parent
    alpha, workspace, witness, hooks = home / "profiles/alpha", root / "workspace", root / "witness", root / "hooks"
    for path in (alpha, workspace, witness, hooks):
        path.mkdir(parents=True, exist_ok=True)
    (hooks / "sitecustomize.py").write_text(WITNESS_HOOK)
    peer = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    peer.requests, peer.authorization = [], []
    peer.blocked, peer.release = threading.Event(), threading.Event()
    threading.Thread(target=peer.serve_forever, daemon=True).start()
    peer.url = f"http://127.0.0.1:{peer.server_port}/v1"
    [scenario] = sys.argv[1:]
    assert scenario in SCENARIOS, scenario
    write_profile(home, workspace, peer.url, witness, mcp=scenario in MCP_SCENARIOS)
    write_profile(alpha, workspace, peer.url, witness, "ALPHA_", mcp=scenario in MCP_SCENARIOS)
    env = child_env()
    env.update(HOME=os.environ["HOME"], HERMES_HOME=str(home), PYTHONPATH=f"{hooks}{os.pathsep}{agent}",
               OPENAI_API_KEY="loopback-only", OPENAI_BASE_URL=peer.url, HERMES_STATE_DB_GUARD_BYPASS="1",
               HERMES_DISABLE_LAZY_INSTALLS="1", PYTEST_CURRENT_TEST="talaria execution mode fixture", TIRITH_ENABLED="0",
               AWS_EC2_METADATA_DISABLED="true", TALARIA_WITNESS_LOG=str(witness / "audit.jsonl"),
               TALARIA_WITNESS_ROOTS=os.pathsep.join([str(home), str(workspace)]))
    alpha_env = dict(env, HERMES_HOME=str(alpha), OPENAI_API_KEY="alpha-only")
    ran = []
    try:
        with PHASES.probe(scenario):
            if scenario == "safe-sibling":
                probe_safe_sibling(home, alpha, workspace, witness, peer, env, alpha_env)
            else:
                {"controls": probe_controls, "restart-config": lambda *a: probe_restart(*a, "ignore_config"),
                 "restart-safe": lambda *a: probe_restart(*a, "safe"), "safe": probe_safe,
                 "safe-error": probe_safe_error}[scenario](home, workspace, witness, peer, env)
        ran = [scenario]
    finally:
        report_modes(ran, {}, None if ran else scenario)
        peer.release.set()
        peer.shutdown()
        peer.server_close()
        PHASES.report()


if __name__ == "__main__":
    main()
