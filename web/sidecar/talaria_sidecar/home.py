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
import copy
import importlib
import json
import logging
import os
import sys
import threading
from pathlib import Path

from .errors import InvalidParams, RpcError

log = logging.getLogger("talaria_sidecar.home")

_ENV_LOCK = threading.RLock()
_RECOVERY_LOCK = threading.Lock()
_RECOVERED_HOMES: set[str] = set()
_RECOVERY_WARNED: set[str] = set()
_LAUNCH_ENV_LOCK = threading.Lock()
_LAUNCH_ENV: dict[str, str] | None = None
_SCOPE_CACHE_LOCK = threading.Lock()
_SCOPE_CACHE: dict[str, dict] = {}
_SCOPE_CACHE_MAX = 64


def _scope_stamp(home: Path) -> tuple | None:
    stamps = []
    for name in (".env", "config.yaml"):
        try:
            st = (home / name).stat()
        except FileNotFoundError:
            stamps.append(None)
        except OSError:
            return None  # Uncertain identity must never reuse credentials or terminal authority.
        else:
            stamps.append((st.st_dev, st.st_ino, st.st_mtime_ns, st.st_ctime_ns, st.st_size, st.st_mode))
    return tuple(stamps)


def _cached_scope(home: Path, kind: str, stamp: tuple | None, inputs, build):
    """One snapshot of each kind per home; bindings receive copies, never the memo itself."""
    key = str(home.absolute())
    with _SCOPE_CACHE_LOCK:
        scopes = _SCOPE_CACHE.pop(key, {})
        _SCOPE_CACHE[key] = scopes
        while len(_SCOPE_CACHE) > _SCOPE_CACHE_MAX:
            del _SCOPE_CACHE[next(iter(_SCOPE_CACHE))]
        cached = scopes.pop(kind, None)
        if (
            stamp is not None
            and cached is not None
            and cached[:2] == (stamp, inputs)
            and _scope_stamp(home) == stamp
        ):
            scopes[kind] = cached
            return copy.deepcopy(cached[2])
        value = build()
        # A writer racing the build cannot lend its file identity to stale bytes.
        if stamp is not None and _scope_stamp(home) == stamp:
            scopes[kind] = (stamp, copy.deepcopy(inputs), copy.deepcopy(value))
        return value


def _secret_scope_inputs(home: Path, named: bool):
    """File stamps alone cannot detect vault refreshes, managed policy, or launch-env edits."""
    try:
        from hermes_cli.env_loader import get_secret_source_values
        from hermes_cli.managed_scope import load_managed_env
        from gateway.config_loader import bridged_allow_all_users

        launch = None
        if not named:
            try:
                from tui_gateway.launch_profile_policy import _launch_env
            except ImportError:
                from agent.secret_scope import is_multiplex_active

                launch = _frozen_launch_env() if is_multiplex_active() else dict(os.environ)
            else:
                launch = _launch_env()
        return (get_secret_source_values(home), load_managed_env(), bridged_allow_all_users(), launch)
    except Exception:  # Older/partial Agents keep the original uncached builder and its policy.
        return None


def _process_home() -> Path:
    explicit = os.environ.get("HERMES_HOME", "")
    if explicit:
        return Path(explicit).expanduser()
    # Match Agent's literal suffix without importing Agent during sidecar startup.
    suffix = os.environ.get("HERMES_DATA_DIR_SUFFIX", "")
    if sys.platform == "win32":
        local_appdata = os.environ.get("LOCALAPPDATA", "").strip()
        base = Path(local_appdata) if local_appdata else Path.home() / "AppData" / "Local"
        return base / ("hermes" + suffix)
    return Path.home() / (".hermes" + suffix)


_PROCESS_HOME = _process_home()


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


def _launch_terminal_env() -> dict[str, str]:
    """Agent 0.21.3 twin of ``tui_gateway.launch_profile_policy.launch_terminal_env``."""
    return {k: v for k, v in _frozen_launch_env().items() if k.startswith("TERMINAL_")}


def _launch_secret_scope(home: Path) -> dict[str, str]:
    """Agent 0.21.3 twin of ``tui_gateway.launch_profile_policy.launch_secret_scope``."""
    from agent.secret_scope import _is_global_env, build_profile_secret_scope, is_multiplex_active

    env = _frozen_launch_env() if is_multiplex_active() else dict(os.environ)
    scope = {k: v for k, v in env.items() if not _is_global_env(k)}
    scope.update(build_profile_secret_scope(home))
    return scope


@contextlib.contextmanager
def _secret_scope(home: Path, stamp: tuple | None = None, *, load_plugins: bool = True):
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
        # Dashboard hosting must never load third-party code into this sidecar.
        if load_plugins:
            try:
                from hermes_cli.plugins import discover_plugins

                discover_plugins()
            except Exception:  # noqa: BLE001 - a broken plugin must not block the call, as in the Agent's own discovery
                log.debug("Plugin discovery failed for %s", home, exc_info=True)
            hydrate_profile_secret_sources(home)
    build = lambda: build_profile_secret_scope(home) if named else launch_secret_scope(home)
    inputs = _secret_scope_inputs(home, named)
    secrets = build() if inputs is None else _cached_scope(home, "secrets", stamp, inputs, build)
    scope_token = set_secret_scope(secrets)
    try:
        yield
    finally:
        reset_secret_scope(scope_token)


@contextlib.contextmanager
def _terminal_scope(home: Path, stamp: tuple | None = None):
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
    launch = None
    if not named:
        try:
            from agent.secret_scope import is_multiplex_active
        except ImportError:  # An Agent without multiplexing cannot layer the launch env, so the launch profile keeps the process env
            yield
            return
        try:
            from tui_gateway.launch_profile_policy import launch_terminal_env
        except ImportError:  # Agent 0.21.3: the sidecar's twin of the launch-profile policy
            launch_terminal_env = _launch_terminal_env
        # Like the launch secret scope: the live process env until multiplexing freezes it.
        launch = launch_terminal_env() if is_multiplex_active() else {k: v for k, v in os.environ.items() if k.startswith("TERMINAL_")}
    try:
        from tools.terminal_scope import build_profile_terminal_scope, set_terminal_scope, TerminalPolicyRefusal, TerminalPolicyUnavailable
    except ImportError:  # Keep the installed Agent's original behavior when its builder API is absent.
        token = install_profile_terminal_scope(home, env_overlay=launch) if not named else install_profile_terminal_scope(home)
    else:
        try:
            policy = _cached_scope(
                home, "terminal", stamp, (launch, str(Path.home())),
                lambda: build_profile_terminal_scope(home, env_overlay=launch),
            )
        except (OSError, TerminalPolicyUnavailable) as exc:
            policy = TerminalPolicyRefusal(str(exc))
        token = set_terminal_scope(policy)
    try:
        yield
    finally:
        reset_terminal_scope(token)


def profile_home_param(params: dict, key: str = "profile_home") -> Path:
    raw = params.get(key)
    if not isinstance(raw, str) or not raw.strip():
        raise InvalidParams(f"{key} is required")
    return Path(raw).expanduser()


def _recover_processes(home: Path) -> None:
    """Re-adopt the live processes a previous run checkpointed in ``home`` (TAL-533), once per home and before the
    first call in it can spawn: a spawn rewrites ``processes.json`` from the registry and would orphan them. A failed
    recovery fails the call (and every later one in that home until a retry succeeds), so nothing can overwrite the
    checkpoint it could not read."""
    key = str(home.resolve())
    with _RECOVERY_LOCK:
        if key in _RECOVERED_HOMES:
            return
        try:
            from tools import process_registry as registry_module
        except ImportError:  # an Agent without the registry has nothing to recover
            _RECOVERED_HOMES.add(key)
            return
        try:
            # The Agent reads an unreadable or malformed checkpoint as "nothing to recover"; that must not count as recovered.
            checkpoint = registry_module._checkpoint_path()
            if checkpoint.exists() and not isinstance(json.loads(checkpoint.read_text(encoding="utf-8")), list):
                raise ValueError(f"{checkpoint} is not a list")
            recovered = registry_module.process_registry.recover_from_checkpoint()
            from .methods.process import track_recovered

            track_recovered(registry_module.process_registry)
        except Exception as exc:  # noqa: BLE001
            # Retried on every call in the home; reported once per home so a lasting failure does not flood the log.
            log.log(logging.DEBUG if key in _RECOVERY_WARNED else logging.WARNING, "Background process recovery failed for %s", home, exc_info=True)
            _RECOVERY_WARNED.add(key)
            raise RpcError(f"background process recovery failed for {home}; its processes.json could not be re-adopted: {exc}") from exc
        _RECOVERED_HOMES.add(key)
    if recovered:
        log.info("Recovered %d background process(es) for %s", recovered, home)


@contextlib.contextmanager
def scoped_home(home: Path, *, load_plugins: bool = True):
    """Run the body with Hermes Agent resolving ``get_hermes_home()`` to ``home``."""
    home = Path(home).expanduser()
    stamp = _scope_stamp(home)
    try:
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    except Exception:  # noqa: BLE001 - older Agent without context-local homes
        set_hermes_home_override = reset_hermes_home_override = None
    if set_hermes_home_override is not None:
        token = set_hermes_home_override(home)
        try:
            with _secret_scope(home, stamp, load_plugins=load_plugins), _terminal_scope(home, stamp):
                _recover_processes(home)
                yield home
        finally:
            reset_hermes_home_override(token)
        return
    with _ENV_LOCK:
        previous = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(home)
        try:
            with _secret_scope(home, stamp, load_plugins=load_plugins), _terminal_scope(home, stamp):
                _recover_processes(home)
                yield home
        finally:
            if previous is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = previous


@contextlib.contextmanager
def session_workspace(workspace: str | None):
    """Bind the session's declared workspace (the Agent's ``_SESSION_CWD``), so terminals, AGENTS.md discovery and goal
    gates run there instead of the sidecar's launch directory. No workspace keeps the Agent's own resolution. A context
    variable, so concurrent calls never share it; a missing Agent surface is logged, not fatal."""
    try:
        from agent.runtime_cwd import _SESSION_CWD
    except Exception:  # noqa: BLE001
        log.debug("session cwd bind unavailable", exc_info=True)
        _SESSION_CWD = None
    if not workspace or _SESSION_CWD is None:
        yield
        return
    token = _SESSION_CWD.set(str(workspace))
    try:
        yield
    finally:
        _SESSION_CWD.reset(token)
