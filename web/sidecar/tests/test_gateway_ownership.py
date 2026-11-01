"""TAL-1627: ``gateway.ownership`` decides who owns a monitored loopback port from the Agent's own gateway identity checks.

Synthetic Agent modules stand in for the identity helpers; no process launches and no socket is opened.
"""

from __future__ import annotations

import re
import subprocess
import sys
import types
from pathlib import Path

import pytest

from talaria_sidecar import agent_services as services
from talaria_sidecar.methods import gateway

OWN, HOST = (101, 1.0), (202, 2.0)


@pytest.fixture
def agent(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """A root home with a named profile; ``runtimes`` names each home's live gateway, ``listeners`` each PID's port answer."""
    root = tmp_path / "home"
    work = root / "profiles" / "work"
    work.mkdir(parents=True)
    state = types.SimpleNamespace(root=root.resolve(), work=work.resolve(), runtimes={}, verified=True, listeners={}, raises=None, selector="work")

    def runtime(pid_path: Path):
        if state.raises:
            raise state.raises
        return state.runtimes.get(pid_path.parent)

    status = types.ModuleType("gateway.status")
    status.get_running_pid_identity_strict = runtime
    package = types.ModuleType("gateway")
    package.status = status
    pause = types.ModuleType("hermes_cli.update_cmd_posix_pause")
    profiles = types.ModuleType("hermes_cli.profiles")
    profiles._PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
    cli = types.ModuleType("hermes_cli")
    cli.update_cmd_posix_pause = pause
    cli.profiles = profiles
    constants = types.ModuleType("hermes_constants")
    constants.profile_name_for_home = lambda home: state.selector
    for name, module in {"gateway": package, "gateway.status": status, "hermes_cli": cli, "hermes_cli.update_cmd_posix_pause": pause,
                         "hermes_cli.profiles": profiles, "hermes_constants": constants}.items():
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(services, "_gateway_home_matches", lambda home, runtime, used: used is pause and state.verified)
    monkeypatch.setattr(services, "listener_state", lambda pid, port: state.listeners.get(pid, "none") if port == 8642 else "none")
    return state


def test_no_gateway_is_stopped_with_the_profile_start_command(agent) -> None:
    assert gateway.ownership(agent.work, 8642) == {"state": "stopped", "start_command": "hermes --profile work gateway start"}


@pytest.mark.parametrize(("runtimes", "listeners", "expected"), [
    ({"work": OWN}, {101: "owned"}, "owned"),
    ({"root": HOST}, {202: "owned"}, "owned"),  # the root host gateway serves the named profile
    ({"work": OWN, "root": HOST}, {101: "other", 202: "owned"}, "owned"),
    ({"work": OWN}, {101: "other"}, "foreign"),  # a tunnel or port map holds the port beside a live gateway
    ({"work": OWN}, {101: "none"}, "unbound"),  # running, not listening yet
    ({"work": OWN, "root": HOST}, {101: "none", 202: "other"}, "foreign"),
])
def test_a_verified_gateway_owns_the_port_only_when_it_holds_every_listener(agent, runtimes, listeners, expected) -> None:
    agent.runtimes = {getattr(agent, home): identity for home, identity in runtimes.items()}
    agent.listeners = listeners
    assert gateway.ownership(agent.work, 8642)["state"] == expected
    assert gateway.ownership(agent.work, 9000)["state"] == "unbound"  # another port: nothing listens there


def test_the_root_profile_checks_only_its_own_home(agent) -> None:
    agent.selector = "default"
    agent.runtimes = {agent.work: OWN}
    agent.listeners = {101: "owned"}
    assert gateway.ownership(agent.root, 8642) == {"state": "stopped", "start_command": "hermes --profile default gateway start"}


@pytest.mark.parametrize("failure", ["identity", "ambiguous", "inventory"])
def test_unproven_identity_or_unreadable_evidence_is_unverified(agent, monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    agent.runtimes = {agent.work: OWN}
    agent.listeners = {101: "owned"}
    if failure == "identity":
        agent.verified = False  # a live PID whose home, command line or profile the Agent cannot confirm
    elif failure == "ambiguous":
        agent.raises = RuntimeError("ambiguous gateway runtime state")
    else:
        monkeypatch.setattr(services, "listener_state", lambda pid, port: (_ for _ in ()).throw(PermissionError("fd table")))
    assert gateway.ownership(agent.work, 8642)["state"] == "unverified"


def test_an_agent_without_the_identity_helpers_proves_nothing(agent, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "hermes_cli.update_cmd_posix_pause", None)
    monkeypatch.delattr(sys.modules["hermes_cli"], "update_cmd_posix_pause")
    agent.runtimes = {agent.work: OWN}
    assert gateway.ownership(agent.work, 8642)["state"] == "unverified"


@pytest.mark.parametrize("selector", ["Work", "work;rm -rf ~", "", None])
def test_only_a_valid_profile_id_is_echoed_as_a_command(agent, selector) -> None:
    agent.selector = selector
    assert gateway.ownership(agent.work, 8642)["start_command"] is None


@pytest.mark.parametrize(("stdout", "returncode", "expected"), [
    ("p4242\nf3\n", 0, "owned"),
    ("p4242\np77\n", 0, "other"),
    ("p77\n", 0, "other"),
    ("", 1, "none"),
])
def test_listener_state_reads_the_darwin_socket_inventory(monkeypatch: pytest.MonkeyPatch, stdout: str, returncode: int, expected: str) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, returncode, stdout, "")

    monkeypatch.setattr(subprocess, "run", run)
    assert services.listener_state(4242, 8642) == expected
    assert calls == [["/usr/sbin/lsof", "-nP", "-iTCP:8642", "-sTCP:LISTEN", "-Fp"]]
    # The update path keeps requiring sole ownership.
    if expected != "owned":
        with pytest.raises(RuntimeError, match="listener ownership could not be proved"):
            services.verify_listener({"pid": 4242, "port": 8642, "host": "127.0.0.1", "label": "svc"})
    else:
        services.verify_listener({"pid": 4242, "port": 8642, "host": "127.0.0.1", "label": "svc"})
