"""Restore a local archive through Hermes without running its CLI's service hooks."""

from __future__ import annotations

import contextlib
import ctypes
import json
import os
import platform
import stat
import sys
import tempfile
import zipfile
from pathlib import Path
from types import SimpleNamespace

from .agent_imports import _directory, _parent, _write

MAX_ARCHIVE_BYTES = 1024 ** 3
_MAX_EXPANDED_BYTES = 8 * MAX_ARCHIVE_BYTES
_MAX_FILES = 100_000
_RUNTIME_ROOTS = {"webui", "hermes-agent", "backups", "state-snapshots"}
_RUNTIME_NAMES = {".backup.lock", "gateway.lock", "gateway.pid", "cron.pid"}
_LANDLOCK_ARCHES = {"x86_64", "aarch64"}
_LANDLOCK_CREATE_RULESET = 444
_LANDLOCK_ADD_RULE = 445
_LANDLOCK_RESTRICT_SELF = 446


class InvalidArchive(ValueError):
    pass


def _native():
    from gateway.runtime_ownership import OwnershipConflict, exclusive_maintenance
    from hermes_cli import backup
    from hermes_cli.archive_safe import normalize_archive_parts
    from hermes_constants import get_default_hermes_root
    from hermes_cli.backup_restore import _safe_restore_db

    return SimpleNamespace(backup=backup, root=get_default_hermes_root, normalize=normalize_archive_parts, sqlite_restore=_safe_restore_db,
                           sqlite_check=backup.verify_sqlite_integrity, conflict=OwnershipConflict, maintenance=exclusive_maintenance)


def supported() -> bool:
    if not hasattr(os, "O_NOFOLLOW") or os.open not in os.supports_dir_fd:
        return False
    try:
        native = _native()
        for name in ("_validate_backup_zip", "_detect_prefix", "_import_member_rel", "_find_corrupt_members", "_import_members", "run_backup"):
            if not callable(getattr(native.backup, name, None)):
                return False
    except (AttributeError, ImportError):
        return False
    if sys.platform == "darwin":
        return os.access("/usr/bin/sandbox-exec", os.X_OK)
    return sys.platform == "linux" and platform.machine() in _LANDLOCK_ARCHES and _landlock_abi() >= 3


def _landlock_abi() -> int:
    return ctypes.CDLL(None, use_errno=True).syscall(_LANDLOCK_CREATE_RULESET, 0, 0, 1)


def _restrict_linux(roots: tuple[Path, ...]) -> None:
    """Deny data-changing filesystem operations outside these directories, including SQLite's path-based opens."""
    libc = ctypes.CDLL(None, use_errno=True)
    write_access = sum(1 << bit for bit in (1, *range(4, 15)))

    class Beneath(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("access", ctypes.c_uint64), ("fd", ctypes.c_int)]

    ruleset = libc.syscall(_LANDLOCK_CREATE_RULESET, ctypes.byref(ctypes.c_uint64(write_access)), 8, 0)
    if ruleset < 0:
        raise OSError("Restore confinement is unavailable")
    try:
        for root in roots:
            with _directory(root) as fd:
                if libc.syscall(_LANDLOCK_ADD_RULE, ruleset, 1, ctypes.byref(Beneath(write_access, fd)), 0) != 0:
                    raise OSError("Restore confinement could not bind the selected home")
        if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.syscall(_LANDLOCK_RESTRICT_SELF, ruleset, 0) != 0:
            raise OSError("Restore confinement could not be established")
    finally:
        os.close(ruleset)


def command(home: Path, incoming: Path, output: Path, state_dir: Path) -> list[str]:
    cmd = [sys.executable, "-B", "-m", "talaria_sidecar.methods.backup_restore", str(home), str(incoming), str(output), str(state_dir)]
    if sys.platform != "darwin":
        return cmd
    roots = " ".join(f"(subpath {json.dumps(str(path), ensure_ascii=False)})" for path in (home, output.parent))
    policy = f'(version 1) (allow default) (deny file-write*) (allow file-write* {roots} (literal "/dev/null"))'
    return ["/usr/bin/sandbox-exec", "-p", policy, *cmd]


def _members(native, archive: zipfile.ZipFile, state_parts: tuple[str, ...] | None) -> tuple[str, list[str], list[Path]]:
    entries = archive.infolist()
    if len(entries) > _MAX_FILES or sum(info.file_size for info in entries) > _MAX_EXPANDED_BYTES:
        raise InvalidArchive("archive limits exceeded")
    if not native.backup._validate_backup_zip(archive)[0]:
        raise InvalidArchive("invalid Hermes backup")
    prefix = native.backup._detect_prefix(archive)
    members = []
    paths = []
    seen = set()
    for info in entries:
        # The native external collector maps these outside HERMES_HOME.
        original = native.normalize(info.orig_filename.rstrip("/"))
        mode = stat.S_IFMT(info.external_attr >> 16)
        if not original or original[0].casefold() == "_external" or mode not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise InvalidArchive("archive contains external or special files")
        if info.is_dir():
            continue
        relative, skip = native.backup._import_member_rel(info.filename, prefix)
        parts = native.normalize(relative)
        key = tuple(part.casefold() for part in parts)
        if key[0] == "_external":
            raise InvalidArchive("archive contains external files")
        if (skip or key[0] in _RUNTIME_ROOTS or key[-1] in _RUNTIME_NAMES
                or (state_parts is not None and key[:len(state_parts)] == state_parts)):
            continue
        if key in seen:
            raise InvalidArchive("archive contains duplicate files")
        seen.add(key)
        paths.append(Path(*parts))
        members.append(info.filename)
    if not members or native.backup._find_corrupt_members(archive, members):
        raise InvalidArchive("invalid or corrupt Hermes backup")
    return prefix, members, sorted(paths)


def _preflight(root_fd: int, path: Path) -> None:
    def leaf(fd: int, name: str) -> None:
        try:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise OSError("unsafe destination")

    try:
        with _parent(root_fd, str(path)) as (fd, name):
            leaf(fd, name)
            if path.suffix == ".db":
                for suffix in ("-wal", "-shm", "-journal"):
                    leaf(fd, name + suffix)
    except FileNotFoundError:
        pass


def _restore(home: Path, incoming: Path, output: Path, state_dir: Path) -> dict:
    native = _native()
    if native.root().resolve() != home or state_dir == home:
        return {"status": "refused"}
    publishing = False
    state_parts = tuple(part.casefold() for part in state_dir.relative_to(home).parts) if state_dir.is_relative_to(home) else None
    try:
        if sys.platform == "linux":
            _restrict_linux((home, output.parent))
        with tempfile.TemporaryDirectory(dir=output.parent, prefix="restore-") as scratch:
            stage = Path(scratch)
            with zipfile.ZipFile(incoming) as archive:
                prefix, members, paths = _members(native, archive, state_parts)
                if native.backup._import_members(archive, members, prefix, stage, len(members))[2]:
                    return {"status": "invalid_archive"}
            for path in paths:
                if path.suffix == ".db" and not native.sqlite_check(stage / path)["valid"]:
                    return {"status": "invalid_archive"}
            homes = {home}
            for path in paths:
                if path.parts[0].casefold() == "profiles" and len(path.parts) > 2:
                    homes.add(home.joinpath(*path.parts[:2]))
                if path.suffix == ".db":
                    homes.add(home / path.parent)
            with _directory(home) as root_fd:
                for path in paths:
                    _preflight(root_fd, path)
                with native.maintenance(homes, purpose="talaria-restore"):
                    for path in paths:
                        _preflight(root_fd, path)
                    # The worker's input and scratch are kept under the Web cache. Publish only a complete backup.
                    recovery = stage / "pre-restore.zip"
                    if not native.backup.run_backup(SimpleNamespace(output=str(recovery), keep=0)) or not recovery.is_file():
                        return {"status": "backup_failed"}
                    recovery.chmod(0o600)
                    recovery.rename(output)
                    publishing = True
                    for path in paths:
                        _preflight(root_fd, path)
                        if path.suffix == ".db" and (home / path).exists():
                            if not native.sqlite_restore(stage / path, home / path):
                                return {"status": "partial"}
                        else:
                            with (stage / path).open("rb") as source:
                                _write(root_fd, str(path), source, mode=(stage / path).stat().st_mode)
                    return {"status": "restored"}
    except native.conflict:
        return {"status": "partial" if publishing else "busy"}
    except (zipfile.BadZipFile, RuntimeError, ValueError):
        return {"status": "partial" if publishing else "invalid_archive"}
    except (OSError, SystemExit):
        return {"status": "partial" if publishing else "refused"}


def _main() -> None:
    reply = sys.stdout
    home, incoming, output, state_dir = map(Path, sys.argv[1:])
    os.umask(0o077)
    with open(os.devnull, "w") as discard, contextlib.redirect_stdout(discard), contextlib.redirect_stderr(discard):
        result = _restore(home, incoming, output, state_dir)
        with _directory(output.parent) as fd:
            _write(fd, "result.json", json.dumps(result).encode())
    print(json.dumps(result), file=reply)


if __name__ == "__main__":
    _main()
