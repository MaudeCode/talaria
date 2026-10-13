"""Own an Agent sync process tree until completion or the sidecar's stdin pipe closes.

This small supervisor survives a killed sidecar long enough to stop and reap the
writer. Its OS lock prevents a replacement sidecar from starting another writer
before that cleanup finishes. Only stdlib imports, even with broken Agent deps.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading


def _lock(file) -> None:
    if os.name == "nt":
        import msvcrt
        file.seek(0)
        if not file.read(1):
            file.write(b"0")
            file.flush()
        file.seek(0)
        msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _stop_tree(child: subprocess.Popen) -> None:
    if os.name == "nt":
        # taskkill is part of Windows and terminates the descendants as well.
        subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    else:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    child.wait()


def main() -> int:
    root = Path(sys.argv[1]).resolve()
    stopped = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopped.set())

    def owner_exited() -> None:
        try:
            os.read(0, 1)
        finally:
            stopped.set()

    threading.Thread(target=owner_exited, daemon=True).start()
    lock_path = Path(os.environ["HERMES_HOME"]) / ".talaria-agent-sync" / hashlib.sha256(os.fsencode(root)).hexdigest()
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lease:
        try:
            _lock(lease)
        except OSError:
            print("Another Agent dependency sync is still running.", file=sys.stderr)
            return 1
        if stopped.is_set():
            return 1
        child = subprocess.Popen(
            [sys.executable, "-m", "hermes_cli.venv_sync", "--project-root", str(root), "--json"],
            cwd=root, stdin=subprocess.DEVNULL, start_new_session=os.name != "nt",
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
        try:
            while child.poll() is None:
                if stopped.wait(0.05):
                    _stop_tree(child)
                    return 1
            return child.returncode
        finally:
            if child.poll() is None:
                _stop_tree(child)


if __name__ == "__main__":
    raise SystemExit(main())
