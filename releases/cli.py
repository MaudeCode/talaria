#!/usr/bin/env python3
"""Release workflow commands. Publication credentials are never needed here."""

import argparse
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

from plan import VERSION, assemble, git, resolve, validate_request
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


def previous(args):
    if not re.fullmatch(r"[a-f0-9]{40}", args.source):
        raise ValueError("previous release set must be an immutable commit")
    tag = "release-set-" + args.source
    release = json.loads(subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}/releases/tags/{tag}"]))
    if release.get("tag_name") != tag:
        raise ValueError("previous release identity is inconsistent")
    write(args.output, published_manifest(release))


def supported_web_sources(plan, previous, published):
    """Keep the latest completed Web release in each published channel usable."""
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
        for contract, consumer in (("appWeb", "app"), ("webRelay", "relay")):
            if not set(document["contracts"][contract]["web"]) & set(plan["contracts"][contract][consumer]):
                raise ValueError(f"retained {channel} is incompatible with {contract}")
        retained[channel] = document["components"]["web"]["sourceRevision"]
    return sorted(set(retained.values()))


def require_latest_predecessor(previous):
    pages = json.loads(subprocess.check_output([
        "gh", "api", "--paginate", "--slurp", f"repos/{REPOSITORY}/releases?per_page=100",
    ]))
    published = [release for page in pages for release in page
                 if release.get("draft") is False and release.get("published_at")]
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


def prepare(args):
    request = load(args.request)
    validate_request(request)
    previous = load(args.previous) if args.previous else None
    source = request["sourceRevision"]
    run_url()  # Fail before doing work if provenance cannot be recorded.
    published = require_latest_predecessor(previous)
    require_component_versions(request["tags"], previous, published)
    env = {**os.environ, "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_SHA": source}
    subprocess.run([str(ROOT / "app/ci/require_successful_main_ci")], cwd=ROOT, env=env, check=True)
    with tempfile.TemporaryDirectory(prefix="talaria-release-refs-") as temporary:
        directory = Path(temporary)
        checkout = directory / "refs"
        subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(ROOT), str(checkout)], check=True)
        subprocess.run(["git", "-C", str(checkout), "fetch", "--quiet", "--no-tags", str(ROOT),
                        "+refs/remotes/origin/main:refs/remotes/origin/main"], check=True)
        git(checkout, "merge-base", "--is-ancestor", source, "origin/main")
        key = directory / "rehearsal-key"
        local_tags = set()
        for name in COMPONENTS:
            tag = request["tags"][name]
            changed = previous is None or tag != previous["components"][name]["tag"]
            if changed:
                unused_release(tag)
            exists = subprocess.run(["git", "-C", str(checkout), "show-ref", "--verify", "--quiet", f"refs/tags/{tag}"], check=False).returncode == 0
            if not exists and args.dry_run and changed:
                if not key.exists():
                    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)], check=True)
                    (directory / "allowed-signers").write_text("rehearsal " + key.with_suffix(".pub").read_text())
                configuration = ["-c", "gpg.format=ssh", "-c", f"user.signingkey={key}",
                                 "-c", "user.name=Talaria rehearsal", "-c", "user.email=rehearsal@example.invalid"]
                subprocess.run(["git", "-C", str(checkout), *configuration, "tag", "-s", "-m", "Local dry-run signature; not production authorization", "--", tag, source], check=True)
                subprocess.run(["git", "-C", str(checkout), "-c", "gpg.format=ssh", "-c", f"gpg.ssh.allowedSignersFile={directory / 'allowed-signers'}", "verify-tag", tag], check=True)
                local_tags.add(tag)
        plan = resolve(checkout, request, previous)
        for name, component in plan["components"].items():
            if component["tag"] not in local_tags:
                subprocess.run([str(ROOT / "app/ci/validate_release_tag")], cwd=checkout, check=True,
                               env={**env, "RELEASE_COMPONENT": name, "RELEASE_TAG": component["tag"], "EXPECTED_SHA": component["sourceRevision"]})
                # New sources passed main CI above; reused artifacts retain the
                # authenticated predecessor's evidence after Actions log expiry.
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
    write(args.output / "receipts/mainCI.json", receipt("mainCI", source))
    write(args.output / "receipts/signedTags.json", receipt("signedTags", source))
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
    gate_parser = commands.add_parser("gate")
    gate_parser.add_argument("--plan", type=Path, required=True)
    gate_parser.add_argument("--name", choices=("currentContracts", "previousAppContracts", "agentCompatibility"), required=True)
    gate_parser.add_argument("--output", type=Path, required=True)
    gate_parser.add_argument("command", nargs=argparse.REMAINDER)
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
