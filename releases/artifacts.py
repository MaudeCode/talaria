#!/usr/bin/env python3
"""Integrity-checked handoffs on the single self-hosted release runner."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat

from cli import run_url


def context():
    run_url()
    runner, source = os.environ.get("RUNNER_NAME", ""), os.environ.get("GITHUB_SHA", "")
    if not runner or not re.fullmatch(r"[a-f0-9]{40}", source):
        raise ValueError("runner and workflow source identity are required")
    return {"run": os.environ["GITHUB_RUN_ID"], "attempt": os.environ["GITHUB_RUN_ATTEMPT"],
            "runner": runner, "source": source}


def location(identity, name):
    if not re.fullmatch(r"[a-z0-9-]+", name):
        raise ValueError("invalid artifact name")
    if not all(re.fullmatch(r"[1-9][0-9]*", identity[key]) for key in ("run", "attempt")):
        raise ValueError("invalid artifact run identity")
    return Path.home() / ".local/share/talaria-release-runs" / identity["run"] / identity["attempt"] / name


def digest(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("artifact must be a real directory")
    result = hashlib.sha256()
    paths = sorted(directory.rglob("*"))
    if not paths:
        raise ValueError("artifact is empty")
    for path in paths:
        mode = path.lstat().st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode)):
            raise ValueError("unsupported artifact file type")
        if not path.resolve().is_relative_to(directory.resolve()):
            raise ValueError("artifact link escapes its directory")
        result.update(json.dumps([path.relative_to(directory).as_posix(), mode,
                                  path.lstat().st_size if stat.S_ISREG(mode) else None]).encode() + b"\n")
        if path.is_symlink():
            result.update(os.readlink(path).encode() + b"\n")
        elif path.is_file():
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    result.update(chunk)
    return result.hexdigest()


def put(name, source):
    identity = context()
    expected = digest(source)
    destination = location(identity, name)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination.parent.chmod(0o700)
    shutil.copytree(source, destination, symlinks=True)
    if digest(destination) != expected:
        raise ValueError("artifact changed while being stored")
    return {**identity, "name": name, "sha256": expected}


def get(reference, destination):
    current = context()
    if any(reference.get(key) != current[key] for key in ("run", "runner", "source")):
        raise ValueError("artifact belongs to a different run, runner or workflow source")
    if int(reference["attempt"]) > int(current["attempt"]):
        raise ValueError("artifact belongs to a future attempt")
    source = location(reference, reference["name"])
    if digest(source) != reference["sha256"]:
        raise ValueError("stored artifact digest differs from the producer job output")
    shutil.copytree(source, destination, symlinks=True)
    if digest(destination) != reference["sha256"]:
        raise ValueError("artifact changed while being restored")


def references():
    result = json.loads(os.environ.get("RELEASE_ARTIFACTS", "{}"))
    for job in json.loads(os.environ.get("RELEASE_NEEDS", "{}")).values():
        for name, reference in json.loads(job.get("outputs", {}).get("artifacts") or "{}").items():
            if name in result and result[name] != reference:
                raise ValueError("conflicting artifact producers")
            result[name] = reference
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("put", "get", "forward", "clean"))
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args()
    if args.operation == "put":
        if not args.paths or len(args.paths) % 2:
            parser.error("put requires NAME DIRECTORY pairs")
        result = {name: put(name, Path(source)) for name, source in zip(args.paths[::2], args.paths[1::2])}
    elif args.operation == "get":
        if not args.paths:
            parser.error("get requires DESTINATION and optional artifact names")
        available = references()
        names = args.paths[1:] or list(available)
        if not names:
            raise ValueError("no producer outputs supplied")
        for name in names:
            get(available[name], Path(args.paths[0]) / name)
        return
    elif args.operation == "clean":
        # Successful final jobs retain their manifest and small diagnostics;
        # failed runs retain all handoffs for inspection or same-run retries.
        identity = context()
        directory = location(identity, "unused").parent.parent
        for attempt in directory.iterdir():
            if attempt.is_symlink() or not re.fullmatch(r"[1-9][0-9]*", attempt.name):
                raise ValueError("invalid stored attempt directory")
            for path in attempt.iterdir():
                if path.name not in args.paths:
                    shutil.rmtree(path)
        return
    else:
        result = references()
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.write("artifacts=" + json.dumps(result, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
