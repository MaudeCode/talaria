#!/usr/bin/env python3
"""Digest-checked release handoffs carried between runners through the NAS object store.

``put`` archives a directory as ``$RUNNER_TEMP/release-handoffs/<run>/<attempt>/<name>.tar``, uploads it as
``handoffs/<workflow>/<run>/<attempt>/<name>.tar`` through ``scripts/s3-artifact`` and records its digest in
the job outputs. ``get`` downloads only archives named by forwarded producer outputs whose run, source and
digest match; the calling workflow's file name namespaces every key, so a job addresses only its own run.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile

from cli import ROOT, run_url

HELPER = ROOT / "scripts/s3-artifact"


def context():
    run_url()
    source = os.environ.get("GITHUB_SHA", "")
    if not re.fullmatch(r"[a-f0-9]{40}", source):
        raise ValueError("workflow source identity is required")
    return {"run": os.environ["GITHUB_RUN_ID"], "attempt": os.environ["GITHUB_RUN_ATTEMPT"], "source": source}


def staged():
    return Path(os.environ["RUNNER_TEMP"]) / "release-handoffs"


def downloaded():
    return Path(os.environ["RUNNER_TEMP"]) / "release-handoffs-in"


def namespace():
    """The calling workflow's file name; reusable workflows share their caller's run and namespace."""
    match = re.fullmatch(r"[^@]+/\.github/workflows/([a-z0-9-]+)\.ya?ml@.+", os.environ.get("GITHUB_WORKFLOW_REF", ""))
    if not match:
        raise ValueError("workflow identity is required for the handoff namespace")
    return match.group(1)


def key(reference, workflow):
    archive(Path("."), reference)  # validates name, run and attempt
    return f"handoffs/{workflow}/{reference['run']}/{reference['attempt']}/{reference['name']}.tar"


def transfer(operation, object_key, path):
    try:
        subprocess.run([str(HELPER), operation, object_key, str(path)], check=True)
    except subprocess.CalledProcessError as error:
        raise ValueError(f"NAS {operation} of {object_key} failed with status {error.returncode}") from error


def archive(root, reference):
    if not re.fullmatch(r"[a-z0-9-]+", str(reference.get("name", ""))):
        raise ValueError("invalid artifact name")
    if not all(re.fullmatch(r"[1-9][0-9]*", str(reference.get(key, ""))) for key in ("run", "attempt")):
        raise ValueError("invalid artifact run identity")
    return root / reference["run"] / reference["attempt"] / (reference["name"] + ".tar")


def digest(directory):
    """Tree digest that also rejects empty, escaping or special-file handoff sources."""
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


def file_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def put(name, source):
    reference = {**context(), "name": name}
    digest(source)
    destination = archive(staged(), reference)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(destination, "x") as stream:
        stream.add(source, arcname=".")
    transfer("put", key(reference, namespace()), destination)
    return {**reference, "sha256": file_digest(destination)}


def stored(reference, workflow=None):
    """Download a producer reference's archive and verify it against the digest that job recorded."""
    if not re.fullmatch(r"[a-f0-9]{64}", str(reference.get("sha256", ""))):
        raise ValueError("invalid artifact digest")
    path = archive(downloaded(), reference)
    path.unlink(missing_ok=True)  # every restore fetches the object again; nothing on a runner is trusted
    transfer("get", key(reference, workflow or namespace()), path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("handoff artifact was not downloaded for this reference")
    if file_digest(path) != reference["sha256"]:
        raise ValueError("downloaded artifact digest differs from the producer job output")
    return path


def restore(reference, destination, workflow=None):
    path = stored(reference, workflow)
    destination = Path(destination)
    if destination.exists():
        raise FileExistsError(destination)
    try:
        with tarfile.open(path) as stream:
            stream.extractall(destination, filter="data")
    except tarfile.TarError as error:
        raise ValueError(f"handoff archive is not a plain directory tree: {error}") from error


def get(reference, destination):
    current = context()
    if any(reference.get(key) != current[key] for key in ("run", "source")):
        raise ValueError("artifact belongs to a different run or workflow source")
    if not re.fullmatch(r"[1-9][0-9]*", str(reference.get("attempt", ""))) or int(reference["attempt"]) > int(current["attempt"]):
        raise ValueError("artifact belongs to a future or invalid attempt")
    restore(reference, destination)


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
    parser.add_argument("operation", choices=("put", "get", "forward"))
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
    else:
        result = references()
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.write("artifacts=" + json.dumps(result, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
