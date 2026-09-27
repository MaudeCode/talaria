"""Run on the Agent interpreter: concurrent default and named-profile calls through ``scoped_home``.

Prints one JSON line with what each profile's credential reads resolved to while every
profile's scope was live at once, and what was left installed after each exit path.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from pathlib import Path

sys.path.append(sys.argv[1])

from agent.secret_scope import current_secret_scope, get_secret  # noqa: E402
from talaria_sidecar.home import scoped_home  # noqa: E402

ROOT = Path(os.environ["HERMES_HOME"])
HOMES = {"default": ROOT, "alpha": ROOT / "profiles" / "alpha", "beta": ROOT / "profiles" / "beta"}
KEYS = ("OPENAI_API_KEY", "ALPHA_ONLY", "LAUNCH_ENV_ONLY")
barrier = threading.Barrier(len(HOMES), timeout=30)
results: dict = {}


def _read() -> dict:
    return {key: get_secret(key) for key in KEYS}


def _outcome(body):
    try:
        return body()
    except Exception as exc:  # noqa: BLE001 - reported to the test
        barrier.abort()
        return type(exc).__name__


def _concurrent(home: Path) -> dict:
    with scoped_home(home):
        barrier.wait()  # every profile's scope is live before anyone reads
        seen = _read()
        barrier.wait()  # and stays live until everyone has read
    return seen


def _exit_with(home: Path, exc: BaseException):
    try:
        with scoped_home(home):
            raise exc
    except type(exc):
        pass
    return current_secret_scope()


def _call(name: str) -> None:
    home = HOMES[name]
    results[name] = {
        "success": _outcome(lambda: _concurrent(home)),
        "scope_after_success": current_secret_scope(),
        "scope_after_error": _outcome(lambda: _exit_with(home, ValueError("body failed"))),
        "scope_after_cancel": _outcome(lambda: _exit_with(home, asyncio.CancelledError())),
    }


threads = [threading.Thread(target=_call, args=(name,)) for name in HOMES]
for thread in threads:
    thread.start()
for thread in threads:
    thread.join()


def _read_in(home: Path) -> dict:
    with scoped_home(home):
        return _read()


# The launch profile keeps its process-exported credentials after named-profile calls.
results["default_after_named"] = _outcome(lambda: _read_in(ROOT))
print(json.dumps(results, sort_keys=True))
