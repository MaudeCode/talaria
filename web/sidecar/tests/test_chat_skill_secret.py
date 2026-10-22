"""Real Agent skill setup through turn-local secure prompts, with disposable profile homes."""

import json
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


PROBE = r'''
import json, os, pathlib, sys, threading
sys.path.append(sys.argv[1])
from tools import skills_tool
from tools.thread_context import propagate_context_to_thread
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import Registry, chat

outcome = sys.argv[2]
supported = callable(getattr(skills_tool, "bind_turn_secret_capture", None))
registry = Registry(runtime=None)
chat.register(registry)
root = pathlib.Path(os.environ["HERMES_HOME"])
frames, results, acks, requests, callbacks_after, atomic_writes, live_secrets = [], [], [], [], [], [], []
from hermes_cli import config
replace = config.atomic_replace
def atomic_replace(source, target):
    if pathlib.Path(target).name == ".env": atomic_writes.append(str(target))
    return replace(source, target)
config.atomic_replace = atomic_replace
if outcome == "storage_error":
    def broken_save(key, value): raise ValueError(value)
    config.save_env_value_secure = broken_save
barrier = threading.Barrier(2) if outcome == "concurrent" else None
if outcome == "expired":
    chat._VAULT_PROMPT_TIMEOUTS["skill_secret"] = 1

class Agent:
    def __init__(self, **kwargs): pass
    def interrupt(self, *args, **kwargs): pass
    def run_conversation(self, **kwargs):
        requests.append(kwargs)
        def tool():
            if barrier: barrier.wait(timeout=10)
            results.append(json.loads(skills_tool.skill_view("synthetic")))
            from agent.secret_scope import get_secret
            live_secrets.append(bool(get_secret("TALARIA_TEST_SKILL_SECRET")))
        worker = threading.Thread(target=propagate_context_to_thread(tool))
        worker.start()
        worker.join(timeout=15)
        assert not worker.is_alive(), "secret waiter leaked"
        if supported: callbacks_after.append(skills_tool._turn_secret_capture.get() is not None)
        if outcome == "turn_error": raise RuntimeError("synthetic failed turn")
        return {"final_response": "Setup finished.", "messages": []}

class Ctx:
    cancelled = False
    def __init__(self, name): self.name = name
    def emit(self, event, data=None):
        frames.append([event, data])
        if event != "clarify": return
        params = {"stream_id": "stream-" + self.name, "clarify_id": data["clarify_id"], "response": "unique-fake-secret-" + self.name}
        if outcome == "cancelled":
            registry.methods["chat.interrupt"](self, {"stream_id": params["stream_id"]})
        elif outcome == "disconnected": self.cancelled = True
        elif outcome == "cleared":
            registry.methods["chat.evict_agent"](self, {"session_id": self.name, "clear_session": True})
            acks.append(registry.methods["clarify.respond"](self, params))
        elif outcome == "late":
            # Force the deadline boundary before the responder runs, without a scheduler-dependent sleep.
            run = chat._RUNS[params["stream_id"]]
            run.clarify_entries[data["clarify_id"]].deadline = 0
            acks.append(registry.methods["clarify.respond"](self, params))
        elif outcome != "expired":
            foreign = {**params, "stream_id": "foreign", "session_id": "foreign"}
            acks.append(registry.methods["clarify.respond"](self, foreign))
            wrong_session = {**params, "session_id": "foreign"}
            acks.append(registry.methods["clarify.respond"](self, wrong_session))
            stale = {**params, "clarify_id": "stale"}
            acks.append(registry.methods["clarify.respond"](self, stale))
            if outcome == "declined": params["response"] = ""
            if outcome == "non_ascii": params["response"] = "unique-fake-secret-" + self.name + "é"
            if outcome == "multiline": params["response"] += "\ninjected=value"
            acks.append(registry.methods["clarify.respond"](self, params))
            acks.append(registry.methods["clarify.respond"](self, {**params, "response": "late-answer"}))

chat._agent_class = lambda: Agent
chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
chat._discover_mcp_tools = lambda run: None
chat._profile_toolsets = lambda cfg=None: ["skills"]
chat._profile_fallback_chain = lambda cfg=None: None
chat._main_model_request_overrides = lambda model, provider, base_url="", cfg=None: None
chat.checkpoint_kwargs = lambda cfg=None: {}
names = ["one", "two"] if outcome == "concurrent" else ["one"]
def turn(name):
    home = root / name
    skill = home / "skills" / "synthetic"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text('---\nname: synthetic\ndescription: synthetic test\nrequired_environment_variables:\n  - name: TALARIA_TEST_SKILL_SECRET\n    prompt: Enter the test key\n    help: https://example.com/keys\n    required_for: synthetic setup\n---\nUse the configured key.\n')
    ctx = Ctx(name)
    with scoped_home(home):
        chat.start(ctx, {"profile_home": str(home), "session_id": name, "stream_id": "stream-" + name,
                         "user_message": "Set up synthetic", "model": "m", "model_provider": "p", **({"skill_secret": True} if outcome != "client_unsupported" else {})})
        if supported: assert skills_tool._turn_secret_capture.get() is None
    for event, data in frames:
        if event == "clarify" and data.get("session_id") == name:
            assert registry.methods["clarify.respond"](ctx, {"stream_id": "stream-" + name, "clarify_id": data["clarify_id"], "response": "late-answer"}) == {"ok": False}
threads = [threading.Thread(target=turn, args=(name,)) for name in names]
for t in threads: t.start()
for t in threads:
    t.join(timeout=20)
    assert not t.is_alive(), "turn leaked"
files = {name: (root / name / ".env").read_text() if (root / name / ".env").exists() else "" for name in names}
print(json.dumps({"supported": supported, "frames": frames, "results": results, "acks": acks, "files": files,
                  "requests": requests, "process_secret": os.environ.get("TALARIA_TEST_SKILL_SECRET"), "callbacks_after": callbacks_after, "atomic_writes": atomic_writes, "live_secrets": live_secrets}))
'''


@requires_agent
@pytest.mark.parametrize("outcome", ["submitted", "concurrent", "declined", "expired", "cancelled", "disconnected", "cleared", "storage_error", "late", "turn_error", "client_unsupported", "non_ascii", "multiline"])
def test_skill_secret_through_real_skill_and_worker(tmp_path, outcome):
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR), outcome],
                         env=isolated_env(tmp_path), capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr[-4000:]
    assert "Traceback" not in run.stderr, run.stderr[-4000:]
    observed = json.loads(run.stdout.strip().splitlines()[-1])
    assert len(observed["results"]) == len(observed["files"]), run.stderr[-4000:]
    if not observed["supported"] or outcome == "client_unsupported":
        assert not observed["frames"] or all(event != "clarify" for event, _ in observed["frames"])
        assert not any(observed["files"].values())
        assert observed["callbacks_after"] == ([False] if observed["supported"] else [])
        assert all(r["readiness_status"] == "setup_needed" for r in observed["results"])
        return
    prompts = [data for event, data in observed["frames"] if event == "clarify"]
    assert len(prompts) == len(observed["files"]), observed
    assert len([1 for event, _ in observed["frames"] if event == "clarify_resolved"]) == len(prompts)
    for name, content in observed["files"].items():
        secret = "unique-fake-secret-" + name
        if outcome in ("submitted", "concurrent", "turn_error"):
            assert secret in content, "submitted secret never reached the invoking profile"
            assert all(r["readiness_status"] == "available" for r in observed["results"])
            assert sum(path.endswith("/" + name + "/.env") for path in observed["atomic_writes"]) == 1
            assert all("unique-fake-secret-" + other not in content for other in observed["files"] if other != name)
        else:
            assert not content, "cancelled or late answer wrote a secret"
        assert secret not in json.dumps({k: v for k, v in observed.items() if k != "files"})
        assert secret not in run.stderr
        if outcome not in ("submitted", "concurrent", "turn_error"):
            assert all(r["readiness_status"] == "setup_needed" for r in observed["results"])
    assert observed["process_secret"] is None
    assert observed["live_secrets"] == [outcome in ("submitted", "concurrent", "turn_error")] * len(prompts)
    # Inside the turn the worker sees the callback; outside the turn it is reset.
    assert observed["callbacks_after"] == [True] * len(prompts)
    assert all(p["kind"] == "skill_secret" and p["env_var"] == "TALARIA_TEST_SKILL_SECRET" for p in prompts)
    assert all(p["skill_name"] == "synthetic" and p["required_for"] == "synthetic setup" for p in prompts)
    if outcome == "late":
        assert observed["acks"] == [{"ok": False}]
    if outcome in ("submitted", "concurrent", "declined"):
        assert sum(a["ok"] is True for a in observed["acks"]) == len(prompts)
