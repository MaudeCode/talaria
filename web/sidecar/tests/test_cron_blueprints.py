"""Automation blueprints use the Agent catalog and active profile plugins."""
from pathlib import Path

import pytest

from conftest import SidecarProcess, requires_agent


@requires_agent
@pytest.mark.parametrize("isolation", ["in_process", "host"])
def test_profile_blueprints_fill_and_validate(tmp_path: Path, isolation: str):
    home = tmp_path / "home" / ".hermes"
    other = home / "profiles" / "other"
    other.mkdir(parents=True)
    plugin = home / "plugins" / "team"
    plugin.mkdir(parents=True)
    (plugin / "plugin.yaml").write_text("name: team\nversion: 0.0.1\ndescription: Synthetic blueprint\n")
    (home / "config.yaml").write_text(f"plugins:\n  isolation: {isolation}\n  enabled: [team]\n")
    (plugin / "__init__.py").write_text("""
def register(ctx):
    ctx.register_automation_blueprint('brief', title='Team brief', description='Team news',
        prompt_template='Brief {topic}', schedule_template='{minute} {hour} * * *',
        slots=[{'name': 'topic', 'type': 'text', 'label': 'Topic'},
               {'name': 'time', 'type': 'time', 'label': 'Time', 'default': '09:00'}],
        skills=['summary'], deliver_default='local')
""")
    sidecar = SidecarProcess(home)
    try:
        for profile in (home, other, home):
            params = {"profile_home": str(profile)}
            response, _ = sidecar.call("cron.blueprints", params)
            assert "result" in response, response
            rows = response["result"]["blueprints"]
            assert any(b["source"] == "builtin" for b in rows)
            matches = [b for b in rows if b["key"] == "team:brief"]
            assert len(matches) == (1 if profile == home else 0)
            if profile == other:
                continue
            assert matches[0]["source"] == "plugin" and matches[0]["plugin"] == "team"
            filled = sidecar.result("cron.blueprint_fill", {**params, "key": "team:brief", "values": {"topic": "releases", "time": "08:30"}})["draft"]
            assert filled == {"prompt": "Brief releases", "schedule": "30 8 * * *", "name": "Team brief", "deliver": "local", "skills": ["summary"]}
            error, _ = sidecar.call("cron.blueprint_fill", {**params, "key": "team:brief", "values": {"topic": "x", "time": "25:99"}})
            assert error["error"]["code"] == -32602 and "invalid time" in error["error"]["message"]
        assert not (home / "cron" / "jobs.json").exists()
    finally:
        sidecar.close()


def test_an_agent_without_blueprints_has_an_empty_catalog(monkeypatch):
    from types import SimpleNamespace
    from talaria_sidecar.methods import Registry, cron
    from talaria_sidecar.errors import InvalidParams

    registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    cron.register(registry)
    original_import = cron.importlib.import_module

    def missing(name):
        if name == "cron.blueprint_catalog":
            raise ModuleNotFoundError("No blueprint catalog", name=name)
        return original_import(name)

    monkeypatch.setattr(cron.importlib, "import_module", missing)
    assert registry.methods["cron.blueprints"](None, {}) == {"blueprints": []}
    with pytest.raises(InvalidParams, match="unavailable"):
        registry.methods["cron.blueprint_fill"](None, {"key": "missing", "values": {}})
