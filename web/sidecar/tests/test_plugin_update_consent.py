"""Plugin consent and unattended-update ownership runs in-process; real Agent policy lives in test_plugin_updates."""
from contextlib import contextmanager, nullcontext
import sys
from types import ModuleType, SimpleNamespace

import pytest

from talaria_sidecar.errors import InvalidParams, RpcError
from talaria_sidecar.methods import Registry, commands


def agent_module(monkeypatch, name, **values):
    mod = ModuleType(name)
    mod.__path__ = []
    mod.__dict__.update(values)
    monkeypatch.setitem(sys.modules, name, mod)


@pytest.fixture
def plugin_update(monkeypatch, tmp_path):
    state = {"home": tmp_path / "default", "revision": "a" * 40, "digest": "installed", "source": "source-a",
             "verdict": "caution", "report": "reviewed scan", "detail": "full scan detail", "now": 0}
    effects = []

    def module(name, **values):
        agent_module(monkeypatch, name, **values)

    class OperationError(Exception):
        pass

    class ScanBlocked(OperationError):
        def __init__(self, scan):
            super().__init__(scan.report)
            self.scan_result = scan

    def find(key):
        target = state["home"] / "plugins" / key
        target.mkdir(parents=True, exist_ok=True)
        return key, "1", "", "user", target, key

    def transaction(target, *, force, scan_decision_cb, carry_user_files):
        assert force is False  # A blanket force must never bypass the identity check.
        if state.get("replace_during_stage"):
            state["digest"] = "concurrent replacement"
        carry_user_files(target)
        scan = SimpleNamespace(verdict=state["verdict"], report=state["report"], scan_provenance={"scanner_version": "1"}, findings=[SimpleNamespace(detail=state["detail"])])
        if state.get("replace_during_scan"):
            state["digest"] = "concurrent replacement"
        if scan.verdict == "dangerous" or scan.verdict == "caution" and not scan_decision_cb(scan):
            raise ScanBlocked(scan)
        effects.append(target)

    pc = SimpleNamespace(_find_plugin_entry=find, PluginOperationError=OperationError, PluginScanBlocked=ScanBlocked,
                         _read_install_metadata=lambda: {"p": {"source": state["source"]}},
                         _resolve_git_executable=lambda: "git", _git_head_revision=lambda *_: state["revision"])
    monkeypatch.setattr(commands, "_plugin_update_modules", lambda: (pc, SimpleNamespace(update_plugin=transaction), None))
    monkeypatch.setattr(commands, "_PLUGIN_UPDATE_CONSENTS", {})
    monkeypatch.setattr(commands, "scoped_home", lambda *_: nullcontext())
    monkeypatch.setattr(commands, "time", SimpleNamespace(monotonic=lambda: state["now"]))
    module("hermes_constants", get_hermes_home=lambda: state["home"])
    module("pm")
    module("pm.store", tree_digest=lambda _: state["digest"])
    module("tools")
    module("tools.plugin_guard", format_scan_report=lambda scan: scan.report)
    module("hermes_cli")
    module("hermes_cli.plugins", discover_plugins=lambda **_: effects.append("rediscovered"))
    state["operation_error"] = OperationError
    return state, effects


def published(effects):
    return [effect for effect in effects if effect != "rediscovered"]


@pytest.mark.parametrize("changed", ["profile", "plugin", "revision", "safe_revision", "installed_tree", "source", "expired", "unknown"])
def test_changed_consent_cannot_publish_a_plugin(plugin_update, changed):
    state, effects = plugin_update
    review = commands.update_plugin("p", False)
    token = review["consent_token"]
    key = "p"
    if changed == "profile":
        state["home"] = state["home"].parent / "other"
    elif changed == "plugin":
        key = "q"
    elif changed in {"revision", "safe_revision"}:
        state["revision"] = "b" * 40
        if changed == "safe_revision":
            state["verdict"] = "safe"
    elif changed == "installed_tree":
        state["digest"] = "replacement install"
    elif changed == "source":
        state["source"] = "source-b"
    elif changed == "expired":
        state["now"] = 301
    else:
        token = "unknown-token"
    with pytest.raises(RpcError) as error:
        commands.update_plugin(key, True, token)
    assert error.value.data["condition"] == "plugin_update_consent_changed"
    assert effects == []


def test_caution_requires_matching_scan_and_single_use_consent(plugin_update):
    state, effects = plugin_update
    assert commands.update_plugin("p", True)["status"] == "needs_consent"
    review = commands.update_plugin("p", False)
    state["report"] = "changed findings"
    revised = commands.update_plugin("p", True, review["consent_token"])
    assert revised["status"] == "needs_consent" and effects == []
    assert revised["consent_token"] != review["consent_token"]
    assert commands.update_plugin("p", True, revised["consent_token"])["status"] == "updated"
    assert len(published(effects)) == 1
    with pytest.raises(RpcError) as error:
        commands.update_plugin("p", True, revised["consent_token"])
    assert error.value.data["condition"] == "plugin_update_consent_changed"
    assert len(published(effects)) == 1


def test_dangerous_verdict_blocks_even_a_matching_consent(plugin_update):
    state, effects = plugin_update
    review = commands.update_plugin("p", False)
    state["verdict"] = "dangerous"
    result = commands.update_plugin("p", True, review["consent_token"])
    assert result["status"] == "blocked" and result["verdict"] == "dangerous"
    assert effects == []


def test_safe_update_needs_no_caution_override(plugin_update):
    state, effects = plugin_update
    state["verdict"] = "safe"
    assert commands.update_plugin("p", False)["status"] == "updated"
    assert len(published(effects)) == 1


def test_changed_full_scan_findings_require_fresh_consent(plugin_update):
    state, effects = plugin_update
    review = commands.update_plugin("p", False)
    state["detail"] = "changed detail beyond the abbreviated report"
    result = commands.update_plugin("p", True, review["consent_token"])
    assert result["status"] == "needs_consent"
    assert result["consent_token"] != review["consent_token"]
    assert effects == []


@pytest.mark.parametrize("phase", ["stage", "scan"])
def test_replaced_install_during_staging_cannot_use_caution_consent(plugin_update, phase):
    state, effects = plugin_update
    review = commands.update_plugin("p", False)
    state["replace_during_stage" if phase == "stage" else "replace_during_scan"] = True
    try:
        commands.update_plugin("p", True, review["consent_token"])
    except RpcError as error:
        assert error.data["condition"] == "plugin_update_consent_changed"
    assert effects == [], "Consent published an installation replaced after preflight"


@pytest.fixture
def unattended(monkeypatch, plugin_update):
    """The Agent's plugins_auto_update module (v0.23.0+) over synthetic install records."""
    state, effects = plugin_update
    state.update(auto_apply=False, check_hours=24.0, lock_held=False, lock_busy=False, writes=[],
                 outcome={"results": [], "skipped": [], "current": 0})

    @contextmanager
    def plugin_update_lock(target):
        if state["lock_busy"]:
            raise state["operation_error"](f"Plugin '{target.name}' is already being updated by another Hermes process; nothing was changed.")
        state["lock_held"] = True
        try:
            yield
        finally:
            state["lock_held"] = False

    def set_auto_update(enabled):
        if state.get("managed"):
            raise state["operation_error"]("This Hermes install's configuration is managed by a package manager; set plugins.auto_apply there.")
        state["writes"].append(enabled)
        state["auto_apply"] = enabled
        return {"auto_apply": enabled, "check_hours": state["check_hours"]}

    agent_module(monkeypatch, "hermes_cli.plugins_auto_update", plugin_update_lock=plugin_update_lock, set_auto_update=set_auto_update,
                 auto_update_state=lambda: {"auto_apply": state["auto_apply"], "check_hours": state["check_hours"]},
                 update_all_unattended=lambda: state["outcome"], HELD_WITH_REF="held with --ref; {name}",
                 held_with_ref=lambda record: bool(record and record.get("held")))
    return state, effects


def rpc(method, tmp_path, **params):
    registry = Registry(SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    commands.register(registry)
    handler = registry.methods.get(method)
    assert handler is not None, f"{method} is not registered"
    return handler(None, {"profile_home": str(tmp_path), **params})


def test_auto_update_state_and_set_go_through_the_agent(unattended, tmp_path):
    state, _ = unattended
    assert rpc("plugins.auto_update", tmp_path) == {"supported": True, "auto_apply": False, "check_hours": 24.0}
    assert rpc("plugins.auto_update_set", tmp_path, enabled=True) == {"supported": True, "auto_apply": True, "check_hours": 24.0}
    assert state["writes"] == [True]
    assert rpc("plugins.auto_update", tmp_path)["auto_apply"] is True
    with pytest.raises(InvalidParams):
        rpc("plugins.auto_update_set", tmp_path, enabled="yes")
    assert state["writes"] == [True]


def test_a_managed_config_returns_the_agents_refusal(unattended, tmp_path):
    state, _ = unattended
    state["managed"] = True
    with pytest.raises(RpcError, match="managed by a package manager") as error:
        rpc("plugins.auto_update_set", tmp_path, enabled=True)
    assert error.value.data["condition"] == "plugin_update_refused"
    assert state["writes"] == [] and state["auto_apply"] is False


def test_update_all_maps_every_row_and_rereads_only_after_a_change(unattended, tmp_path):
    state, effects = unattended
    state["outcome"] = {
        "results": [{"name": "moved", "status": "updated", "detail": ""}, {"name": "same", "status": "current", "detail": ""},
                    {"name": "broken", "status": "failed", "detail": "git failed"}, {"name": "wider", "status": "needs_review", "detail": "adds tools: x"}],
        "skipped": [{"name": "held", "reason": "held with --ref"}], "current": 2,
    }
    assert rpc("plugins.update_all", tmp_path) == {"current": 2, "results": [
        {"name": "moved", "status": "updated", "detail": ""}, {"name": "same", "status": "current", "detail": ""},
        {"name": "broken", "status": "failed", "detail": "git failed"}, {"name": "wider", "status": "needs_review", "detail": "adds tools: x"},
        {"name": "held", "status": "skipped", "detail": "held with --ref"}]}
    assert effects == ["rediscovered"]
    effects.clear()
    state["outcome"] = {"results": [{"name": "wider", "status": "needs_review", "detail": "adds tools: x"}], "skipped": [{"name": "held", "reason": "held with --ref"}], "current": 0}
    assert [row["status"] for row in rpc("plugins.update_all", tmp_path)["results"]] == ["needs_review", "skipped"]
    assert effects == [], "A batch that moved nothing has nothing to reload"


def test_an_agent_without_the_module_offers_neither_control(plugin_update, tmp_path):
    assert rpc("plugins.auto_update", tmp_path)["supported"] is False
    for method, params in (("plugins.auto_update_set", {"enabled": True}), ("plugins.update_all", {})):
        with pytest.raises(RpcError) as error:
            rpc(method, tmp_path, **params)
        assert error.value.data["condition"] == "plugin_update_unsupported"


def test_a_git_update_holds_the_update_lock_and_a_busy_lock_is_a_refusal(unattended, monkeypatch):
    state, effects = unattended
    state["verdict"] = "safe"
    pc, transaction, cached = commands._plugin_update_modules()
    seen = []
    def locked_transaction(target, **kwargs):
        seen.append(state["lock_held"])
        return transaction.update_plugin(target, **kwargs)
    monkeypatch.setattr(commands, "_plugin_update_modules", lambda: (pc, SimpleNamespace(update_plugin=locked_transaction), cached))
    assert commands.update_plugin("p", False)["status"] == "updated"
    assert seen == [True] and state["lock_held"] is False
    effects.clear()
    state["lock_busy"] = True
    with pytest.raises(RpcError, match="already being updated") as error:
        commands.update_plugin("p", False)
    assert error.value.data["condition"] == "plugin_update_refused"
    assert effects == [] and seen == [True]


@pytest.fixture
def catalog_install(monkeypatch, unattended):
    """A pinned catalog install record; the re-pin stands in for the Agent's catalog update path."""
    state, effects = unattended
    state.update(pin="b" * 40, delta={"tools": ["new_tool"]}, record={"catalog_name": "probe", "sha": "a" * 40, "pin": "a" * 40},
                 install_record={"source": "source-a", "pinned": True, "catalog": {"name": "probe", "sha": "a" * 40, "pin": "a" * 40}})
    pc, transaction, cached = commands._plugin_update_modules()
    metadata = {"p": state["install_record"]}
    monkeypatch.setattr(pc, "_read_install_metadata", lambda: metadata)

    class RepinConsentRequired(Exception):
        def __init__(self, name, sha, delta):
            super().__init__(f"Updating '{name}' to {sha[:8]} adds {delta}. Confirm to continue.")
            self.sha, self.delta = sha, delta

    def repin(target, record, *, consent_cb=None, **_):
        assert record is state["record"] and state["lock_held"], "A re-pin runs under the plugin's update lock"
        if state["delta"] and not (consent_cb is not None and consent_cb(state["delta"])):
            raise RepinConsentRequired(record["catalog_name"], state["pin"], state["delta"])
        effects.append(target)
        return SimpleNamespace(changed=True, installed_name=target.name, sha=state["pin"], warnings=[])

    def git_update(*_, **__):
        raise AssertionError("A catalog install never takes the Git path")

    native = SimpleNamespace(RepinConsentRequired=RepinConsentRequired, repin_catalog_plugin=repin,
                             catalog_install_record=lambda _: state["record"],
                             get_live_catalog_entry=lambda _: SimpleNamespace(sha=state["pin"]))
    agent_module(monkeypatch, "hermes_cli.plugins_cmd_catalog", **vars(native))
    monkeypatch.setattr(commands, "_plugin_update_modules", lambda: (pc, SimpleNamespace(update_plugin=git_update), cached))
    return state, effects


def test_a_catalog_update_needs_no_consent_until_its_pin_widens(catalog_install):
    state, effects = catalog_install
    state["delta"] = {}
    assert commands.update_plugin("p", False) == {"key": "p", "status": "updated"}
    assert len(published(effects)) == 1


def test_a_widened_catalog_pin_goes_through_single_use_consent(catalog_install):
    state, effects = catalog_install
    review = commands.update_plugin("p", False)
    assert review["status"] == "needs_consent" and review["verdict"] == "widened" and "new_tool" in review["findings"]
    assert published(effects) == []
    assert commands.update_plugin("p", True, review["consent_token"])["status"] == "updated"
    assert len(published(effects)) == 1
    with pytest.raises(RpcError) as error:
        commands.update_plugin("p", True, review["consent_token"])
    assert error.value.data["condition"] == "plugin_update_consent_changed"
    assert len(published(effects)) == 1


@pytest.mark.parametrize("changed", ["delta", "pin"])
def test_consent_covers_only_the_widening_the_user_read(catalog_install, changed):
    state, effects = catalog_install
    review = commands.update_plugin("p", False)
    if changed == "delta":
        state["delta"] = {"tools": ["new_tool", "another_tool"]}
    else:
        state["pin"] = "c" * 40
    revised = commands.update_plugin("p", True, review["consent_token"])
    assert revised["status"] == "needs_consent" and revised["consent_token"] != review["consent_token"]
    assert published(effects) == []


def test_a_changed_install_cannot_use_widening_consent(catalog_install):
    state, effects = catalog_install
    review = commands.update_plugin("p", False)
    state["digest"] = "replacement install"
    with pytest.raises(RpcError) as error:
        commands.update_plugin("p", True, review["consent_token"])
    assert error.value.data["condition"] == "plugin_update_consent_changed"
    assert published(effects) == []


def test_a_ref_hold_is_never_moved_by_a_stale_update(catalog_install):
    state, effects = catalog_install
    state["install_record"]["held"] = True
    with pytest.raises(RpcError, match="held with --ref") as error:
        commands.update_plugin("p", False)
    assert error.value.data["condition"] == "plugin_update_refused"
    assert published(effects) == []


def test_a_busy_lock_refuses_a_catalog_update(catalog_install):
    state, effects = catalog_install
    state["lock_busy"] = True
    with pytest.raises(RpcError, match="already being updated") as error:
        commands.update_plugin("p", False)
    assert error.value.data["condition"] == "plugin_update_refused"
    assert published(effects) == []
