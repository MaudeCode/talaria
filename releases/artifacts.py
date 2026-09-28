#!/usr/bin/env python3
"""Digest-checked release handoffs carried between jobs as GitHub Actions artifacts.

``put`` archives each directory as ``<name>.tar`` in ``$RUNNER_TEMP/release-handoffs/<artifact>/``, records
its SHA-256 with the run, attempt and workflow source in the job outputs, and names the artifact
``handoffs_<run>_<attempt>_<name>[.<name>...]`` in the ``handoff_name``/``handoff_path`` step outputs; the
workflow's next step uploads that directory with ``actions/upload-artifact`` (a run step cannot reach the
artifact service). A job's later ``put`` outputs every reference the job staged, so large payloads can travel
as separate artifacts that consumers download only when they need them. ``get`` accepts only forwarded producer outputs of its own run, source and a current or
earlier attempt, finds the artifact of that run and attempt holding the name through the REST API, downloads it
with ``gh run download`` and checks the archive against the recorded digest before extracting it.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile

from cli import REPOSITORY, run_url


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


def validate(reference):
    if not re.fullmatch(r"[a-z0-9-]+", str(reference.get("name", ""))):
        raise ValueError("invalid artifact name")
    if not all(re.fullmatch(r"[1-9][0-9]*", str(reference.get(key, ""))) for key in ("run", "attempt")):
        raise ValueError("invalid artifact run identity")


def prefix(reference):
    validate(reference)
    return f"handoffs_{reference['run']}_{reference['attempt']}_"


def listing(run):
    """This repository's artifacts of one workflow run, through the job token."""
    try:
        output = subprocess.check_output(["gh", "api", "--paginate", f"repos/{REPOSITORY}/actions/runs/{run}/artifacts?per_page=100",
                                          "--jq", ".artifacts[]"], text=True)
    except subprocess.CalledProcessError as error:
        raise ValueError(f"listing the artifacts of run {run} failed with status {error.returncode}") from error
    return [json.loads(line) for line in output.splitlines() if line.strip()]


def download(run, artifact, directory):
    try:
        subprocess.run(["gh", "run", "download", str(run), "--repo", REPOSITORY, "--name", artifact, "--dir", str(directory)], check=True)
    except subprocess.CalledProcessError as error:
        raise ValueError(f"downloading artifact {artifact} failed with status {error.returncode}") from error


def locate(reference):
    """The one unexpired artifact of the reference's run and attempt that holds its name."""
    start = prefix(reference)
    matches = [item for item in listing(reference["run"])
               if str(item.get("name", "")).startswith(start)
               and reference["name"] in item["name"][len(start):].split(".")]
    if len(matches) != 1:
        raise ValueError(f"handoff {reference['name']} of run {reference['run']} attempt {reference['attempt']} is missing or ambiguous")
    item = matches[0]
    run = item.get("workflow_run") or {}
    if item.get("expired") is not False or str(run.get("id")) != reference["run"] or run.get("head_sha") != reference.get("source"):
        raise ValueError("handoff artifact is expired or belongs to a different run or workflow source")
    return item["name"]


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


def put(pairs):
    """Stage NAME/DIRECTORY pairs as one artifact; returns its references, name and directory."""
    current = context()
    references = [{**current, "name": name} for name, _ in pairs]
    for reference in references:
        validate(reference)
        if list(staged().glob(f"{prefix(reference)}*/{reference['name']}.tar")):
            raise FileExistsError(reference["name"])
    for _, source in pairs:
        digest(source)
    artifact = prefix(references[0]) + ".".join(reference["name"] for reference in references)
    directory = staged() / artifact
    directory.mkdir(parents=True)
    result = {}
    for reference, (_, source) in zip(references, pairs):
        path = directory / (reference["name"] + ".tar")
        with tarfile.open(path, "x") as stream:
            stream.add(source, arcname=".")
        result[reference["name"]] = {**reference, "sha256": file_digest(path)}
    return result, artifact, directory


def stored(*references):
    """Download each distinct artifact once and verify every reference against the digest its producer recorded."""
    fetched, paths = set(), []
    for reference in references:
        if not re.fullmatch(r"[a-f0-9]{64}", str(reference.get("sha256", ""))):
            raise ValueError("invalid artifact digest")
        artifact = locate(reference)
        directory = downloaded() / artifact
        if artifact not in fetched:
            shutil.rmtree(directory, ignore_errors=True)  # every restore fetches again; nothing on a runner is trusted
            download(reference["run"], artifact, directory)
            fetched.add(artifact)
        path = directory / (reference["name"] + ".tar")
        if path.is_symlink() or not path.is_file():
            raise ValueError("handoff artifact was not downloaded for this reference")
        if file_digest(path) != reference["sha256"]:
            raise ValueError("downloaded artifact digest differs from the producer job output")
        paths.append(path)
    return paths


def extract(path, destination):
    """Unpack an archive that stored() has just downloaded and verified."""
    destination = Path(destination)
    if destination.exists():
        raise FileExistsError(destination)
    try:
        with tarfile.open(path) as stream:
            stream.extractall(destination, filter="data")
    except tarfile.TarError as error:
        raise ValueError(f"handoff archive is not a plain directory tree: {error}") from error


def get(references, destination):
    """Restore forwarded references of this run into DESTINATION/<name> once every one is verified."""
    current = context()
    for name, reference in references.items():
        if reference.get("name") != name:
            raise ValueError(f"forwarded output {name} names another handoff")
        if any(reference.get(key) != current[key] for key in ("run", "source")):
            raise ValueError("artifact belongs to a different run or workflow source")
        if not re.fullmatch(r"[1-9][0-9]*", str(reference.get("attempt", ""))) or int(reference["attempt"]) > int(current["attempt"]):
            raise ValueError("artifact belongs to a future or invalid attempt")
    for name, path in zip(references, stored(*references.values())):
        extract(path, Path(destination) / name)


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
    parser.add_argument("--receipts", action="store_true",
                        help="get only the forwarded handoffs release assembly reads, never the image or iOS payloads")
    args = parser.parse_args()
    outputs = {}
    if args.operation == "put":
        if not args.paths or len(args.paths) % 2:
            parser.error("put requires NAME DIRECTORY pairs")
        result, artifact, directory = put([(name, Path(source)) for name, source in zip(args.paths[::2], args.paths[1::2])])
        outputs = {"handoff_name": artifact, "handoff_path": str(directory)}
        # Each put is its own artifact (and upload step); the job's last put reports every handoff it staged.
        ledger = staged() / "references.json"
        result = {**(json.loads(ledger.read_text()) if ledger.exists() else {}), **result}
        ledger.write_text(json.dumps(result))
    elif args.operation == "get":
        if not args.paths:
            parser.error("get requires DESTINATION and optional artifact names")
        available = references()
        if args.receipts:
            from collect import HANDOFFS
            names = [name for name in HANDOFFS if name in available]
        else:
            names = args.paths[1:] or list(available)
        if not names:
            raise ValueError("no producer outputs supplied")
        get({name: available[name] for name in names}, args.paths[0])
        return
    else:
        result = references()
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.write("artifacts=" + json.dumps(result, separators=(",", ":")) + "\n")
        for key, value in outputs.items():
            stream.write(f"{key}={value}\n")


if __name__ == "__main__":
    main()
