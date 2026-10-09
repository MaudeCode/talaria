"""TAL-265: ``commands.bundles``/``commands.bundle_resolve`` and ``commands.moa_preset`` (old test_issue4087_skill_bundles.py,
test_issue5057_moa_webui_route.py, and test_moa_model_picker_provider.py)."""

from __future__ import annotations

import os
import pathlib
import sys
import types

import pytest

from conftest import SidecarProcess, load_schema, requires_agent, validate
from talaria_sidecar.errors import INVALID_PARAMS, RpcError
from talaria_sidecar.methods import commands


def _fake_module(monkeypatch, name: str, **attrs) -> None:
    package = name.rsplit(".", 1)[0]
    monkeypatch.setitem(sys.modules, package, sys.modules.get(package) or types.ModuleType(package))
    monkeypatch.setitem(sys.modules, name, types.SimpleNamespace(**attrs))


def _shared_cache(*_args):
    raise AssertionError("the Agent's process-wide bundle cache is shared with other profiles' callers")


def _fake_bundles(monkeypatch, bundles=(), resolve=None, blocks=None) -> dict:
    """Bundle files as dicts; ``seen`` records what the Agent's skill helpers were asked to do."""
    seen: dict = {}

    def load_blocks(identifiers, load, note, task_id, *, disabled_names):
        seen["blocks"] = (identifiers, note("x"), task_id, disabled_names)
        return blocks if blocks is not None else (identifiers[:1], identifiers[1:], [], [f"[{identifiers[0]} body]"])

    def header(subject, loaded, **kwargs):
        seen["header"] = (subject, loaded, kwargs)
        return f"HEADER {subject}"

    _fake_module(monkeypatch, "agent.skill_bundles", _iter_bundle_files=lambda: list(bundles), _load_bundle_file=lambda b: b,
                 scan_bundles=_shared_cache, get_skill_bundles=_shared_cache, list_bundles=_shared_cache,
                 resolve_bundle_command_key=_shared_cache, build_bundle_invocation_message=_shared_cache)
    _fake_module(monkeypatch, "agent.skill_commands", resolve_slash_key=resolve or (lambda command, table: f"/{command.replace('_', '-')}" if f"/{command.replace('_', '-')}" in table else None),
                 _load_skill_blocks=load_blocks, _load_skill_payload=lambda identifier: None, _scaffold_header=header, _disabled_skill_names=lambda platform: {"off"})
    return seen


def _bundle(slug: str, skills: list[str], **extra) -> dict:
    return {"name": slug, "slug": slug, "skills": skills, **extra}


def test_list_command_bundles_reads_the_profile_files_not_the_shared_cache(monkeypatch) -> None:
    _fake_bundles(monkeypatch, [
        _bundle("incident-review", ["triage", "report"], description="Investigate incidents with the bundled workflow"),
        None,  # an unreadable bundle file
        _bundle("bare", ["one"]),
        _bundle("bare", ["two", "three"]),  # a duplicate slug keeps the first file, as scan_bundles does
    ])
    assert commands.list_command_bundles() == [
        {"name": "bare", "description": "Skill bundle", "skill_count": 1, "source": "bundle"},
        {"name": "incident-review", "description": "Investigate incidents with the bundled workflow", "skill_count": 2, "source": "bundle"},
    ]


def test_list_command_bundles_degrades_to_empty(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "agent.skill_bundles", None)
    assert commands.list_command_bundles() == []

    def explode():
        raise OSError("unreadable bundles dir")

    _fake_module(monkeypatch, "agent.skill_bundles", _iter_bundle_files=explode)
    assert commands.list_command_bundles() == []


def test_resolve_bundle_command_builds_the_agent_invocation(monkeypatch) -> None:
    seen = _fake_bundles(monkeypatch, [_bundle("incident-review", ["triage", "gone"], instruction="Be brief.")])
    assert commands.resolve_bundle_command("/incident_review the primary alerts") == {
        "name": "incident-review", "source": "bundle", "message": 'HEADER "incident-review" skill bundle\n\n[triage body]',
        "loaded_skills": ["triage"], "missing_skills": ["gone"],
    }
    assert seen["blocks"] == (["triage", "gone"], '[Loaded as part of the "incident-review" skill bundle.]', None, {"off"})
    assert seen["header"] == ('"incident-review" skill bundle', ["triage"], {
        "lead_lines": ["Bundle: incident-review"], "missing": ["gone"], "disabled": [], "extra_instruction": "Be brief.", "user_instruction": "the primary alerts"})


def _condition(exc: pytest.ExceptionInfo) -> str | None:
    return exc.value.data.get("condition")


def test_resolve_bundle_command_raises_for_unknown_bundle(monkeypatch) -> None:
    _fake_bundles(monkeypatch, [_bundle("incident-review", ["triage"])])
    with pytest.raises(RpcError, match="Bundle command not found") as exc:
        commands.resolve_bundle_command("/does-not-exist investigate this")
    assert _condition(exc) == "bundle_not_found"


def test_resolve_bundle_command_wraps_unexpected_runtime_errors(monkeypatch) -> None:
    def explode(_command, _table):
        raise AttributeError("bundle runtime broke")

    _fake_bundles(monkeypatch, [_bundle("incident-review", ["triage"])], resolve=explode)
    with pytest.raises(RpcError, match="Skill bundle command unavailable") as exc:
        commands.resolve_bundle_command("/incident-review investigate this")
    assert _condition(exc) == "bundle_unavailable"
    # A bundle whose skills all fail to load builds no message.
    _fake_bundles(monkeypatch, [_bundle("empty", ["gone"])], blocks=([], ["gone"], [], []))
    with pytest.raises(RpcError, match="no invocation text") as exc:
        commands.resolve_bundle_command("/empty")
    assert _condition(exc) == "bundle_unavailable"
    monkeypatch.setitem(sys.modules, "agent.skill_bundles", None)
    with pytest.raises(RpcError, match="Skill bundle runtime unavailable"):
        commands.resolve_bundle_command("/incident-review")


def test_resolve_bundle_command_rejects_bad_input(monkeypatch) -> None:
    def invalid(_command, _table):
        raise ValueError("bad bundle name")

    _fake_bundles(monkeypatch, resolve=invalid)
    for command, message in (("   ", "command is required"), ("/x", "bad bundle name")):
        with pytest.raises(RpcError, match=message) as exc:
            commands.resolve_bundle_command(command)
        assert exc.value.code == INVALID_PARAMS


def _fake_moa(monkeypatch, *, default_preset="moa-default", usage="Usage: /moa <prompt>", config=None, normalize=None, resolve_preset=None) -> None:
    attrs = {"normalize_moa_config": normalize or (lambda raw: {"default_preset": default_preset}), "moa_usage": lambda: usage}
    if resolve_preset is not None:
        attrs["resolve_moa_preset"] = resolve_preset
    _fake_module(monkeypatch, "hermes_cli.moa_config", **attrs)

    def load_config():
        if config is None:
            raise RuntimeError("no config")
        return config

    _fake_module(monkeypatch, "hermes_cli.config", load_config=load_config)


def test_resolve_moa_config_returns_expected_shape(monkeypatch) -> None:
    _fake_moa(monkeypatch, default_preset="moa-fast", usage="/moa <prompt> -- run with MoA", config={"moa": {}})
    result = commands.resolve_moa_config(None)
    assert result == {"default_preset": "moa-fast", "preset": "moa-fast", "usage": "/moa <prompt> -- run with MoA"}


def test_resolve_moa_config_degrades_without_config(monkeypatch) -> None:
    _fake_moa(monkeypatch, default_preset="moa-default-cfg")
    result = commands.resolve_moa_config(None)
    assert result["default_preset"] == "moa-default-cfg" and result["preset"] == "moa-default-cfg"


def test_resolve_moa_config_raises_when_moa_unavailable(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "hermes_cli.moa_config", None)
    with pytest.raises(RpcError, match="MoA runtime unavailable") as exc:
        commands.resolve_moa_config(None)
    assert _condition(exc) == "moa_unavailable"


MOA_CONFIG = {"moa": {"default_preset": "default", "presets": {
    "default": {"enabled": True, "reference_models": [{"provider": "copilot", "model": "claude-sonnet-4.6"}], "aggregator": {"provider": "copilot", "model": "gpt-5.5"}},
    "Frontier Tuned": {"enabled": True, "reference_models": [{"provider": "copilot", "model": "claude-opus-4.8"}], "aggregator": {"provider": "copilot", "model": "gpt-5.4"}},
}}}


def _normalize(raw):
    return {"default_preset": raw.get("default_preset", "default"), "presets": raw.get("presets", {})}


def test_resolve_moa_config_uses_selected_preset(monkeypatch) -> None:
    _fake_moa(monkeypatch, config=MOA_CONFIG, normalize=_normalize, resolve_preset=lambda raw, name: {**raw["presets"][name], "selected": name})
    result = commands.resolve_moa_config("Frontier Tuned")
    assert result["preset"] == "Frontier Tuned" and result["selected"] == "Frontier Tuned"
    assert result["aggregator"] == {"provider": "copilot", "model": "gpt-5.4"}
    # An unknown preset falls back to the default one.
    assert commands.resolve_moa_config("nope")["preset"] == "default"


def test_resolve_moa_config_falls_back_when_preset_resolution_raises(monkeypatch) -> None:
    def explode(_raw, _name):
        raise RuntimeError("preset broke")

    _fake_moa(monkeypatch, config={"moa": {"default_preset": "default", "presets": {"default": {"enabled": True}}}}, normalize=_normalize, resolve_preset=explode)
    result = commands.resolve_moa_config("default")
    assert result["preset"] == "default" and result["presets"] == {"default": {"enabled": True}}


def test_resolve_moa_config_ignores_non_dict_preset_result(monkeypatch) -> None:
    _fake_moa(monkeypatch, config={"moa": {"default_preset": "default", "presets": {"default": {"enabled": True}}}}, normalize=_normalize, resolve_preset=lambda raw, name: None)
    result = commands.resolve_moa_config("default")
    assert result == {"default_preset": "default", "presets": {"default": {"enabled": True}}, "preset": "default", "usage": "Usage: /moa <prompt>"}


def _write_bundle(home: pathlib.Path, name: str, skills: list[str], mtime: float) -> None:
    folder = home / "skill-bundles"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.yaml").write_text(f"name: {name}\nskills: [{', '.join(skills)}]\n", encoding="utf-8")
    for path in (folder / f"{name}.yaml", folder):
        os.utime(path, (mtime, mtime))


@requires_agent
def test_bundles_are_scoped_to_each_profile(tmp_path: pathlib.Path) -> None:
    home = tmp_path / "home" / ".hermes"
    other = home / "profiles" / "beta"
    other.mkdir(parents=True)
    # Equal mtimes defeat the Agent's process-wide mtime cache, so only a rescan per call keeps profiles apart.
    _write_bundle(home, "alpha-kit", ["cat-finder"], 1_700_000_000)
    _write_bundle(other, "beta-kit", ["cat-finder", "not-installed"], 1_700_000_000)
    skill = other / "skills" / "cat-finder"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: cat-finder\ndescription: Find cats\n---\nLook for cats.\n", encoding="utf-8")
    sidecar = SidecarProcess(home)
    try:
        for profile, name, count in ((home, "alpha-kit", 1), (other, "beta-kit", 2), (home, "alpha-kit", 1)):
            result = sidecar.result("commands.bundles", {"profile_home": str(profile)})
            assert validate(result, load_schema("commands.bundles")) == []
            assert result["bundles"] == [{"name": name, "description": f"Load {count} skills as a bundle", "skill_count": count, "source": "bundle"}]
        resolved = sidecar.result("commands.bundle_resolve", {"profile_home": str(other), "command": "/beta_kit find a cat"})
        assert validate(resolved, load_schema("commands.bundle_resolve")) == []
        assert resolved["name"] == "beta-kit" and resolved["loaded_skills"] == ["cat-finder"] and resolved["missing_skills"] == ["not-installed"]
        assert "find a cat" in resolved["message"]
        missing, _ = sidecar.call("commands.bundle_resolve", {"profile_home": str(other), "command": "/alpha-kit"})
        assert missing["error"]["data"]["condition"] == "bundle_not_found"
    finally:
        sidecar.close()
