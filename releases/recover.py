#!/usr/bin/env python3
"""Recover retained handoffs from a failed, authenticated production cutover."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess

import artifacts
from cli import REPOSITORY, ROOT, load
from plan import git
from publish import require_current_predecessor


def api(path):
    # Job logs contain ANSI bytes. Capture them for parsing, never terminal output.
    flags = ["--allow-escape-sequences"] if path.endswith("/logs") else []
    return subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}/{path}", *flags], text=True)


def authenticate(run, attempt, metadata, jobs, log):
    expected = {"id": int(run), "run_attempt": int(attempt), "event": "workflow_dispatch",
                "head_branch": "main", "path": ".github/workflows/production-cutover.yml",
                "status": "completed", "conclusion": "failure"}
    if (any(metadata.get(key) != value for key, value in expected.items())
            or any(metadata.get(key, {}).get("full_name") != REPOSITORY for key in ("repository", "head_repository"))
            or not re.fullmatch(r"[a-f0-9]{40}", metadata.get("head_sha", ""))):
        raise ValueError("recovery requires a failed main-branch production cutover")
    for name, conclusion in (("prepare", "success"), ("build-gate", "success"), ("relay-publish", "success"),
                             ("web-publish", "success"), ("Publish iOS app", "failure"), ("publish-set", "failure")):
        matching = [job for job in jobs if job["name"] == "release / " + name]
        if (len(matching) != 1 or matching[0].get("conclusion") != conclusion
                or matching[0].get("run_attempt") != int(attempt) or matching[0].get("run_id") != int(run)):
            raise ValueError("original cutover jobs do not authorize App-only recovery")
    # This is the runner's env dump from the failed publication gate, fetched
    # from GitHub's job-log endpoint, never caller-supplied artifact references.
    marker = "RELEASE_NEEDS: "
    records = [json.JSONDecoder().raw_decode(value)[0] for value in log.split(marker)[1:]]
    if not records or any(value != records[0] for value in records):
        raise ValueError("missing or conflicting original publication inputs")
    needs = records[0]
    if set(needs) != {"prepare", "build-gate", "relay-publish", "web-publish", "app-publish"}:
        raise ValueError("unexpected original publication dependencies")
    references = {}
    for name, job in needs.items():
        if job.get("result") != ("failure" if name == "app-publish" else "success"):
            raise ValueError("original prerequisite did not pass")
        for key, reference in json.loads(job.get("outputs", {}).get("artifacts") or "{}").items():
            if key in references and references[key] != reference:
                raise ValueError("conflicting original artifact producers")
            if (reference.get("name") != key or reference.get("run") != run
                    or reference.get("source") != metadata["head_sha"]
                    or not re.fullmatch(r"[1-9][0-9]*", reference.get("attempt", ""))
                    or int(reference["attempt"]) > int(attempt)
                    or not re.fullmatch(r"[a-f0-9]{64}", reference.get("sha256", ""))):
                raise ValueError("original artifact identity differs from its run")
            references[key] = reference
    # Recovery republishes only the App; the Web OCI image is authenticated above but never restored.
    references.pop("web-image", None)
    required = {"release-plan", "contract-receipts", "previous-app-receipts", "agent-receipts", "relay-build", "web-build",
                "app-build", "ios-ipa", "ios-dsyms", "relay-publish", "web-publish"}
    outputs = needs["prepare"]["outputs"]
    if (set(references) != required or any(outputs.get(name + "_changed") != "true" for name in ("app", "web", "relay"))
            or not re.fullmatch(r"[a-f0-9]{40}", outputs.get("source", ""))):
        raise ValueError("recovery requires the complete original three-component build")
    return outputs["source"], references


def restore(references, destination):
    # The authenticated original run's archives are checked against every producer digest before any is extracted.
    try:
        paths = artifacts.stored(*references.values())
    except ValueError as error:
        raise ValueError("retained handoff differs from its original producer") from error
    for name, path in zip(references, paths):
        artifacts.extract(path, destination / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run")
    parser.add_argument("attempt")
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    if (not all(re.fullmatch(r"[1-9][0-9]*", value) for value in (args.run, args.attempt))
            or args.run == os.environ.get("GITHUB_RUN_ID")
            or os.environ.get("GITHUB_REF") != "refs/heads/main"
            or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or os.environ.get("GITHUB_WORKFLOW_REF") != f"{REPOSITORY}/.github/workflows/recover-cutover.yml@refs/heads/main"):
        raise ValueError("recovery requires the trusted main workflow and an earlier run")
    path = f"actions/runs/{args.run}/attempts/{args.attempt}"
    metadata = json.loads(api(path))
    jobs = json.loads(api(path + "/jobs?per_page=100"))
    if jobs["total_count"] != len(jobs["jobs"]):
        raise ValueError("original job inventory is incomplete")
    final = [job for job in jobs["jobs"] if job["name"] == "release / publish-set"]
    if len(final) != 1:
        raise ValueError("missing original publication gate")
    log = api(f"actions/jobs/{int(final[0]['id'])}/logs")
    source, references = authenticate(args.run, args.attempt, metadata, jobs["jobs"], log)
    for revision in (metadata["head_sha"], source):
        git(ROOT, "merge-base", "--is-ancestor", revision, os.environ["GITHUB_SHA"])
    restore(references, args.destination)
    plan = load(args.destination / "release-plan/plan.json")
    if plan.get("dryRun") is not False or plan.get("releaseSet") != source:
        raise ValueError("retained plan differs from the approved source")
    previous = args.destination / "release-plan/previous.json"
    require_current_predecessor(plan, load(previous) if previous.exists() else None)
    with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
        stream.write(f"source={source}\n")
    print(f"Recovered verified handoffs from run {args.run}, attempt {args.attempt}, source {source}")


if __name__ == "__main__":
    main()
