"""TAL-805: each profile's gateway mode under the host multiplexer (own, served, parked, standalone, stopped)."""

from __future__ import annotations

import pathlib
import sys
import types

import pytest

from conftest import AGENT_DIR, SidecarProcess, assert_matches, requires_agent


@requires_agent
@pytest.mark.skipif(AGENT_DIR is None or "def profile_is_parked" not in (AGENT_DIR / "hermes_cli" / "profiles.py").read_text(), reason="Agent without the parked and standalone helpers")
def test_markers_report_parked_and_standalone_in_profiles_and_gateway_mode(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    profiles = hermes_home / "profiles"
    parked, solo, idle = (profiles / n for n in ("parked", "solo", "idle"))
    for home in (parked, solo, idle):
        home.mkdir(parents=True)
    (parked / "gateway.parked").touch()
    (solo / "config.yaml").write_text("gateway:\n  standalone: true\n", encoding="utf-8")

    result = handshaken.result("profiles.list", {"base_home": str(hermes_home)})
    assert_matches("profiles.list", result)
    rows = {row["name"]: row for row in result["profiles"]}
    assert {name: (row.get("gateway_mode"), row["gateway_running"]) for name, row in rows.items()} == {
        "default": ("stopped", False), "parked": ("parked", False), "solo": ("standalone", False), "idle": ("stopped", False),
    }

    for home, mode in ((hermes_home, "stopped"), (parked, "parked"), (solo, "standalone"), (idle, "stopped")):
        answer = handshaken.result("gateway.mode", {"profile_home": str(home), "name": home.name, "is_default": home == hermes_home})
        assert_matches("gateway.mode", answer)
        assert answer == {"gateway_mode": mode}, home
    # The root profile is the host: a parked marker in its home does not park it.
    (hermes_home / "gateway.parked").touch()
    assert handshaken.result("gateway.mode", {"profile_home": str(hermes_home), "name": "default", "is_default": True}) == {"gateway_mode": "stopped"}


def _agent(monkeypatch: pytest.MonkeyPatch, **helpers) -> None:
    module = types.ModuleType("hermes_cli.profiles")
    for name, value in helpers.items():
        setattr(module, name, value)
    package = types.ModuleType("hermes_cli")
    package.profiles = module
    monkeypatch.setitem(sys.modules, "hermes_cli", package)
    monkeypatch.setitem(sys.modules, "hermes_cli.profiles", module)


@pytest.mark.parametrize(
    ("is_default", "parked", "standalone", "served", "running", "mode"),
    [
        (False, True, False, False, False, "parked"),
        (False, True, False, False, True, "own"),  # the marker is intent: a live `--force` gateway still runs, as in `hermes -p X gateway status`
        (False, True, False, True, True, "served"),  # still served until the host drops it
        (False, False, False, True, True, "served"),  # the host's PID, not the profile's own
        (False, False, True, False, True, "own"),  # a standalone profile running its own gateway
        (False, False, True, False, False, "standalone"),
        (False, False, False, False, True, "own"),
        (False, False, False, False, False, "stopped"),
        (True, True, True, True, False, "stopped"),  # the default profile is the host, never parked, served, or standalone
        (True, False, False, False, True, "own"),
    ],
)
def test_mode_precedence(monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path, is_default, parked, standalone, served, running, mode) -> None:
    _agent(
        monkeypatch,
        profile_is_parked=lambda home: parked, profile_is_standalone=lambda home: standalone,
        _served_by_running_multiplexer=lambda name: served, _check_gateway_running=lambda home: running,
    )
    from talaria_sidecar.methods.profiles import gateway_mode

    assert gateway_mode(tmp_path, "x", is_default) == mode


def test_an_agent_without_the_multiplexer_helpers_reports_own_or_stopped(monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path) -> None:
    from talaria_sidecar.methods.profiles import gateway_mode

    _agent(monkeypatch, _check_gateway_running=lambda home: True)
    assert gateway_mode(tmp_path, "x", False) == "own"
    _agent(monkeypatch, _check_gateway_running=lambda home: False)
    assert gateway_mode(tmp_path, "x", False) == "stopped"
    _agent(monkeypatch, _served_by_running_multiplexer=lambda name: True, _check_gateway_running=lambda home: True)
    assert gateway_mode(tmp_path, "x", False) == "served"
    _agent(monkeypatch, _check_gateway_running=lambda home: 1 / 0, profile_is_standalone=lambda home: 1 / 0)
    assert gateway_mode(tmp_path, "x", False) == "stopped"


def test_a_failing_parked_probe_fails_closed(monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path) -> None:
    """Whether the profile is parked is unknown, so it is never reported served or running."""
    from talaria_sidecar.methods.profiles import gateway_mode

    _agent(monkeypatch, profile_is_parked=lambda home: 1 / 0, _served_by_running_multiplexer=lambda name: True, _check_gateway_running=lambda home: True)
    assert gateway_mode(tmp_path, "x", False) == "stopped"
    # The root profile is never parked, so its own gateway still counts.
    assert gateway_mode(tmp_path, "default", True) == "own"
