"""``chat.start`` hands the profile's main-model ``service_tier`` and ``extra_body`` (written by ``/api/model/set``) to
``AIAgent(request_overrides=...)`` only when the turn runs on that main model, and an edit rebuilds the cached agent."""

from __future__ import annotations

import json
import subprocess
import pytest

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent

# Runs on the Agent interpreter: real config loading, a stand-in AIAgent that records its kwargs.
PROBE = """
import json, os, sys
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat

seen = []

class FakeAgent:
    def __init__(self, **kwargs):
        seen.append(kwargs.get("request_overrides"))

    def run_conversation(self, **kwargs):
        return {"final_response": "ok", "messages": []}

class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass

chat._agent_class = lambda: FakeAgent
chat._resolve_runtime = lambda provider, model: {"model": model, "provider": provider}
root = Path(os.environ["HERMES_HOME"])
config = root / "config.yaml"

def turn(i, session, model="gpt-5.4", provider="openai-codex"):
    params = {"profile_home": str(root), "session_id": session, "stream_id": f"st{i}", "user_message": "hi", "model": model, "model_provider": provider, "enabled_toolsets": ["memory"]}
    with scoped_home(root):
        result = chat.start(Ctx(), params)
    assert result["status"] == "completed", result

turn(0, "main")
turn(1, "main")
turn(2, "other", model="glm-5", provider="zai")
config.write_text(config.read_text() + "  extra_body:\\n    reasoning:\\n      summary: auto\\n")
turn(3, "main")
print(json.dumps(seen))
"""

CONFIG = """\
model:
  default: gpt-5.4
  provider: openai-codex
  service_tier: priority
"""


@requires_agent
def test_main_model_turns_carry_service_tier_and_extra_body(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / "config.yaml").write_text(CONFIG)
    env = isolated_env(root)
    run = subprocess.run([AGENT_PYTHON, "-c", PROBE, str(AGENT_DIR)], env=env, capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    seen = json.loads(run.stdout.strip().splitlines()[-1])
    # The main model gets its tier (the unchanged second turn reuses the cached agent), another model gets none, and
    # an ``extra_body`` edit builds a new agent carrying both.
    assert seen == [{"service_tier": "priority"}, None, {"service_tier": "priority", "extra_body": {"reasoning": {"summary": "auto"}}}], seen


@requires_agent
@pytest.mark.skipif(AGENT_DIR is None or "def model_supports_ultrafast" not in (AGENT_DIR / "hermes_cli/models.py").read_text(), reason="GPT-6 and Ultrafast require Agent v0.21.6")
@pytest.mark.parametrize("model,provider,tier,base_url,expected", [
    ("gpt-6-astra", "openai-codex", "ultrafast", "https://chatgpt.com/backend-api/codex", {"service_tier": "ultrafast"}),
    ("gpt-6-sol", "openai-codex", "priority", "https://chatgpt.com/backend-api/codex", {"service_tier": "priority"}),
    ("claude-opus-4-8", "anthropic", "priority", "https://api.anthropic.com", {"speed": "fast"}),
    ("gpt-6-sol", "openai", "priority", "https://proxy.example/v1", None),
    ("gpt-6-sol", "openai-codex", "ultrafast", "https://chatgpt.com/backend-api/codex", None),
])
def test_turn_speed_uses_agent_route_resolver(tmp_path, model, provider, tier, base_url, expected):
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / "config.yaml").write_text(f"model:\n  default: {model}\n  provider: {provider}\n  service_tier: {tier}\n  base_url: {base_url}\n")
    probe = PROBE[:PROBE.index('turn(0, "main")')]
    probe += f'\nchat._resolve_runtime = lambda provider, model: {{"model": model, "provider": provider, "base_url": {base_url!r}}}\n'
    probe += f'turn(0, "main", model={model!r}, provider={provider!r})\nprint(json.dumps(seen))\n'
    run = subprocess.run([AGENT_PYTHON, "-c", probe, str(AGENT_DIR)], env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    assert json.loads(run.stdout.strip().splitlines()[-1]) == [expected]


# TAL-789: the resolver's ``request_overrides`` (a custom provider's ``extra_body``) reach both build sites. The entry's
# display name differs from the ``custom:<slug>`` id the server sends, so only the resolver result carries it.
PROXY_PROBE = PROBE.replace('chat._resolve_runtime = lambda provider, model: {"model": model, "provider": provider}\n', """
from types import SimpleNamespace
import agent.conversation_compression_manual as manual
manual.compress_now = lambda agent, history, request, task_id=None: SimpleNamespace(status="noop", after_messages=history, before_tokens=0, after_tokens=0, summary=None)
manual.render_compress_result = lambda result: []
""").split('turn(0, "main")')[0] + """
def compress(session):
    params = {"profile_home": str(root), "session_id": session, "conversation_history": [], "model": "proxy-model", "model_provider": "custom:my-proxy"}
    with scoped_home(root):
        assert chat.compress(Ctx(), params)["status"] == "noop"

turn(0, "proxy", model="proxy-model", provider="custom:my-proxy")
turn(1, "proxy", model="proxy-model", provider="custom:my-proxy")
compress("proxy")
config.write_text(config.read_text().replace("talaria-proxy-user", "edited-user"))
turn(2, "proxy", model="proxy-model", provider="custom:my-proxy")
config.write_text(config.read_text() + "model:\\n  default: proxy-model\\n  provider: custom:my-proxy\\n  extra_body:\\n    user: main-user\\n    store: false\\n")
turn(3, "proxy", model="proxy-model", provider="custom:my-proxy")
print(json.dumps(seen))
"""

PROXY_CONFIG = """\
custom_providers:
  - name: My Proxy
    base_url: https://proxy.example/v1
    api_key: sk-proxy
    extra_body:
      user: talaria-proxy-user
      metadata: talaria
"""


@requires_agent
def test_custom_provider_extra_body_reaches_chat_and_compress(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    (root / "config.yaml").write_text(PROXY_CONFIG)
    run = subprocess.run([AGENT_PYTHON, "-c", PROXY_PROBE, str(AGENT_DIR)], env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    seen = json.loads(run.stdout.strip().splitlines()[-1])
    proxy = {"extra_body": {"user": "talaria-proxy-user", "metadata": "talaria"}}
    # Chat (the unchanged second turn reuses the cached agent) and compress both carry the entry's body; an edit to it
    # builds a fresh agent; a main-model ``extra_body`` wins key by key over the entry's.
    assert seen == [
        proxy,
        proxy,
        {"extra_body": {"user": "edited-user", "metadata": "talaria"}},
        {"extra_body": {"user": "main-user", "metadata": "talaria", "store": False}},
    ], seen


# Keep the real Agent constructor, provider profile and request builder; replace only execution with a recorder.
DATA_USE_PROBE = """
import json, os, sys
from pathlib import Path
from unittest.mock import patch
sys.path.append(sys.argv[1])
from run_agent import AIAgent
from agent import message_metadata
from talaria_sidecar.errors import RpcError
from talaria_sidecar.home import scoped_home
from talaria_sidecar.methods import chat

seen = []
refusals = []
capable = callable(getattr(message_metadata, "data_use_requirement", None))

class RecordingAgent(AIAgent):
    def __init__(self, **kwargs):
        super().__init__(**kwargs, skip_memory=True, skip_context_files=True)

    def run_conversation(self, user_message, conversation_history, **kwargs):
        messages = [*conversation_history, {"role": "user", "content": user_message}]
        seen.append(self._build_api_kwargs(messages))
        return {"final_response": "ok", "messages": [*messages, {"role": "assistant", "content": "ok"}]}

    def _spawn_background_review(self, **kwargs):
        seen.append(self._build_api_kwargs(kwargs["messages_snapshot"]))

class Client:
    def __init__(self, **kwargs):
        self.api_key = kwargs.get("api_key")
        self.base_url = kwargs.get("base_url")

    def close(self):
        pass

class Ctx:
    cancelled = False

    def emit(self, event, data=None):
        pass

home = Path(os.environ["HERMES_HOME"])
chat._agent_class = lambda: RecordingAgent
chat._resolve_runtime = lambda provider, model: {"model": model, "provider": provider, "api_key": "test-key", "api_mode": "chat_completions", "base_url": "https://inference-api.nousresearch.com/v1"}
params = {"profile_home": str(home), "session_id": "privacy", "model": "gpt-5", "model_provider": "nous", "enabled_toolsets": []}
with patch("agent.process_bootstrap.OpenAI", Client), scoped_home(home):
    first = chat.start(Ctx(), {**params, "stream_id": "first", "user_message": "read connector", "conversation_history": []})
    assert first["status"] == "completed", first
    for requirement in ("no_training", "zero_retention"):
        history = [{"role": "user", "content": "read connector"},
                   {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "connector", "arguments": "{}"}}]},
                   {"role": "tool", "tool_call_id": "c1", "content": "private result", "data_use": [requirement]},
                   {"role": "assistant", "content": "done"}]
        turn = {**params, "stream_id": requirement, "user_message": "follow up", "conversation_history": history}
        if capable:
            result = chat.start(Ctx(), turn)
            assert result["status"] == "completed", result
            assert "Reviewing this conversation" in chat.refine({**turn, "messages": history})
        else:
            for method in ("start", "compress", "refine"):
                try:
                    if method == "refine":
                        chat.refine({**turn, "messages": history})
                    else:
                        getattr(chat, method)(Ctx(), turn)
                except RpcError as exc:
                    refusals.append(exc.data["condition"])
                else:
                    raise AssertionError("legacy Agent admitted private history")
print(json.dumps({"capable": capable, "requests": seen, "refusals": refusals}))
"""


@requires_agent
def test_second_turn_connector_data_use_reaches_nous_request(tmp_path) -> None:
    root = tmp_path / ".hermes"
    root.mkdir()
    run = subprocess.run([AGENT_PYTHON, "-c", DATA_USE_PROBE, str(AGENT_DIR)], env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    observed = json.loads(run.stdout.strip().splitlines()[-1])
    requests = observed["requests"]
    if not observed["capable"]:
        assert len(requests) == 1
        assert observed["refusals"] == ["agent_incompatible"] * 6
        return
    assert observed["refusals"] == []
    assert [request["extra_body"].get("provider") for request in requests] == [None, *[{"data_collection": "deny"}] * 2, *[{"data_collection": "deny", "zdr": True}] * 2]
    for request in requests[1:]:
        assert next(row for row in request["messages"] if row["role"] == "tool") == {"role": "tool", "tool_call_id": "c1", "content": "private result"}
        assert all("data_use" not in row and "display_metadata" not in row for row in request["messages"])
