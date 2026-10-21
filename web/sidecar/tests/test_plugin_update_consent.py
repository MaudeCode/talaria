"""Plugin consent ownership runs in-process; real Agent scan policy lives in test_plugin_updates."""
import sys
from types import ModuleType, SimpleNamespace

import pytest

from talaria_sidecar.errors import RpcError
from talaria_sidecar.methods import commands


@pytest.fixture
def plugin_update(monkeypatch, tmp_path):
    state = {"home": tmp_path / "default", "revision": "a" * 40, "digest": "installed", "source": "source-a",
             "verdict": "caution", "report": "reviewed scan", "detail": "full scan detail", "now": 0}
    effects = []

    def module(name, **values):
        mod = ModuleType(name)
        mod.__path__ = []
        mod.__dict__.update(values)
        monkeypatch.setitem(sys.modules, name, mod)

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
        carry_user_files(target)
        scan = SimpleNamespace(verdict=state["verdict"], report=state["report"], scan_provenance={"scanner_version": "1"}, findings=[SimpleNamespace(detail=state["detail"])])
        if scan.verdict == "dangerous" or scan.verdict == "caution" and not scan_decision_cb(scan):
            raise ScanBlocked(scan)
        effects.append(target)

    pc = SimpleNamespace(_find_plugin_entry=find, PluginOperationError=OperationError, PluginScanBlocked=ScanBlocked,
                         _read_install_metadata=lambda: {"p": {"source": state["source"]}},
                         _resolve_git_executable=lambda: "git", _git_head_revision=lambda *_: state["revision"])
    monkeypatch.setattr(commands, "_plugin_update_modules", lambda: (pc, SimpleNamespace(update_plugin=transaction), None))
    monkeypatch.setattr(commands, "_PLUGIN_UPDATE_CONSENTS", {})
    monkeypatch.setattr(commands, "time", SimpleNamespace(monotonic=lambda: state["now"]))
    module("hermes_constants", get_hermes_home=lambda: state["home"])
    module("pm")
    module("pm.store", tree_digest=lambda _: state["digest"])
    module("tools")
    module("tools.plugin_guard", format_scan_report=lambda scan: scan.report)
    module("hermes_cli")
    module("hermes_cli.plugins", discover_plugins=lambda **_: None)
    return state, effects


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
    assert len(effects) == 1
    with pytest.raises(RpcError) as error:
        commands.update_plugin("p", True, revised["consent_token"])
    assert error.value.data["condition"] == "plugin_update_consent_changed"
    assert len(effects) == 1


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
    assert len(effects) == 1


def test_changed_full_scan_findings_require_fresh_consent(plugin_update):
    state, effects = plugin_update
    review = commands.update_plugin("p", False)
    state["detail"] = "changed detail beyond the abbreviated report"
    result = commands.update_plugin("p", True, review["consent_token"])
    assert result["status"] == "needs_consent"
    assert result["consent_token"] != review["consent_token"]
    assert effects == []
