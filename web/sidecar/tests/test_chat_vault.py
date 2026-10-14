"""TAL-887: the Agent's password-manager prompts (unlock, save a login, a one-time code) through chat.start, with the
installed Agent's real ``browser_vault_*`` tools, a fake locked backend and no browser."""

import json
import subprocess

import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent


PROBE = r'''
import json, os, sys, threading
sys.path.append(sys.argv[1])
import agent.vault_backends as vault_backends
import agent.vault_login_classifier as classifier
import agent.vault_store as vault_store
from agent.vault_backends import unlock
from tools import browser_vault_tool as bvt
from tools.thread_context import propagate_context_to_thread
from talaria_sidecar.methods import Registry, chat

tool, outcome = sys.argv[2:]
registry = Registry(runtime=None)
chat.register(registry)
SECRET = {"unlock": "correct horse battery", "save_login": "s3cret-pass", "code": "123 456"}[tool]
ANSWER = {"unlock": SECRET, "save_login": json.dumps({"identifier": "me@example.com", "password": SECRET}), "code": SECRET}[tool]
seen = {"unlock": [], "saved": [], "filled": []}

class Backend:
    name, display_name, needs_unlock = "bitwarden", "Bitwarden", True
    def is_unlocked(self):
        return unlock.is_unlocked(self.name)
    def unlock(self, master):
        seen["unlock"].append(master)
        unlock.store_session_token(self.name, "session-token")

class Store:
    def add_item(self, kind, label, secret, origin=None):
        seen["saved"].append({"label": label, "origin": origin, **secret})
        return type("Meta", (), {"id": "item-1"})()

class Control:
    @classmethod
    def from_dict(cls, raw):
        return cls()

vault_backends.enabled_backends = lambda: [Backend()]
vault_store.get_vault_store = lambda: Store()
bvt._focus_bound_origin = lambda *args: None
bvt._current_page_origin = lambda task_id: "https://login.example.com"
bvt.browser_vault_fill = lambda handle, task_id=None: json.dumps({"success": True})
bvt._eval_js = lambda task_id, expression: {"success": True, "result": "[{}]"}
classifier.LoginControl = Control
classifier.classify_otp_controls = lambda controls: ["otp"]
classifier.build_otp_fills = lambda controls, code: seen["filled"].append(code) or [code]
classifier.build_fill_js = lambda fills, expected_origin, nonce="": ""
bvt._eval_js_secret = lambda task_id, expression: {"success": True, "result": json.dumps({"filled": 1})}
if outcome == "expired":
    chat._VAULT_PROMPT_TIMEOUTS = {kind: 1 for kind in chat._VAULT_PROMPT_TIMEOUTS}
tool_results, frames, acks = [], [], []

class Agent:
    def __init__(self, **kwargs):
        pass
    def interrupt(self, *args, **kwargs):
        pass
    def run_conversation(self, **kwargs):
        call = {"unlock": lambda: bvt.browser_vault_unlock("bitwarden"), "save_login": lambda: bvt.browser_vault_save_login(task_id="t"),
                "code": lambda: bvt.browser_vault_enter_code(task_id="t")}[tool]
        # The Agent runs tools on a worker thread that inherits the turn's prompt callbacks (its parallel tool path).
        worker = threading.Thread(target=propagate_context_to_thread(lambda: tool_results.append(json.loads(call()))))
        worker.start()
        worker.join()
        return {"final_response": "ok", "messages": []}

class Ctx:
    cancelled = False
    def emit(self, event, data=None):
        frames.append([event, data])
        if event != "clarify":
            return
        if outcome == "cancelled":
            registry.methods["chat.interrupt"](self, {"stream_id": "st-vault"})
        elif outcome in ("submitted", "declined"):
            acks.append(registry.methods["clarify.respond"](self, {
                "stream_id": "st-vault", "clarify_id": data["clarify_id"], "response": ANSWER if outcome == "submitted" else ""}))

chat._agent_class = lambda: Agent
chat._resolve_runtime = lambda provider, model: {"model": "m", "provider": "p"}
chat._discover_mcp_tools = lambda run: None
chat._profile_toolsets = lambda: ["browser"]
chat._profile_fallback_chain = lambda: None
chat._main_model_request_overrides = lambda model, provider, base_url="": None
chat.checkpoint_kwargs = lambda: {}
result = chat.start(Ctx(), {"profile_home": os.environ["HERMES_HOME"], "session_id": "s-vault", "stream_id": "st-vault",
                            "user_message": "Log in", "model": "m", "model_provider": "p"})
# The turn's thread keeps no prompt once the turn is over.
after = [unlock.get_unlock_prompt_callback(), unlock.get_save_login_prompt_callback(), unlock.get_code_prompt_callback()]
unlocked = unlock.is_unlocked("bitwarden")
registry.methods["chat.evict_agent"](Ctx(), {"session_id": "s-vault", "clear_session": True})
print(json.dumps({"tool": tool_results, "frames": frames, "acks": acks, "seen": seen, "status": result["status"], "secret": SECRET,
                  "callbacks_after": [cb is not None for cb in after], "unlocked": unlocked, "unlocked_after_close": unlock.is_unlocked("bitwarden")}))
'''

PROMPT = {
    "unlock": {"kind": "vault_unlock", "backend": "bitwarden", "display_name": "Bitwarden", "timeout_seconds": 120},
    "save_login": {"kind": "vault_save_login", "origin": "https://login.example.com", "site": "login.example.com", "timeout_seconds": 180},
    "code": {"kind": "vault_code", "site": "login.example.com", "hint": "", "timeout_seconds": 180},
}
DECLINED = {"unlock": "unlock_cancelled", "save_login": "save_declined", "code": "code_declined"}


def probe(tmp_path, tool, outcome):
    home = tmp_path / "hermes"
    home.mkdir()
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR), tool, outcome],
                         env=isolated_env(home), capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr[-4000:]
    return json.loads(run.stdout.strip().splitlines()[-1])


@requires_agent
@pytest.mark.parametrize("tool", ["unlock", "save_login", "code"])
@pytest.mark.parametrize("outcome", ["submitted", "declined", "cancelled", "expired"])
def test_vault_prompts_through_chat_start(tmp_path, tool, outcome):
    observed = probe(tmp_path, tool, outcome)
    result = observed["tool"][0]
    prompts = [data for event, data in observed["frames"] if event == "clarify"]
    resolved = [data for event, data in observed["frames"] if event == "clarify_resolved"]
    assert len(prompts) == len(resolved) == 1, observed["frames"]
    expected = {**PROMPT[tool], "session_id": "s-vault", **({"timeout_seconds": 1} if outcome == "expired" else {})}
    assert prompts[0] == {**prompts[0], **expected}
    assert resolved[0]["clarify_id"] == prompts[0]["clarify_id"]
    # The answer goes to the Agent only: no frame carries it.
    assert observed["secret"] not in json.dumps(observed["frames"])
    assert observed["callbacks_after"] == [False, False, False]
    assert observed["status"] == ("cancelled" if outcome == "cancelled" else "completed")
    seen = observed["seen"]
    if outcome == "submitted":
        assert observed["acks"] == [{"ok": True, "clarify_id": prompts[0]["clarify_id"]}]
        assert result["success"] is True, result
        if tool == "unlock":
            assert seen["unlock"] == [observed["secret"]]
            # The unlock belongs to the session that made it and ends when that session is closed.
            assert observed["unlocked"] is True and observed["unlocked_after_close"] is False
        elif tool == "save_login":
            assert seen["saved"] == [{"label": "login.example.com", "origin": "https://login.example.com", "identifier_type": "email",
                                      "identifier": "me@example.com", "password": observed["secret"]}]
        else:
            assert seen["filled"] == ["123456"]
    else:
        assert result["error_type"] == DECLINED[tool], result
        assert seen == {"unlock": [], "saved": [], "filled": []}
        if outcome == "declined":
            assert observed["acks"] == [{"ok": True, "clarify_id": prompts[0]["clarify_id"]}]
