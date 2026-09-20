"""Profile-home scoping for Agent calls.

The Python backend pins Hermes Agent's process-global HERMES_HOME per request
with a shared lock. Inside the sidecar every method receives the explicit
``profile_home`` the server resolved, and runs under Hermes Agent's own
context-local override when the installed Agent exposes it
(``hermes_constants.set_hermes_home_override``), falling back to a locked
process-wide swap of ``HERMES_HOME`` for older Agents.
"""

from __future__ import annotations

import contextlib
import os
import threading
from pathlib import Path

from .errors import InvalidParams

_ENV_LOCK = threading.RLock()


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
            yield home
        finally:
            reset_hermes_home_override(token)
        return
    with _ENV_LOCK:
        previous = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(home)
        try:
            yield home
        finally:
            if previous is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = previous
