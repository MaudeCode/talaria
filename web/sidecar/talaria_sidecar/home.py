"""Profile-home and credential scoping for Agent calls.

The Python backend pinned Hermes Agent's process-global HERMES_HOME per request
with a shared lock. Inside the sidecar every method receives the explicit
``profile_home`` the server resolved, and runs under Hermes Agent's own
context-local override when the installed Agent exposes it
(``hermes_constants.set_hermes_home_override``), falling back to a locked
process-wide swap of ``HERMES_HOME`` for older Agents.

Credentials use the Agent's own multi-profile hosting policy: a named profile
activates fail-closed multiplexing and installs its file-backed secret scope;
the launch profile installs the Agent's frozen launch scope. A miss can never
fall through to another profile's process environment. Agent 0.21.3 has the
multiplex switch and secret scopes but not the launch-profile policy module, so
the sidecar mirrors that policy for it. If the installed Agent has no secret
scope, named-profile calls fail closed instead.

Terminal policy follows the same split. Under a home override the Agent skips its
config-to-env terminal bridge, so every call also binds the profile's complete
``TERMINAL_*`` scope from its own ``.env`` and ``config.yaml``; the launch profile layers
its launch-process ``TERMINAL_*`` under those files.
"""

from __future__ import annotations

import contextlib
import importlib
import os
import sys
import threading
from pathlib import Path

from .errors import InvalidParams, RpcError

_ENV_LOCK = threading.RLock()
_LAUNCH_ENV_LOCK = threading.Lock()
_LAUNCH_ENV: dict[str, str] | None = None
_PROCESS_HOME = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()


def _is_named_profile(home: Path) -> bool:
    try:
        return home.resolve() != _PROCESS_HOME.resolve()
    except OSError:
        return True


def _frozen_launch_env() -> dict[str, str]:
    """The launch profile's environment, frozen before the first named profile runs; the first capture wins."""
    global _LAUNCH_ENV
    with _LAUNCH_ENV_LOCK:
        if _LAUNCH_ENV is None:
            _LAUNCH_ENV = dict(os.environ)
        return dict(_LAUNCH_ENV)


def edit_launch_env(to_set: dict[str, str], to_unset: list[str]) -> None:
    """Carry a Web-owned ``.env`` edit into the frozen launch environments, so a removed credential stops resolving for the launch profile."""

    def edit(snapshot: dict[str, str] | None) -> None:
        if snapshot is not None:
            for name in to_unset:
                snapshot.pop(name, None)
            snapshot.update(to_set)

    with _LAUNCH_ENV_LOCK:
        edit(_LAUNCH_ENV)
    # Only an imported policy module can hold a frozen snapshot; importing it waits out a first import still running elsewhere.
    if sys.modules.get("tui_gateway.launch_profile_policy") is not None:
        policy = importlib.import_module("tui_gateway.launch_profile_policy")
        with policy._lock:
            edit(policy._snapshot)


def _activate_multi_profile_hosting() -> None:
    """Agent 0.21.3 twin of ``tui_gateway.launch_profile_policy.activate_multi_profile_hosting``."""
    from agent.secret_scope import set_multiplex_active

    _frozen_launch_env()
    set_multiplex_active(True)


def _launch_secret_scope(home: Path) -> dict[str, str]:
    """Agent 0.21.3 twin of ``tui_gateway.launch_profile_policy.launch_secret_scope``."""
    from agent.secret_scope import _is_global_env, build_profile_secret_scope, is_multiplex_active

    env = _frozen_launch_env() if is_multiplex_active() else dict(os.environ)
    scope = {k: v for k, v in env.items() if not _is_global_env(k)}
    scope.update(build_profile_secret_scope(home))
    return scope


@contextlib.contextmanager
def _secret_scope(home: Path):
    """Install ``home``'s credential scope for the call; named profiles run under multiplex semantics."""
    named = _is_named_profile(home)
    try:
        from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
        from hermes_cli.env_loader import hydrate_profile_secret_sources
        try:
            from tui_gateway.launch_profile_policy import activate_multi_profile_hosting, launch_secret_scope
        except ImportError:
            # Probe the whole 0.21.3 surface up front so a partial Agent fails closed before the body.
            from agent.secret_scope import _is_global_env, is_multiplex_active, set_multiplex_active  # noqa: F401
            activate_multi_profile_hosting, launch_secret_scope = _activate_multi_profile_hosting, _launch_secret_scope
    except Exception:  # noqa: BLE001 - older Agent without a secret scope
        if named:
            raise RpcError(
                "profile credential isolation is unavailable in this Hermes Agent; named-profile calls are refused",
                condition="agent_incompatible",
            )
        yield
        return
    if named:
        activate_multi_profile_hosting()
        hydrate_profile_secret_sources(home)
        secrets = build_profile_secret_scope(home)
    else:
        secrets = launch_secret_scope(home)
    scope_token = set_secret_scope(secrets)
    try:
        yield
    finally:
        reset_secret_scope(scope_token)


@contextlib.contextmanager
def _terminal_scope(home: Path):
    """Install ``home``'s terminal policy for the call; a policy file that cannot be read refuses terminal execution."""
    named = _is_named_profile(home)
    try:
        from tools.terminal_scope import install_profile_terminal_scope, reset_terminal_scope
    except Exception:  # noqa: BLE001 - older Agent without terminal scopes
        if named:
            raise RpcError(
                "profile terminal isolation is unavailable in this Hermes Agent; named-profile calls are refused",
                condition="agent_incompatible",
            )
        yield
        return
    if named:
        token = install_profile_terminal_scope(home)
    else:
        try:
            from agent.secret_scope import is_multiplex_active
            from tui_gateway.launch_profile_policy import launch_terminal_env
        except ImportError:  # Agent 0.21.3 cannot layer the launch env, so the launch profile keeps the process env
            yield
            return
        # Like the launch secret scope: the live process env until multiplexing freezes it.
        launch = launch_terminal_env() if is_multiplex_active() else {k: v for k, v in os.environ.items() if k.startswith("TERMINAL_")}
        token = install_profile_terminal_scope(home, env_overlay=launch)
    try:
        yield
    finally:
        reset_terminal_scope(token)


def profile_home_param(params: dict, key: str = "profile_home") -> Path:
    raw = params.get(key)
    if not isinstance(raw, str) or not raw.strip():
        raise InvalidParams(f"{key} is required")
    return Path(raw).expanduser()


@contextlib.contextmanager
def scoped_home(home: Path):
    """Run the body with Hermes Agent resolving ``get_hermes_home()`` to ``home``."""
    home = Path(home).expanduser()
    try:
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    except Exception:  # noqa: BLE001 - older Agent without context-local homes
        set_hermes_home_override = reset_hermes_home_override = None
    if set_hermes_home_override is not None:
        token = set_hermes_home_override(home)
        try:
            with _secret_scope(home), _terminal_scope(home):
                yield home
        finally:
            reset_hermes_home_override(token)
        return
    with _ENV_LOCK:
        previous = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(home)
        try:
            with _secret_scope(home), _terminal_scope(home):
                yield home
        finally:
            if previous is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = previous
