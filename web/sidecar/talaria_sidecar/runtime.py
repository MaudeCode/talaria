"""Agent import, pin verification, and the runtime drift guard.

Ported from api/agent_runtime.py. The sidecar owns the Agent pin
(``sidecar/agent_dependency.json``): it compares the loaded checkout revision
with the pin at handshake and refuses further chat calls once the checkout
changes underneath the running interpreter.
"""

from __future__ import annotations

import errno
import importlib
import json
import math
import os
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import SIDECAR_RPC_VERSION
from .errors import RpcError

PIN_PATH = Path(__file__).resolve().parent.parent / "agent_dependency.json"
_RESTART_REQUIRED_MESSAGE = (
    "Hermes Agent was updated while Talaria Web was running. "
    "Talaria Web cannot verify that the Agent update completed safely. "
    "Check the Agent update outcome and environment first. "
    "Restart Talaria Web manually before retrying this action."
)
_AGENT_UPDATE_MARKER = ".hermes-update-in-progress"
_AGENT_RECOVERY_MARKERS = (".update-incomplete", ".lazy-refresh-incomplete")
_AGENT_UPDATE_MAX_AGE_SECONDS = 20 * 60
_AGENT_UPDATE_MARKER_MAX_BYTES = 64 * 1024
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_NONBLOCK = getattr(os, "O_NONBLOCK", 0)
_MARKER_SAFE_OPEN_AVAILABLE = bool(_O_NOFOLLOW) and bool(_O_NONBLOCK)


class AgentRuntimeStale(RpcError):
    def __init__(self, update_state: str | None):
        data = {"retryable": True, "restart_scheduled": False}
        if update_state is not None:
            data["agent_update_state"] = update_state
        super().__init__(_RESTART_REQUIRED_MESSAGE, condition="agent_runtime_stale", data=data)


class AgentIncompatible(RpcError):
    def __init__(self, message: str, **data):
        super().__init__(message, condition="agent_incompatible", data=data)


def read_pin(path: Path = PIN_PATH) -> dict:
    pin = json.loads(path.read_text(encoding="utf-8"))
    talaria = pin["x-talaria"]
    return {"version": talaria["version"], "source_revision": talaria["sourceRevision"], "image": pin["services"]["hermes-agent"]["image"]}


def _git(agent_dir: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(["git", "-C", str(agent_dir), *args], check=False, capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def read_agent_revision(agent_dir: Path | None, module_path: Path | None) -> str | None:
    """Return the checkout HEAD that supplied ``run_agent``, or None if untracked."""
    if agent_dir is None or module_path is None:
        return None
    worktree = _git(agent_dir, "rev-parse", "--show-toplevel")
    if not worktree:
        return None
    try:
        relative = module_path.relative_to(Path(worktree).resolve()).as_posix()
    except ValueError:
        return None
    if _git(Path(worktree), "--literal-pathspecs", "ls-files", "--error-unmatch", "--", relative) is None:
        return None
    return _git(Path(worktree), "rev-parse", "--verify", "HEAD")


def _pid_is_alive(pid: int) -> bool | None:
    if pid <= 0:
        return False
    if pid.bit_length() > 32:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OverflowError, ValueError):
        return None
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return False
        if exc.errno == errno.EPERM:
            return True
        return None
    return True


def _read_live_agent_update(marker: Path) -> str:
    """Classify the Agent update marker: absent, active, stale, or unknown."""
    if not _MARKER_SAFE_OPEN_AVAILABLE:
        try:
            marker.lstat()
        except FileNotFoundError:
            return "absent"
        except (OSError, ValueError, TypeError):
            return "unknown"
        return "unknown"
    try:
        fd = os.open(marker, os.O_RDONLY | _O_NONBLOCK | _O_NOFOLLOW)
    except FileNotFoundError:
        try:
            marker.lstat()
        except FileNotFoundError:
            return "absent"
        except OSError:
            return "unknown"
        return "unknown"
    except (OSError, ValueError, TypeError):
        return "unknown"
    try:
        try:
            st = os.fstat(fd)
        except OSError:
            return "unknown"
        if not stat.S_ISREG(st.st_mode) or st.st_size > _AGENT_UPDATE_MARKER_MAX_BYTES:
            return "unknown"
        try:
            data = os.read(fd, _AGENT_UPDATE_MARKER_MAX_BYTES + 1)
        except (OSError, BlockingIOError):
            return "unknown"
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    if len(data) > _AGENT_UPDATE_MARKER_MAX_BYTES:
        return "unknown"
    try:
        lines = data.decode("utf-8").splitlines()
        pid = int(lines[0].strip())
        started_at = float(lines[1].strip())
    except (IndexError, TypeError, ValueError, UnicodeError):
        return "unknown"
    if pid <= 0 or not math.isfinite(started_at):
        return "unknown"
    age = time.time() - started_at
    if age < 0:
        return "unknown"
    if age > _AGENT_UPDATE_MAX_AGE_SECONDS:
        return "stale"
    alive = _pid_is_alive(pid)
    if alive is None:
        return "unknown"
    return "active" if alive else "stale"


def _marker_presence(marker: Path) -> str:
    try:
        marker.lstat()
    except FileNotFoundError:
        return "absent"
    except OSError:
        return "unknown"
    return "present"


class AgentRuntime:
    """Loads the Agent once and guards against a changed checkout."""

    def __init__(self, hermes_home: Path, agent_dir: Path | None = None):
        self.hermes_home = Path(hermes_home)
        self.agent_dir = Path(agent_dir).resolve() if agent_dir else None
        self.pin = read_pin()
        self.loaded = False
        self.module_path: Path | None = None
        self.revision: str | None = None
        self.import_error: str | None = None
        self._lock = threading.Lock()

    # ── loading ───────────────────────────────────────────────────────────
    def load(self) -> None:
        with self._lock:
            if self.loaded:
                return
            try:
                module = importlib.import_module("run_agent")
                getattr(module, "AIAgent")
            except Exception as exc:  # noqa: BLE001 - reported as a handshake condition
                self.import_error = f"{type(exc).__name__}: {exc}"
                raise AgentIncompatible(f"Hermes Agent could not be imported: {self.import_error}", import_error=self.import_error)
            module_file = getattr(module, "__file__", None)
            self.module_path = Path(module_file).resolve() if module_file else None
            if self.agent_dir is None and self.module_path is not None:
                self.agent_dir = self.module_path.parent
            self.revision = read_agent_revision(self.agent_dir, self.module_path)
            self.loaded = True

    @property
    def agent_version(self) -> str | None:
        try:
            return getattr(importlib.import_module("hermes_cli"), "__version__", None)
        except Exception:  # noqa: BLE001
            return None

    # ── guards ────────────────────────────────────────────────────────────
    def _install_roots(self) -> tuple[Path, ...]:
        roots: list[Path] = []
        if self.agent_dir is not None:
            roots.append(self.agent_dir)
        python = Path(sys.executable)
        if python.parent.name.lower() in {"bin", "scripts"} and python.parent.parent.name.lower() in {"venv", ".venv"}:
            candidate = python.parent.parent.parent
            if all(os.path.normcase(str(candidate)) != os.path.normcase(str(root)) for root in roots):
                roots.append(candidate)
        return tuple(roots)

    def update_transaction_state(self) -> str:
        live = _read_live_agent_update(self.hermes_home / _AGENT_UPDATE_MARKER)
        if live == "unknown":
            return "unknown"
        recovery = False
        for root in self._install_roots():
            for name in _AGENT_RECOVERY_MARKERS:
                presence = _marker_presence(root / name)
                if presence == "unknown":
                    return "unknown"
                recovery = recovery or presence == "present"
        if recovery:
            return "incomplete"
        return "unverified" if live == "absent" else live

    def is_stale(self) -> bool:
        """True when the checkout revision no longer matches the loaded module."""
        if not self.loaded or self.revision is None:
            return False
        try:
            fresh = read_agent_revision(self.agent_dir, self.module_path)
        except Exception:  # noqa: BLE001 - unreadable fails closed like a change
            fresh = None
        return fresh != self.revision

    def ensure_current(self) -> None:
        """Raise ``agent_runtime_stale`` when the checkout changed since import."""
        if self.is_stale():
            raise AgentRuntimeStale(self.update_transaction_state())

    # ── handshake ─────────────────────────────────────────────────────────
    def describe(self) -> dict:
        compatible = bool(self.loaded and (self.revision is None or self.revision == self.pin["source_revision"]))
        return {
            "rpc_version": SIDECAR_RPC_VERSION,
            "python": sys.executable,
            "python_version": ".".join(str(part) for part in sys.version_info[:3]),
            "agent_dir": str(self.agent_dir) if self.agent_dir else None,
            "agent_revision": self.revision,
            "agent_version": self.agent_version if self.loaded else None,
            "pinned_revision": self.pin["source_revision"],
            "pinned_version": self.pin["version"],
            "pinned_image": self.pin["image"],
            "compatible": compatible,
            "stale": self.is_stale(),
            "update_state": self.update_transaction_state(),
            "import_error": self.import_error,
        }
