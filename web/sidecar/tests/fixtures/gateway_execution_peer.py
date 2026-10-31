"""Diagnostic creation modes on a real disposable owner, a loopback provider and pre-import witnesses.

A sitecustomize audit hook in every owner/worker interpreter records opens under the sentinel
roots, imports of sentinel modules and process launches. The worker's records prove what safe
mode never touched; the provider's requests and the witness files are the positive controls.
"""
import asyncio
import io
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import time

agent = Path(os.environ["HERMES_WEBUI_AGENT_DIR"])
sys.path[:0] = [str(agent), str(agent / "tests/gateway/fixtures"), str(Path(__file__).resolve().parents[1])]
from local_recovery_probe import Model, child_env, daemon, rpc, websocket
from conftest import SidecarProcess

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
        self.server.authorization.append(self.headers.get("Authorization"))
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        body = json.loads(raw)
        text = next((m.get("content", "") for m in reversed(body.get("messages", [])) if m["role"] == "user"), "")
        if text == "FAIL_PROVIDER":
            self.server.requests.append(body)
            payload = json.dumps({"error": {"message": "synthetic invalid request", "type": "invalid_request_error"}}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.rfile = io.BytesIO(raw)
        super().do_POST()


def write_profile(home: Path, workspace: Path, url: str, witness: Path, tag: str = ""):
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
    mcp = home / "mcp_sentinel.py"
    mcp.write_text(f"from pathlib import Path\nPath({str(witness / (tag + 'mcp-spawned'))!r}).touch()\nimport sys\nsys.stdin.read()\n")
    (home / ".env").write_text("TALARIA_ENV_SENTINEL=present\n")
    (home / "config.yaml").write_text(json.dumps({
        "gateway": {"multiplex_profiles": False, **({"standalone": True} if tag else {})},
        "model": {"provider": "custom", "default": "owner-fixture", "base_url": url},
        "agent": {"system_prompt": f"{tag}CONFIG_SENTINEL prompt"},
        "plugins": {"enabled": ["sentinel"]},
        # The sentinel only witnesses a spawn and never answers, so each owner start would wait out the Agent's 60 s
        # default connect timeout (TAL-1599).
        "mcp_servers": {"sentinel": {"command": sys.executable, "args": [str(mcp)], "connect_timeout": 5}},
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
        time.sleep(.05)


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


async def unsupported(home: Path):
    """An owner that does not advertise the bypass creation fields gets an explicit refusal and no create."""
    from types import SimpleNamespace
    from unittest.mock import patch
    from websockets.asyncio.server import serve
    from talaria_sidecar.methods.gateway_sessions import _create
    seen = []

    async def owner(ws):
        async for raw in ws:
            frame = json.loads(raw)
            seen.append(frame["method"])
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": frame["id"], "result": {
                "instance_id": "fixture", "profile_id": str(home), "authority_epoch": 1,
                "capabilities": ["durable-admission-v1", "event-replay-v1", "local-cli-create-v1"],
                "session_create": {"sources": ["cli"], "parameters": ["request_id", "source", "cwd", "model", "provider", "base_url", "toolsets"]}}}))
    with patch("hermes_cli.gateway_client._session_ticket", return_value="synthetic-one-use-ticket"):
        async with serve(owner, "127.0.0.1", 0, subprotocols=["hermes-gateway-v1"]) as server:
            endpoint = SimpleNamespace(api_origin=f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}", control_home=None,
                                       instance_id="fixture", profile_id=str(home), authority_epoch=1)
            params = {"request_id": "old", "execution_mode": "safe", "cwd": str(home), "model": "fixture"}
            for probe_only in (True, False):
                result = await _create({**params, "probe": probe_only}, home, SimpleNamespace(endpoint=endpoint, state="ready"))
                assert result == {"state": "incompatible", "reason": "execution_mode_unavailable", "snapshot": None, "receipt": None}, result
            served = SimpleNamespace(state="ready", endpoint=SimpleNamespace(**{**vars(endpoint), "control_home": str(home.parent)}))
            result = await _create(params, home, served)
            assert result["reason"] == "served_profile_sessions_unavailable", result
    assert seen == ["runtime.describe", "runtime.describe"], seen


def probe(root: Path, home: Path, alpha: Path, workspace: Path, witness: Path, peer, env, alpha_env):
    sidecar = SidecarProcess(home)
    audit = Witness(witness / "audit.jsonl")
    ids = {}

    def create(mode, request_id, target=home, **extra):
        return sidecar.result("gateway.create", {"profile_home": str(target), "request_id": request_id, "execution_mode": mode,
            "cwd": str(workspace), "model": "owner-fixture", "provider": "custom", "base_url": peer.url, **extra})

    def call(action, sid, target=home, **params):
        return sidecar.result("gateway.session", {"profile_home": str(target), "session_id": sid, "action": action, **params})

    def turn(sid, text, target=home):
        submitted = call("submit", sid, target, request_id="turn-" + text, text=text)
        assert submitted["receipt"], submitted
        return settle(lambda action, s: call(action, s, target), sid)

    try:
        asyncio.run(unsupported(home.resolve()))
        with daemon(agent, home, env, barrier=False) as (_, desc), daemon(agent, alpha, alpha_env, barrier=False) as (_, alpha_desc):
            probed = sidecar.result("gateway.create", {"profile_home": str(home), "probe": True})
            assert probed == {"state": "attached", "reason": None, "snapshot": None, "receipt": None}, probed

            async def natives():
                for name, target, desc_ in (("normal", home, desc), ("alpha", alpha, alpha_desc)):
                    async with websocket(target, desc_) as native:
                        created = await rpc(native, "session.create", request_id="positive-" + name, source="cli", cwd=str(workspace))
                        ids[name] = created["result"]["session_id"]
            asyncio.run(natives())
            audit.take()

            # Positive controls: the ordinary owner reads the profile; config-only drops only the profile config.
            turn(ids["normal"], "NORMAL_CONTROL")
            assert sentinels_in(request_for(peer, "NORMAL_CONTROL")) == set(SENTINELS), request_for(peer, "NORMAL_CONTROL")
            assert (witness / "plugin-imported").exists()
            config_only = create("ignore_config", "diagnostic-config")
            assert config_only["state"] == "attached", config_only
            ids["config"] = config_only["snapshot"]["session_id"]
            turn(ids["config"], "CONFIG_ONLY_CONTROL")
            assert sentinels_in(request_for(peer, "CONFIG_ONLY_CONTROL")) == set(SENTINELS) - {"CONFIG_SENTINEL"}
            config_events = audit.take()
            assert any(path.endswith("SOUL.md") for path in worker_opened(config_events)), config_events
            assert not any(path.endswith(("config.yaml", ".env")) for path in worker_opened(config_events)), config_events

            # Safe: a fresh private worker with no profile reads, imports or MCP launches.
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
            # Concurrent ordinary sessions keep their behavior and environment: same owner and sibling profile.
            turn(ids["normal"], "CONCURRENT_NORMAL")
            assert sentinels_in(request_for(peer, "CONCURRENT_NORMAL")) == set(SENTINELS)
            turn(ids["alpha"], "SIBLING_NORMAL", alpha)
            # The workspace rules are shared; every profile-owned sentinel is alpha's own.
            assert sentinels_in(request_for(peer, "SIBLING_NORMAL"), "ALPHA_") == set(SENTINELS) - {"RULES_SENTINEL"}
            assert "RULES_SENTINEL" in sentinels_in(request_for(peer, "SIBLING_NORMAL"))
            sibling = peer.requests.index(request_for(peer, "SIBLING_NORMAL")[0])
            assert peer.authorization[sibling] == "Bearer alpha-only", peer.authorization
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

            # Error cleanup keeps the policy: the next turn is still safe.
            peer.blocked.clear()
            failed = turn(ids["safe"], "FAIL_PROVIDER")
            assert failed["snapshot"]["pending"] == [], failed
            turn(ids["safe"], "SAFE_AFTER_ERROR")
            assert sentinels_in(request_for(peer, "SAFE_AFTER_ERROR")) == set()
            events = audit.take()
            gone({e["pid"] for e in events if e["worker"]})
            assert worker_reads(events) == [], worker_reads(events)
        released(home)

        # The frozen policy survives an owner restart. v0.22.1 binds DEFAULT_CONFIG's voice.record_key
        # as a launch-only secret, so a restarted owner refuses a bypass turn before any worker starts
        # (launch_credentials_unavailable). Either way nothing runs under a weaker policy.
        with daemon(agent, home, env, barrier=False):
            for name, text, expected in (("safe", "SAFE_AFTER_RESTART", set()),
                                         ("config", "CONFIG_AFTER_RESTART", set(SENTINELS) - {"CONFIG_SENTINEL"})):
                assert receipt_policy(home, ids[name]) == {"safe_mode": name == "safe", "ignore_user_config": True}
                submitted = call("submit", ids[name], request_id="restart-" + name, text=text)
                assert submitted["receipt"], submitted
                end = time.monotonic() + 60
                while True:
                    current = call("snapshot", ids[name])
                    pending = current["snapshot"]["pending"]
                    if not current["snapshot"]["running"] and all(p["status"] in {"unknown", "terminal"} for p in pending):
                        break
                    assert time.monotonic() < end, current
                    time.sleep(.05)
                if request_for(peer, text):
                    assert sentinels_in(request_for(peer, text)) == expected, request_for(peer, text)
                else:
                    assert [p["status"] for p in pending] == ["unknown"], pending
                    discarded = call("discard", ids[name], admission_id=pending[0]["admission_id"],
                                     execution_generation=pending[0]["execution_generation"])
                    assert discarded["state"] == "attached", discarded
                    settle(call, ids[name])
            events = audit.take()
            gone({e["pid"] for e in events if e["worker"]})
            assert not any(path.endswith(("config.yaml", ".env")) for path in worker_opened(events)), events
        print(json.dumps({"modes": ["normal", "ignore_config", "safe"], "sessions": ids, "provider_requests": len(peer.requests)}))
    finally:
        peer.release.set()
        sidecar.close()


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
    write_profile(home, workspace, peer.url, witness)
    write_profile(alpha, workspace, peer.url, witness, "ALPHA_")
    env = child_env()
    env.update(HOME=os.environ["HOME"], HERMES_HOME=str(home), PYTHONPATH=f"{hooks}{os.pathsep}{agent}",
               OPENAI_API_KEY="loopback-only", OPENAI_BASE_URL=peer.url, HERMES_STATE_DB_GUARD_BYPASS="1",
               HERMES_DISABLE_LAZY_INSTALLS="1", PYTEST_CURRENT_TEST="talaria execution mode fixture", TIRITH_ENABLED="0",
               AWS_EC2_METADATA_DISABLED="true", TALARIA_WITNESS_LOG=str(witness / "audit.jsonl"),
               TALARIA_WITNESS_ROOTS=os.pathsep.join([str(home), str(workspace)]))
    alpha_env = dict(env, HERMES_HOME=str(alpha), OPENAI_API_KEY="alpha-only")
    try:
        probe(root, home, alpha, workspace, witness, peer, env, alpha_env)
    finally:
        peer.release.set()
        peer.shutdown()
        peer.server_close()


if __name__ == "__main__":
    main()
