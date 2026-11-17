#!/usr/bin/env python3
"""Release workflow commands. Publication credentials are never needed here."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

from plan import ROOT_TAG, VERSION, assemble, git, resolve, validate_request
from release_set import COMPONENTS, VALIDATOR, require_version_advance

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "MaudeCode/talaria"


def load(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        stream.write(json.dumps(value, indent=2) + "\n")


def run_url():
    run = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if (os.environ.get("GITHUB_REPOSITORY") != REPOSITORY or not re.fullmatch(r"[1-9][0-9]*", run)
            or not re.fullmatch(r"[1-9][0-9]*", attempt)):
        raise ValueError("workflow receipts require the actual Talaria Actions run context")
    return f"https://github.com/{REPOSITORY}/actions/runs/{run}/attempts/{attempt}"


def receipt(gate, source, **extra):
    return {"gate": gate, "sourceRevision": source, "runUrl": run_url(), "result": "success", **extra}


def unused_release(tag):
    result = subprocess.run(["gh", "api", "--include", f"repos/{REPOSITORY}/releases/tags/{tag}"], capture_output=True, text=True, check=False)
    if result.returncode == 0:
        raise ValueError(f"release {tag} already exists; inspect the prior publication before proceeding")
    statuses = re.findall(r"^HTTP/[\d.]+\s+(\d+)", result.stdout, re.MULTILINE)
    if not statuses or statuses[-1] != "404":
        raise ValueError("could not verify release-name availability")


def published_manifest(release):
    tag = release.get("tag_name", "")
    if (not re.fullmatch(r"release-set-[a-f0-9]{40}", tag)
            or release.get("draft") is not False or not release.get("published_at")):
        raise ValueError("previous release set has not been published")
    assets = [item for item in release.get("assets", []) if item.get("name") == "release-set.json"]
    if len(assets) != 1 or type(assets[0].get("id")) is not int:
        raise ValueError("previous release set lacks its manifest")
    document = json.loads(subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}/releases/assets/{assets[0]['id']}", "-H", "Accept: application/octet-stream"]))
    VALIDATOR.validate(document)
    if document["status"] != "complete" or document["releaseSet"] != tag.removeprefix("release-set-"):
        raise ValueError("previous release identity is inconsistent")
    return document


def published_set(source):
    """The completed manifest published as release-set-<source>."""
    if not re.fullmatch(r"[a-f0-9]{40}", source):
        raise ValueError("a release set must be an immutable commit")
    tag = "release-set-" + source
    release = json.loads(subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}/releases/tags/{tag}"]))
    if release.get("tag_name") != tag:
        raise ValueError("release set identity is inconsistent")
    return published_manifest(release)


def previous(args):
    write(args.output, published_set(args.source))


def supported_web_sources(plan, previous, published):
    """Keep the latest completed Web release in each published channel usable.

    Without a plan, only lists them: CI probes each with its own harness, as a release's contract gate does (TAL-2345)."""
    retained = {}
    for release in sorted(published, key=lambda item: item["published_at"], reverse=True):
        if len(retained) == 2:
            break
        if not re.fullmatch(r"release-set-[a-f0-9]{40}", release.get("tag_name", "")):
            continue
        document = (previous if previous and release["tag_name"] == "release-set-" + previous["releaseSet"]
                    else published_manifest(release))
        channel = document["components"]["web"]["tag"].rsplit("-v", 1)[0]
        if channel in retained:
            continue
        for contract, consumer in (("appWeb", "app"), ("webRelay", "relay")) if plan else ():
            if not set(document["contracts"][contract]["web"]) & set(plan["contracts"][contract][consumer]):
                raise ValueError(f"retained {channel} is incompatible with {contract}")
        retained[channel] = document["components"]["web"]["sourceRevision"]
    return sorted(set(retained.values()))


def published_releases():
    pages = json.loads(subprocess.check_output([
        "gh", "api", "--paginate", "--slurp", f"repos/{REPOSITORY}/releases?per_page=100",
    ]))
    return [release for page in pages for release in page
            if release.get("draft") is False and release.get("published_at")]


def require_latest_predecessor(previous):
    published = published_releases()
    sets = [release for release in published if re.fullmatch(r"release-set-[a-f0-9]{40}", release.get("tag_name", ""))]
    latest = max(sets, key=lambda release: release["published_at"]) if sets else None
    expected = latest["tag_name"].removeprefix("release-set-") if latest else None
    if (previous["releaseSet"] if previous else None) != expected:
        raise ValueError("previous_release_set must identify the latest published release set; empty is valid only before bootstrap")
    return published


def require_component_versions(tags, previous, published):
    for name, tag in tags.items():
        if previous and tag == previous["components"][name]["tag"]:
            continue
        prefix = tag.rsplit("-v", 1)[0] + "-v"
        for release in published:
            prior_tag = release.get("tag_name", "")
            if re.fullmatch(re.escape(prefix) + VERSION, prior_tag):
                require_version_advance(tag, prior_tag)


def release_tag(tag, plan):
    """The root vX.Y.Z tag the release creates last; every changed component ships under its version."""
    if not ROOT_TAG.fullmatch(tag):
        raise ValueError(f"release tag must be vX.Y.Z, got {tag}")
    for name, component in plan["components"].items():
        if plan["changed"][name] and component["version"] != tag[1:]:
            raise ValueError(f"changed {name} version {component['version']} differs from release {tag}")
    return tag


def prepare(args):
    request = load(args.request)
    validate_request(request)
    previous = load(args.previous) if args.previous else None
    source = request["sourceRevision"]
    run_url()  # Fail before doing work if provenance cannot be recorded.
    published = require_latest_predecessor(previous)
    require_component_versions(request["tags"], previous, published)
    # No wait for main CI (TAL-2396): the release reuses a check main CI passed on this commit or runs it itself.
    git(ROOT, "merge-base", "--is-ancestor", source, "origin/main")
    for name in COMPONENTS:
        if previous is None or request["tags"][name] != previous["components"][name]["tag"]:
            unused_release(request["tags"][name])
    # Tags last (TAL-2342): the release is authorized by its dispatch on main, and no tag of this version exists yet.
    plan = resolve(ROOT, request, previous)
    plan["releaseTag"] = release_tag(args.release_tag, plan) if args.release_tag else None
    plan["supportedWebSources"] = supported_web_sources(plan, previous, published)
    plan["dryRun"] = args.dry_run
    if previous:
        plan["previousAppSource"] = previous["components"]["app"]["sourceRevision"]
    else:
        plan["previousAppSource"] = subprocess.check_output([
            "python3", str(ROOT / "app/ci/release_notes.py"), "previous-published", "--repo", REPOSITORY,
            "--target", source, "--version", plan["components"]["app"]["version"], "--require-latest",
        ], cwd=ROOT, text=True).strip()
    if not re.fullmatch(r"[a-f0-9]{40}", plan["previousAppSource"]):
        raise ValueError("previous App publication lacks immutable source provenance")
    for name, component in plan["components"].items():
        notes = args.output / "notes" / name
        notes.mkdir(parents=True, exist_ok=True)
        if plan["changed"][name]:
            base = previous["components"][name]["sourceRevision"] if previous else plan["previousAppSource"]
            subprocess.run([
                "python3", str(ROOT / "app/ci/release_notes.py"), "generate", "--component", name,
                "--previous", base, "--target", component["sourceRevision"], "--version", component["version"],
                "--output", str(notes),
            ], cwd=ROOT, check=True)
        else:
            (notes / "release-notes.md").write_text(f"Unchanged; reuses {component['tag']} and its previous immutable artifact.\n")
    write(args.output / "plan.json", plan)
    if previous:
        write(args.output / "previous.json", previous)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            stream.write(f"source={source}\n")
            for name in COMPONENTS:
                stream.write(f"{name}_changed={str(plan['changed'][name]).lower()}\n")
                stream.write(f"{name}_source={plan['components'][name]['sourceRevision']}\n")
                stream.write(f"{name}_version={plan['components'][name]['version']}\n")
    print(json.dumps(plan))


def gate(args):
    plan = load(args.plan)
    if git(ROOT, "rev-parse", "HEAD") != plan["releaseSet"]:
        raise ValueError("gate must run from the immutable release-set checkout")
    run_url()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise ValueError("gate requires its actual validation command")
    subprocess.run(command, cwd=ROOT, check=True)
    write(args.output, receipt(args.name, plan["releaseSet"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    previous_parser = commands.add_parser("previous")
    previous_parser.add_argument("source")
    previous_parser.add_argument("--output", type=Path, required=True)
    resolve_parser = commands.add_parser("prepare")
    resolve_parser.add_argument("--request", type=Path, required=True)
    resolve_parser.add_argument("--previous", type=Path)
    resolve_parser.add_argument("--output", type=Path, required=True)
    resolve_parser.add_argument("--dry-run", action="store_true")
    resolve_parser.add_argument("--release-tag", help="The root vX.Y.Z tag a production release creates last.")
    gate_parser = commands.add_parser("gate")
    gate_parser.add_argument("--plan", type=Path, required=True)
    gate_parser.add_argument("--name", choices=("currentContracts", "previousAppContracts", "agentCompatibility"), required=True)
    gate_parser.add_argument("--output", type=Path, required=True)
    gate_parser.add_argument("command", nargs=argparse.REMAINDER)
    commands.add_parser("retained-webs", help="Print each retained Web release's source revision.")
    assembly = commands.add_parser("assemble")
    assembly.add_argument("--plan", type=Path, required=True)
    assembly.add_argument("--previous", type=Path)
    assembly.add_argument("--receipts", type=Path, required=True)
    assembly.add_argument("--notes", type=Path, required=True)
    assembly.add_argument("--output", type=Path, required=True)
    assembly.add_argument("--complete", action="store_true")
    args = parser.parse_args()
    if args.action == "previous":
        previous(args)
    elif args.action == "prepare":
        prepare(args)
    elif args.action == "gate":
        gate(args)
    elif args.action == "retained-webs":
        print("\n".join(supported_web_sources(None, None, published_releases())))
    else:
        plan = load(args.plan)
        if args.complete and plan.get("dryRun"):
            raise ValueError("dry-run plans cannot publish a completed set")
        document = assemble(plan, [load(path) for path in sorted(args.receipts.glob("*.json"))],
                            {name: (args.notes / name / "release-notes.md").read_text() for name in COMPONENTS},
                            load(args.previous) if args.previous else None, complete=args.complete)
        write(args.output, document)


if __name__ == "__main__":
    main()
