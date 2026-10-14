"""TAL-807: ``usage.limits`` reads the Agent's ``CredentialPool.limit_state`` from a synthetic ``auth.json`` pool, and an
Agent without it answers with nothing."""

from __future__ import annotations

import json
import pathlib
import sys
import time
import types
from datetime import datetime, timezone

from conftest import SidecarProcess, requires_agent
from talaria_sidecar import SIDECAR_RPC_VERSION
from talaria_sidecar.methods import usage


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _entry(credential_id: str, **extra) -> dict:
    return {"id": credential_id, "label": credential_id, "auth_type": "api_key", "priority": 0, "source": "manual", "access_token": f"sk-synthetic-{credential_id}", **extra}


def _limits(hermes_home: pathlib.Path, pools: dict, providers: list[dict]) -> dict:
    (hermes_home / "auth.json").write_text(json.dumps({"version": 1, "credential_pool": pools}))
    proc = SidecarProcess(hermes_home)
    try:
        assert proc.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})["compatible"]
        return proc.result("usage.limits", {"profile_home": str(hermes_home), "providers": providers})["limits"]
    finally:
        proc.close()


@requires_agent
def test_an_exhausted_sole_entry_limits_the_account_until_its_reset(hermes_home: pathlib.Path):
    until = int(time.time()) + 3600
    limits = _limits(hermes_home, {"zai": [_entry("zai-1", last_status="exhausted", last_status_at=time.time(), last_error_code=429, last_error_reset_at=until)]},
                     [{"slug": "zai", "models": ["glm-5"]}, {"slug": "deepseek", "models": ["deepseek-chat"]}])
    assert limits == {"zai": {"scope": "account", "resets_at": _iso(until)}}


@requires_agent
def test_a_model_cooldown_limits_only_that_model_and_an_expired_one_disappears(hermes_home: pathlib.Path):
    now = int(time.time())
    pools = {"zai": [_entry("zai-1", model_cooldowns={"glm-5": now + 900, "glm-4.6": now - 60})]}
    limits = _limits(hermes_home, pools, [{"slug": "zai", "models": ["glm-5", "glm-4.6", "glm-4.5"]}])
    assert limits == {"zai": {"scope": "models", "models": {"glm-5": _iso(now + 900)}}}
    # Once every reset has passed the provider is not limited at all.
    pools = {"zai": [_entry("zai-1", model_cooldowns={"glm-4.6": now - 60}, last_status="exhausted", last_status_at=now - 7200, last_error_code=429, last_error_reset_at=now - 60)]}
    assert _limits(hermes_home, pools, [{"slug": "zai", "models": ["glm-5", "glm-4.6"]}]) == {}


def test_an_agent_without_limit_state_answers_with_nothing(monkeypatch):
    class Pool:  # an Agent before v0.21.6: the pool has no `limit_state`
        def entries(self):
            return []

    credential_pool = types.ModuleType("agent.credential_pool")
    credential_pool.load_pool = lambda provider: Pool()
    auth = types.ModuleType("hermes_cli.auth")
    auth.read_credential_pool = lambda: {"zai": [_entry("zai-1")]}
    for name, module in {"agent": types.ModuleType("agent"), "agent.credential_pool": credential_pool,
                         "hermes_cli": types.ModuleType("hermes_cli"), "hermes_cli.auth": auth}.items():
        monkeypatch.setitem(sys.modules, name, module)
    assert usage.limits([{"slug": "zai", "models": ["glm-5"]}]) == {}
