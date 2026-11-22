"""``backup.*``: a full native Agent-home backup through ``hermes backup`` (TAL-2661).

The Agent owns everything about the archive: its lock, SQLite snapshots, collectors and owner-only atomic staging. This
module only runs the CLI as a child for the root home, into a private directory the Web server created, reports its
progress lines, and terminates it on cancellation (the CLI unwinds its own staging on SIGTERM).
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import threading
from pathlib import Path

from ..errors import InvalidParams
from ..home import profile_home_param
from ..rpc import CallContext
from .gateway import _ANSI, _child_env, _drain, _hermes_command, _profile_selector
from .profiles import _bounded

_TOTAL = re.compile(r"^Backing up (\d+) files")
_DONE = re.compile(r"^(\d+)/(\d+) files")
_BUSY = "another Hermes backup is already running"


def _output_path(raw: object) -> Path:
    """The archive path: a new ``.zip`` in an existing owner-only directory of this user. The default Web state directory
    lies inside the Agent home; the command never archives its own output or staging."""
    if not isinstance(raw, str) or not raw.endswith(".zip") or not os.path.isabs(raw):
        raise InvalidParams("output must be an absolute .zip path")
    out = Path(raw)
    try:
        parent = out.parent.lstat()
    except OSError as exc:
        raise InvalidParams("output directory must exist") from exc
    if not stat.S_ISDIR(parent.st_mode):
        raise InvalidParams("output directory must exist")
    # POSIX modes and owners only; Windows has neither, and its directory keeps the state directory's ACL.
    if os.name != "nt" and (parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) & 0o077):
        raise InvalidParams("output directory must be a private directory owned by the sidecar user")
    if os.path.lexists(out):
        raise InvalidParams("output already exists")
    return out


def _reason(stdout: str, stderr: str) -> str | None:
    """The CLI's own error line (``Error: …`` or ``✗ …``), else the last line it wrote to stderr; bounded and colourless."""
    def lines(text: str) -> list[str]:
        return [line.strip() for line in _ANSI.sub("", text).splitlines() if line.strip()]

    every = lines(f"{stdout}\n{stderr}")
    first = next((line for line in every if line.startswith(("Error:", "✗"))), None)
    if first is None:
        tail = lines(stderr)
        first = tail[-1] if tail else ""
    return _bounded(first.removeprefix("Error:").lstrip("✗ ").strip(), 300) or None


def create(home: Path, out: Path, ctx: CallContext) -> dict:
    try:
        profile = _profile_selector(home)
    except ImportError:
        return {"status": "failed", "reason": "The installed Hermes Agent cannot name the profile at this home."}
    if profile != "default":
        raise InvalidParams("an Agent-home backup runs only for the root profile")
    cmd = [_hermes_command(), "--profile", profile, "backup", "--output", str(out), "--keep", "0"]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=_child_env(home, profile, "backup"))
    except FileNotFoundError:
        return {"status": "failed", "reason": "Hermes CLI not found"}
    out_lines: list[str] = []
    err: list[str] = []

    def read_stdout() -> None:
        try:
            for line in proc.stdout:
                out_lines.append(line)
                text = _ANSI.sub("", line).strip()
                if text.startswith("Scanning "):
                    ctx.emit("progress", {"phase": "scanning"})
                elif match := _TOTAL.match(text):
                    ctx.emit("progress", {"phase": "archiving", "completed": 0, "total": int(match[1])})
                elif match := _DONE.match(text):
                    ctx.emit("progress", {"phase": "archiving", "completed": int(match[1]), "total": int(match[2])})
        except (OSError, ValueError):
            pass

    readers = [threading.Thread(target=read_stdout, daemon=True), threading.Thread(target=_drain, args=(proc.stderr, err), daemon=True)]
    for reader in readers:
        reader.start()
    while proc.poll() is None:
        if ctx.cancelled:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            break
        ctx.cancel_event.wait(0.1)
    for reader in readers:
        reader.join(timeout=5)
    stdout, stderr = "".join(out_lines), "".join(err)
    if ctx.cancelled:
        return {"status": "cancelled"}
    reason = _reason(stdout, stderr)
    if proc.returncode == 2 and reason and _BUSY in reason:
        return {"status": "busy", "reason": reason, "returncode": 2}
    archived = out.is_file() and not out.is_symlink()
    if archived:
        # The archive carries every profile's credentials, and the Agent publishes it with umask bits (0644).
        out.chmod(0o600)
    if proc.returncode == 0 and archived:
        return {"status": "completed", "size_bytes": out.stat().st_size, "returncode": 0}
    if proc.returncode == 1 and archived:
        # The CLI keeps an incomplete archive so the rest can still be restored (``run_backup`` returned False).
        return {"status": "incomplete", "size_bytes": out.stat().st_size, "returncode": 1}
    if proc.returncode == 0:
        return {"status": "failed", "reason": "The Agent found no files to back up.", "returncode": 0}
    return {"status": "failed", "reason": reason or f"hermes backup exited with code {proc.returncode}", "returncode": proc.returncode}


def register(registry) -> None:
    @registry.method("backup.create")
    def create_(ctx: CallContext, params: dict) -> dict:
        home = profile_home_param(params)
        if params.get("scope") != "agent_home":
            raise InvalidParams("scope must be agent_home: the native backup includes every profile")
        if home.parent.name == "profiles":
            raise InvalidParams("an Agent-home backup runs only for the root profile")
        return create(home, _output_path(params.get("output")), ctx)
