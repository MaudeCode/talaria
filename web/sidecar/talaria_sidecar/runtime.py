"""Agent import, pin verification, and the runtime drift guard.

Ported from api/agent_runtime.py. The sidecar owns the Agent pin
(``sidecar/agent_dependency.json``): it compares the loaded checkout revision
with the pin at handshake and refuses further chat calls once the checkout
changes underneath the running interpreter.
"""

from __future__ import annotations

import errno
import importlib
import hashlib
import json
import logging
import math
import os
import re
import stat
import subprocess
import sys
import sysconfig
import threading
import time
from pathlib import Path

from . import SIDECAR_RPC_VERSION
from .errors import RpcError

log = logging.getLogger("talaria_sidecar.runtime")

PIN_PATH = Path(__file__).resolve().parent.parent / "agent_dependency.json"
_RUNTIME_UNAVAILABLE_MESSAGE = (
    "Agent runtime is unavailable. Check the Agent update outcome before retrying this action."
)
_AGENT_UPDATE_MARKER = ".hermes-update-in-progress"
_AGENT_RECOVERY_MARKERS = (".update-incomplete", ".lazy-refresh-incomplete")
_AGENT_UPDATE_MAX_AGE_SECONDS = 20 * 60
_AGENT_UPDATE_MARKER_MAX_BYTES = 64 * 1024
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_NONBLOCK = getattr(os, "O_NONBLOCK", 0)
_MARKER_SAFE_OPEN_AVAILABLE = bool(_O_NOFOLLOW) and bool(_O_NONBLOCK)


class AgentRuntimeStale(RpcError):
    def __init__(self, update_state: str | None, message: str | None = None, *, source_changed: bool = False):
        data = {"retryable": True, "restart_scheduled": False, "agent_source_changed": source_changed}
        if update_state is not None:
            data["agent_update_state"] = update_state
        if message is None:
            message = {
                "active": "Agent update is in progress. Wait for it to finish before starting new work.",
                "incomplete": "Agent update recovery is incomplete. Finish the Agent update before starting new work.",
            }.get(update_state, _RUNTIME_UNAVAILABLE_MESSAGE)
        super().__init__(message, condition="agent_runtime_stale", data=data)


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


def _head_stamp(agent_dir: Path | None) -> tuple | None:
    """Identity of the checkout's HEAD without spawning git: stats of ``.git/HEAD`` and of the ref it names."""
    if agent_dir is None:
        return None
    git_dir = agent_dir / ".git"
    try:
        if git_dir.is_file():  # worktree: ``gitdir: <path>``
            target = git_dir.read_text(encoding="utf-8").strip()
            git_dir = Path(target[len("gitdir:"):].strip()) if target.startswith("gitdir:") else git_dir
        head = git_dir / "HEAD"
        st = head.stat()
        parts: list = [st.st_mtime_ns, st.st_size, st.st_ino]
        content = head.read_text(encoding="utf-8").strip()
        if content.startswith("ref:"):
            ref = git_dir / content[len("ref:"):].strip()
            try:
                rst = ref.stat()
                parts.extend([rst.st_mtime_ns, rst.st_size, rst.st_ino])
            except OSError:
                parts.append("packed")
                try:
                    pst = (git_dir / "packed-refs").stat()
                    parts.extend([pst.st_mtime_ns, pst.st_size])
                except OSError:
                    parts.append(None)
        return tuple(parts)
    except OSError:
        return None


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


def installed_agent_version() -> str | None:
    """Agents since v0.21.6 resolve their identity from the install stamp, else the checkout's release tag; their
    ``__version__`` reads only the stamp, which a source checkout does not have."""
    try:
        from hermes_cli.version_info import get_version_info
    except ModuleNotFoundError as error:
        if error.name != "hermes_cli.version_info":
            raise
        return getattr(importlib.import_module("hermes_cli"), "__version__", None)
    return get_version_info().base_version


def _python_abi(major: int | str, minor: int | str, free_threaded: bool) -> str:
    """``3.14`` or ``3.14t``: regular and free-threaded builds of one version load different native extensions."""
    return f"{major}.{minor}{'t' if free_threaded else ''}"


def _site_packages_python(entry: str) -> tuple[str, Path] | None:
    """The Python ABI a ``sys.path`` site-packages directory was built for, and that venv's interpreter."""
    path = Path(entry)
    if path.name != "site-packages" or not path.is_dir():
        return None
    match = re.fullmatch(r"python(\d+)\.(\d+)(t?)", path.parent.name)
    if match and path.parent.parent.name in {"lib", "lib64"}:
        return _python_abi(match[1], match[2], bool(match[3])), path.parent.parent.parent / "bin" / "python"
    if path.parent.name.lower() == "lib":
        venv = path.parent.parent
        try:
            config = (venv / "pyvenv.cfg").read_text(encoding="utf-8")
        except OSError:
            return None
        found = re.search(r"^\s*version(?:_info)?\s*=\s*(\d+)\.(\d+)", config, re.MULTILINE)
        if found:
            free_threaded = re.search(r"^\s*executable\s*=.*python\d+\.\d+t(?:\.exe)?\s*$", config, re.MULTILINE | re.IGNORECASE)
            return _python_abi(found[1], found[2], bool(free_threaded)), venv / "Scripts" / "python.exe"
    return None


def _check_site_packages_python() -> None:
    """Compiled Agent dependencies load lazily on the first chat; fail the handshake when ``sys.path`` holds
    site-packages built for another Python (a stale ``HERMES_WEBUI_PYTHON`` after a PM environment update)."""
    running = _python_abi(sys.version_info[0], sys.version_info[1], bool(sysconfig.get_config_var("Py_GIL_DISABLED")))
    for entry in sys.path:
        built = _site_packages_python(entry)
        if built is not None and built[0] != running:
            raise ImportError(
                f"interpreter Python {running} cannot load Agent packages built for Python {built[0]} ({entry}); "
                f"unset HERMES_WEBUI_PYTHON or point it at {built[1]}"
            )


class AgentRuntime:
    """Loads the Agent once and guards against a changed checkout."""

    def __init__(self, hermes_home: Path, agent_dir: Path | None = None):
        self.hermes_home = Path(hermes_home)
        self._stale_lock = threading.Lock()
        self._stale = False
        self._source_changed = False
        self._stale_stamp: tuple | None = None
        self._receipt_discovery: dict = {}
        self.agent_dir = Path(agent_dir).resolve() if agent_dir else None
        self.pin = read_pin()
        self.loaded = False
        self.module_path: Path | None = None
        self.revision: str | None = None
        self.import_error: str | None = None
        self._lock = threading.Lock()
        self._handoff = None
        self._retired = False

    # ── loading ───────────────────────────────────────────────────────────
    def load(self) -> None:
        with self._lock:
            if self._retired:
                raise AgentRuntimeStale(None)
            if self.loaded:
                return
            try:
                # Direct Agent imports skip CLI startup's PM tool PATH activation.
                if self.agent_dir is not None and (self.agent_dir / "pm").is_dir():
                    compose_path = getattr(importlib.import_module("pm"), "store_first_path", None)
                    if compose_path is not None:
                        os.environ["PATH"] = compose_path(os.environ.get("PATH", ""))
                module = importlib.import_module("run_agent")
                getattr(module, "AIAgent")
                # Agent 0.21.3 snapshots its auth provider registry, discovered plugins included, when hermes_cli.auth
                # first imports. Take it here, under the launch profile and before any profile-scoped method runs, so
                # a named profile's plugin loaded later never enters that process-wide snapshot.
                importlib.import_module("hermes_cli.auth")
                _check_site_packages_python()
                try:
                    handoff = importlib.import_module("hermes_cli.guest_handoff")
                except ModuleNotFoundError as exc:
                    if exc.name != "hermes_cli.guest_handoff":
                        raise
                else:
                    # Retain custody even when startup raises after creating its thread.
                    if not callable(handoff.start_worker) or not callable(handoff.stop_worker):
                        raise RuntimeError("Native handoff lifecycle API is incomplete")
                    self._handoff = handoff
                    if not handoff.start_worker().is_alive():
                        raise RuntimeError("Native handoff worker did not start")
            except Exception as exc:  # noqa: BLE001 - reported as a handshake condition
                self._stop_handoff()
                self.import_error = f"{type(exc).__name__}: {exc}"
                raise AgentIncompatible(f"Hermes Agent could not be imported: {self.import_error}", import_error=self.import_error)
            module_file = getattr(module, "__file__", None)
            self.module_path = Path(module_file).resolve() if module_file else None
            if self.agent_dir is None and self.module_path is not None:
                self.agent_dir = self.module_path.parent
            self.revision = read_agent_revision(self.agent_dir, self.module_path)
            self.loaded = True
            try:
                from .talaria_toolset import register

                register()
            except Exception:  # noqa: BLE001 - the Agent stays usable without Talaria's own tools
                log.warning("talaria toolset registration failed", exc_info=True)

    def _stop_handoff(self) -> None:
        if self._handoff is not None:
            # Native requests are bounded. Join fully before code/dependencies may change.
            self._handoff.stop_worker(timeout=None)
            self._handoff = None

    def retire(self) -> None:
        """Release native background writes; only a fresh process may own them again."""
        with self._lock:
            if self._handoff is None:
                return
            self._retired = True
            self.loaded = False
            self._stop_handoff()

    @property
    def agent_version(self) -> str | None:
        try:
            return installed_agent_version()
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
        if live in {"unknown", "active"}:
            return live
        repair = self.web_repair_state()
        if repair == "unknown":
            return "unknown"
        recovery = repair == "present"
        for root in self._install_roots():
            for name in _AGENT_RECOVERY_MARKERS:
                presence = _marker_presence(root / name)
                if presence == "unknown":
                    return "unknown"
                recovery = recovery or presence == "present"
        if recovery:
            return "incomplete"
        return "unverified" if live == "absent" else live

    def web_repair_state(self) -> str:
        if self.agent_dir is None:
            return "absent"
        from .agent_mutation import recovery_receipts
        try:
            with self._stale_lock:
                receipts, _ = recovery_receipts(self, discovery_cache=self._receipt_discovery)
            return 'present' if receipts else 'absent'
        except (OSError, UnicodeError):
            return 'unknown'

    def is_stale(self) -> bool:
        """True when the checkout revision no longer matches the loaded module.

        The revision read spawns git, so it is memoised on the checkout's HEAD stamp (``.git/HEAD`` plus the ref it
        points at, both plain stat calls) across the worker pool, and a read that fails (timeout under load) is retried
        once before it counts as a change.
        """
        if not self.loaded or self.revision is None:
            return False
        with self._stale_lock:
            stamp = _head_stamp(self.agent_dir)
            if stamp is not None and stamp == self._stale_stamp:
                return self._stale
            fresh = None
            for _ in range(2):
                try:
                    fresh = read_agent_revision(self.agent_dir, self.module_path)
                except Exception:  # noqa: BLE001 - unreadable fails closed like a change
                    fresh = None
                if fresh is not None:
                    break
            self._source_changed = fresh is not None and fresh != self.revision
            self._stale = fresh != self.revision
            self._stale_stamp = stamp if fresh is not None else None
            stale = self._stale
        if stale:
            self.retire()
        return stale

    def ensure_current(self) -> None:
        """Refuse Agent work until source drift or a durable Web update obligation is reconciled."""
        repair = self.web_repair_state()
        if repair != "absent":
            self.retire()
            raise AgentRuntimeStale("unknown" if repair == "unknown" else self.update_transaction_state())
        if self.is_stale():
            raise AgentRuntimeStale(self.update_transaction_state(), source_changed=self._source_changed)

    # ── handshake ─────────────────────────────────────────────────────────
    def describe(self) -> dict:
        # The pin records official test coverage, not runtime capability. Each operation still checks its imports,
        # profile isolation and loaded-revision guard at the point of use.
        stale = self.is_stale() or self._retired
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
            "compatible": self.loaded,
            "stale": stale,
            "agent_source_changed": self._source_changed,
            "update_state": self.update_transaction_state(),
            "import_error": self.import_error,
        }
