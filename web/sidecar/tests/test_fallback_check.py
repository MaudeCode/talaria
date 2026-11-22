"""``providers.fallback_check`` (TAL-2655): each profile's effective fallback chain through the pinned Agent's static
``hermes fallback check``, in chain order, without counting or rotating a credential pool or installing a plugin. An
Agent without the check (before v0.23.2) answers an explicit unavailable capability.

Every home is disposable and every credential synthetic; no request leaves the machine.
"""

from __future__ import annotations

import json
import pathlib

from conftest import AGENT_DIR, SidecarProcess, load_schema, requires_agent, validate

ROOT_CONFIG = {
    "providers": {"lab": {"base_url": "https://lab.invalid/v1", "api_key": "sk-synthetic-lab-key-0123456789"}},
    "credential_pool_strategies": {"openrouter": "round_robin"},
    "fallback_providers": [
        {"provider": "openrouter", "model": "vendor/pooled-model"},
        {"provider": "nosuchprovider", "model": "ghost"},
        {"provider": "copilot-acp", "model": "gpt-5"},
        {"provider": "lab", "model": "lab-model"},
        {"provider": "anthropic", "model": "claude-synthetic"},
    ],
    # Legacy key: the Agent appends it after ``fallback_providers`` and drops the route it repeats.
    "fallback_model": [{"provider": "openrouter", "model": "vendor/pooled-model"}, {"provider": "zai", "model": "glm-synthetic"}],
}
POOL = {"version": 1, "providers": {}, "credential_pool": {"openrouter": [
    {"id": f"k{i}", "label": f"row{i}", "auth_type": "api_key", "priority": i, "source": "manual", "access_token": f"sk-or-v1-synthetic-{i}-0123456789", "request_count": 0}
    for i in (0, 1)]}}


def _check(sidecar: SidecarProcess, home: pathlib.Path) -> dict:
    result = sidecar.result("providers.fallback_check", {"profile_home": str(home)})
    assert validate(result, load_schema("providers.fallback_check")) == []
    return result


def _verdicts(sidecar: SidecarProcess, home: pathlib.Path) -> list[tuple]:
    result = _check(sidecar, home)
    assert result["available"] is True
    for entry in result["entries"]:
        # The Agent says why every entry is not ready; a ready entry carries no error.
        assert bool(entry["error"]) is not entry["ready"], entry
        assert "sk-synthetic-lab-key" not in entry["error"]
    return [(e["provider"], e["model"], e["configured"], e["auth_ready"], e["ready"], e["error_class"]) for e in result["entries"]]


@requires_agent
def test_static_verdicts_follow_each_profile_chain_and_leave_the_pool_untouched(tmp_path: pathlib.Path) -> None:
    root = tmp_path / "home" / ".hermes"
    root.mkdir(parents=True)
    (root / "config.yaml").write_text(json.dumps(ROOT_CONFIG))
    (root / "auth.json").write_text(json.dumps(POOL))
    keyed = root / "profiles" / "keyed"
    keyed.mkdir(parents=True)
    (keyed / "config.yaml").write_text(json.dumps({"fallback_providers": [{"provider": "anthropic", "model": "claude-synthetic"}]}))
    (keyed / ".env").write_text("ANTHROPIC_API_KEY=sk-ant-api03-synthetic-0123456789abcdef\n")
    plain = root / "profiles" / "plain"
    plain.mkdir(parents=True)
    (plain / "config.yaml").write_text(json.dumps({"model": {"provider": "openrouter", "default": "vendor/main"}}))
    sidecar = SidecarProcess(root)
    try:
        if not (AGENT_DIR / "hermes_cli" / "fallback_check.py").exists():
            assert _check(sidecar, root) == {"available": False, "entries": []}
            return
        for _ in range(2):  # a second read would see any rotation or count the first one saved
            assert _verdicts(sidecar, root) == [
                ("openrouter", "vendor/pooled-model", True, True, True, ""),
                ("nosuchprovider", "ghost", False, False, False, "config"),
                # Left core: the check names the plugin and never installs it.
                ("copilot-acp", "gpt-5", False, False, False, "config"),
                ("lab", "lab-model", True, True, True, ""),
                ("anthropic", "claude-synthetic", True, False, False, "auth"),
                ("zai", "glm-synthetic", True, False, False, "auth"),
            ]
        # The same provider is ready where the profile's own .env holds its key.
        assert _verdicts(sidecar, keyed) == [("anthropic", "claude-synthetic", True, True, True, "")]
        assert _verdicts(sidecar, plain) == []
    finally:
        assert sidecar.close() == 0
    # Pool order and counts as written: the check never rotated or counted a row. (Loading a pool still seeds a
    # config-declared provider's key into it, as every Agent pool read does.)
    pool = json.loads((root / "auth.json").read_text())["credential_pool"]["openrouter"]
    assert [(row["id"], row["priority"], row["request_count"]) for row in pool] == [("k0", 0, 0), ("k1", 1, 0)]
    assert not (root / "plugins").exists()
