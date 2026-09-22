"""Profile-home and credential scoping for Agent calls.

The Python backend pinned Hermes Agent's process-global HERMES_HOME per request
with a shared lock. Inside the sidecar every method receives the explicit
``profile_home`` the server resolved, and runs under Hermes Agent's own
context-local override when the installed Agent exposes it
(``hermes_constants.set_hermes_home_override``), falling back to a locked
process-wide swap of ``HERMES_HOME`` for older Agents.

Credentials are scoped the same way the Agent's multiplexing gateway does it
(``agent.secret_scope``): the profile's own ``.env`` (plus its external secret
sources) is installed as the context-local secret scope for the call. For a
named profile the call also runs under multiplex semantics, so a miss never
falls through to ``os.environ`` — the default profile's keys, which the server
copied into the process environment at startup, cannot be resolved by another
profile. If the installed Agent has no secret scope, named-profile calls fail
closed instead of running with the inherited environment.
"""

from __future__ import annotations

import contextlib
import os
import threading
from pathlib import Path

from .errors import InvalidParams, RpcError

_ENV_LOCK = threading.RLock()
_PROCESS_HOME = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()


def _is_named_profile(home: Path) -> bool:
    try:
        return home.resolve() != _PROCESS_HOME.resolve()
    except OSError:
        return True


@contextlib.contextmanager
def _secret_scope(home: Path):
    """Install ``home``'s credential scope for the call; named profiles run under multiplex semantics."""
    named = _is_named_profile(home)
    try:
        from agent.secret_scope import (
            build_profile_secret_scope,
            reset_multiplex_context,
            reset_secret_scope,
            set_multiplex_context,
            set_secret_scope,
        )
    except Exception:  # noqa: BLE001 - older Agent without a secret scope
        if named:
            raise RpcError(
                "profile credential isolation is unavailable in this Hermes Agent; named-profile calls are refused",
                condition="agent_incompatible",
            )
        yield
        return
    scope_token = set_secret_scope(build_profile_secret_scope(home))
    mux_token = set_multiplex_context(True) if named else None
    try:
        yield
    finally:
        if mux_token is not None:
            reset_multiplex_context(mux_token)
        reset_secret_scope(scope_token)


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
            with _secret_scope(home):
                yield home
        finally:
            reset_hermes_home_override(token)
        return
    with _ENV_LOCK:
        previous = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(home)
        try:
            with _secret_scope(home):
                yield home
        finally:
            if previous is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = previous
