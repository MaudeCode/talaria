"""Dependency-light helpers for launching child processes consistently."""

from __future__ import annotations

import subprocess
import sys
import threading

# A GUI launcher that has not exited within this window is either slow to
# hand off or is the real application; either way the request thread stops
# waiting and the periodic sweep reaps it.
_DETACHED_SPAWN_REAP_TIMEOUT_SECONDS = 0.2
_PENDING_DETACHED_SPAWNS: set[subprocess.Popen] = set()
_PENDING_DETACHED_SPAWNS_LOCK = threading.Lock()


def windows_hide_flags() -> int:
    """Hide a short-lived console child on Win32 and remain a POSIX no-op.

    ``CREATE_NO_WINDOW`` keeps captured stdout and stderr connected, unlike
    detaching the process. Passing ``0`` elsewhere preserves the subprocess
    default. See #5692.
    """
    if sys.platform == "win32":
        return getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return 0


def spawn_detached_app(cmd: list[str]) -> subprocess.Popen:
    """Launch an external viewer/editor without leaking a zombie (HWEB-45).

    The reveal-in-file-manager and open-in-editor routes hand a path to
    ``open`` / ``explorer.exe`` / ``xdg-open`` / the configured editor. Those
    helpers exit within milliseconds after handing off to the real GUI app, so
    a fire-and-forget ``Popen`` leaves a zombie behind on every click for the
    lifetime of a server that runs for weeks.

    ``start_new_session=True`` detaches the child from the server's process
    group so a terminal signal cannot reach it. The short wait reaps the usual
    fast exit inline; anything slower is parked for the periodic sweep in
    :func:`reap_detached_spawns` rather than blocking the request thread.
    """
    reap_detached_spawns()
    proc = subprocess.Popen(cmd, start_new_session=True)
    try:
        proc.wait(timeout=_DETACHED_SPAWN_REAP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        with _PENDING_DETACHED_SPAWNS_LOCK:
            _PENDING_DETACHED_SPAWNS.add(proc)
    return proc


def reap_detached_spawns() -> int:
    """Poll every parked detached spawn and forget the ones that have exited.

    ``poll()`` is what actually reaps the child: it calls ``waitpid`` with
    ``WNOHANG`` and stores the status. Returns the number reaped this pass.
    """
    with _PENDING_DETACHED_SPAWNS_LOCK:
        pending = list(_PENDING_DETACHED_SPAWNS)
    reaped = [proc for proc in pending if proc.poll() is not None]
    if not reaped:
        return 0
    with _PENDING_DETACHED_SPAWNS_LOCK:
        _PENDING_DETACHED_SPAWNS.difference_update(reaped)
    return len(reaped)
