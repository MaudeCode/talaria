#!/usr/bin/env python3
"""Synthetic release receipts: no credentials, tags, registry or deployment."""

from copy import deepcopy
import functools
import json
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from jsonschema import ValidationError

from release_set import COMMON_GATES, COMPONENTS, PUBLISH_GATES, validate

ROOT = Path(__file__).resolve().parents[1]


@functools.cache
def _workflow_json(name):
    return subprocess.check_output(["ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load_file(ARGV[0], aliases: true))",
                                    str(ROOT / ".github/workflows" / name)], text=True)


def workflow(name):
    """A workflow file parsed as Actions reads it (YAML 1.1, through Ruby's loader); each call returns a fresh copy."""
    return json.loads(_workflow_json(name))

# The image the Relay release publishes; spelled out so the tests pin the registry contract independently.
BRIDGE_IMAGE = "ghcr.io/maudecode/talaria-feedback-bridge"


def candidate(sha="a" * 40):
    components = {
        name: {"tag": f"{name}-v{index}.0.0", "version": f"{index}.0.0", "sourceRevision": sha, "releaseSet": sha}
        for index, name in enumerate(COMPONENTS, 1)
    }
    components["app"]["buildNumber"] = 1
    components["web"].update(image="ghcr.io/maudecode/talaria-web@sha256:" + "b" * 64, npm="@maudecode/talaria-web@2.0.0")
    components["relay"].update(deploymentId="synthetic-relay", deployedRevision=None,
                               bridgeImage={"ref": f"{BRIDGE_IMAGE}:3.0.0", "digest": "sha256:" + "c" * 64})
    notes = {name: f"{name} release notes" for name in COMPONENTS}
    notes["combined"] = "\n\n".join(f"## {name.title()}\n\n{notes[name]}" for name in COMPONENTS)
    gates = COMMON_GATES | {f"build{name.title()}" for name in COMPONENTS} | {"buildBridge"}
    return {
        "schemaVersion": 1, "releaseSet": sha, "status": "candidate", "previousReleaseSet": None,
        "components": components, "agent": {"releaseTag": "v2026.9.21", "version": "0.21.4", "sourceRevision": "d" * 40},
        "contracts": {
            "appWeb": {"app": [1], "web": [1, 2]}, "webRelay": {"web": [2], "relay": [2]},
            "appRelay": {"app": [1], "relay": [1]},
            "activityScene": {"app": ["activity_scene_v1"], "relay": ["activity_scene_v1"]},
        },
        "evidence": [receipt(gate, sha) for gate in sorted(gates)], "notes": notes,
    }


def receipt(gate, sha):
    return {"gate": gate, "sourceRevision": sha, "runUrl": "https://github.com/MaudeCode/talaria/actions/runs/1/attempts/1", "result": "success"}


def complete(document):
    document["status"] = "complete"
    document["components"]["relay"]["deployedRevision"] = document["components"]["relay"]["sourceRevision"]
    document["evidence"].extend(receipt(gate, document["releaseSet"]) for gate in [*PUBLISH_GATES.values(), "publishBridge"])
    return document


class ReleaseSetTests(unittest.TestCase):
    def test_published_manifests_from_before_tal_245_still_validate(self):
        # Published manifests are immutable; sets released before TAL-245 still record the Web upstreamBase.
        from cli import VALIDATOR
        legacy = complete(candidate())
        legacy["components"]["web"]["upstreamBase"] = "f" * 40
        VALIDATOR.validate(legacy)
        VALIDATOR.validate(complete(candidate()))
        for key, value in (("upstreamBase", "not-a-sha"), ("unexpected", "x")):
            broken = complete(candidate())
            broken["components"]["web"][key] = value
            with self.subTest(key=key), self.assertRaises(ValidationError):
                VALIDATOR.validate(broken)

    def test_release_is_one_dispatch_that_reads_its_commit_from_preflight(self):
        # Tags last (TAL-2342, MaudeCode/.github RELEASES.md): production-cutover.yml is the release. It starts only by a
        # dispatch with a version and an optional commit, checks that first, and every job takes the commit preflight
        # resolved, since the input may be empty.
        document = workflow("production-cutover.yml")
        triggers = document.get("on", document.get("true"))
        self.assertEqual(set(triggers), {"workflow_dispatch"})
        inputs = triggers["workflow_dispatch"]["inputs"]
        self.assertEqual({name: (spec["type"], spec["required"]) for name, spec in inputs.items()},
                         {"tag": ("string", True), "sha": ("string", False)})
        self.assertEqual(document["run-name"], "Release ${{ inputs.tag }}")
        jobs = document["jobs"]
        check = jobs["preflight"]["steps"][0]
        self.assertRegex(check["uses"], r"^MaudeCode/\.github/actions/release-preflight@[0-9a-f]{40}$")
        self.assertEqual({key: check["with"][key] for key in ("tag", "sha")}, {"tag": "${{ inputs.tag }}", "sha": "${{ inputs.sha }}"})
        self.assertEqual(jobs["preflight"]["outputs"]["sha"], "${{ steps.%s.outputs.sha }}" % check["id"])
        for name, job in jobs.items():
            if name != "preflight":
                self.assertIn("preflight", job["needs"] if isinstance(job["needs"], list) else [job["needs"]], name)
        rest = json.dumps({**jobs, "preflight": {**jobs["preflight"], "steps": jobs["preflight"]["steps"][1:]}})
        self.assertNotIn("inputs.sha", rest, "jobs read the commit from preflight, never the possibly empty input")
        steps = jobs["preflight"]["steps"]
        # The workflow revision's tooling plans the frozen commit (TAL-2396), with its full history.
        checkout = next(step for step in steps if step.get("uses", "").startswith("actions/checkout@"))
        self.assertEqual(checkout["with"], {"fetch-depth": 0})
        commands = "\n".join(step.get("run", "") for step in steps)
        self.assertIn('releases/autorelease.py --tag "$RELEASE_TAG" --sha "$SOURCE"', commands)
        # Preflight only reads: the repository, and main CI's push run for the checks it already passed, so a release
        # that fails before publication leaves nothing behind (TAL-2396).
        self.assertEqual(jobs["preflight"]["permissions"], {"contents": "read", "actions": "read"})
        self.assertEqual(document["permissions"], {"contents": "read"})
        for job in jobs.values():
            self.assertNotIn("environment", job)
        self.assertEqual(jobs["release"]["uses"], "./.github/workflows/release-set.yml")
        self.assertEqual(jobs["release"]["with"], {
            "request": "${{ needs.preflight.outputs.request }}", "previous_release_set": "${{ needs.preflight.outputs.previous }}",
            "dry_run": False, "release_tag": "${{ needs.preflight.outputs.tag }}",
            "checks": "${{ needs.preflight.outputs.checks }}"})

    def test_release_holds_workflow_changes_until_it_ends(self):
        # RELEASES.md rule 6 (TAL-2516): the release freezes open pull requests that change a workflow file, thaws them
        # however it ends, and CI sets each pull request's own status. All three name this release workflow, whose file
        # is not the action's default release.yml, or the freeze never sees a release running.
        release = workflow("production-cutover.yml")["jobs"]
        ci = workflow("ci.yml")["jobs"]
        steps = {"start": release["freeze"], "end": release["thaw"], "pull-request": ci["release-freeze"]}
        for mode, job in steps.items():
            with self.subTest(mode=mode):
                (step,) = job["steps"]
                self.assertRegex(step["uses"], r"^MaudeCode/\.github/actions/release-freeze@[0-9a-f]{40}$")
                self.assertEqual(step["with"], {"mode": mode, "workflow": "production-cutover.yml"})
                self.assertEqual(job["permissions"], {"statuses": "write", "pull-requests": "read", "actions": "read"})
        self.assertEqual(release["freeze"]["needs"], "preflight")
        self.assertEqual(release["thaw"]["if"], "always()")
        self.assertEqual(set(release["thaw"]["needs"]), set(release) - {"thaw"})
        # The status is the block: the job is no suite the release reuses and CI Gate does not wait on it.
        self.assertNotIn("release-freeze", ci["gate"]["needs"])

    def test_a_set_released_with_a_main_ci_receipt_still_validates(self):
        # Sets released before TAL-2396 recorded a mainCI receipt; new sets have none
        # (test_independent_versions_and_expanded_contracts validates one).
        historical = complete(candidate())
        historical["evidence"].append(receipt("mainCI", historical["releaseSet"]))
        validate(historical)

    def test_no_tag_push_starts_a_workflow(self):
        # Tags last (TAL-2342): a version tag marks a release that shipped, so pushing one must start nothing. A push
        # trigger without a branch filter fires on tag pushes too.
        for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
            document = workflow(path.name)
            triggers = document.get("on", document.get("true"))
            push = triggers.get("push", False) if isinstance(triggers, dict) else ("push" in triggers and None)
            with self.subTest(workflow=path.name):
                self.assertTrue(push is False or (isinstance(push, dict) and "branches" in push and "tags" not in push), push)

    def test_independent_versions_and_expanded_contracts(self):
        self.assertEqual(validate(candidate()), list(COMPONENTS))
        self.assertEqual(validate(complete(candidate())), list(COMPONENTS))
        legacy = candidate()
        legacy["agent"].pop("releaseTag")
        validate(legacy)  # The first published schema-v1 manifest predates release-only Agent pins.
        document = candidate()
        document["agent"] = {"releaseTag": "v2026.9.21", "version": "0.21.4", "image": "docker.io/nousresearch/hermes-agent@sha256:" + "d" * 64}
        document["components"]["web"]["tag"] = "web-exp-v2.0.0"
        validate(document)

    def test_rejects_incomplete_mutable_or_incompatible_references(self):
        changes = [
            lambda d: d.pop("agent"),
            lambda d: d["agent"].update(releaseTag="main"),
            lambda d: d["agent"].pop("sourceRevision"),
            lambda d: d["components"]["web"].update(image="ghcr.io/maudecode/talaria-web:latest"),
            lambda d: d["components"]["relay"].update(sourceRevision="main"),
            lambda d: d["components"]["app"].update(tag="v1.0.0"),
            lambda d: d["components"]["app"].update(version="8.0.0"),
            lambda d: d["components"]["app"].update(buildNumber=0),
            lambda d: d["components"]["app"].update(releaseSet="e" * 40),
            lambda d: d["components"]["app"].update(secret="unexpected"),
            lambda d: d["contracts"]["appWeb"].update(web=[2]),
            lambda d: d["contracts"]["activityScene"].update(relay=["activity_scene_v2"]),
            lambda d: d["evidence"].pop(),
            lambda d: d["evidence"].append(deepcopy(d["evidence"][0])),
            lambda d: d["evidence"][0].update(sourceRevision="e" * 40),
            lambda d: d["evidence"][0].update(result="failure"),
            lambda d: d["evidence"][0].update(runUrl="https://example.com/unrelated"),
            lambda d: d["notes"].update(combined="unrelated notes"),
            lambda d: d.update(releaseSet=d["releaseSet"] + "\n"),
            lambda d: d["components"]["web"].update(image=d["components"]["web"]["image"] + "\n"),
            lambda d: d["components"]["app"].update(tag="app-v1.0.0\n", version="1.0.0\n"),
            lambda d: d["evidence"][0].update(runUrl=d["evidence"][0]["runUrl"] + "\n"),
            lambda d: d["components"]["relay"].pop("bridgeImage"),
            lambda d: d["components"]["relay"]["bridgeImage"].update(ref=f"{BRIDGE_IMAGE}:2.0.0"),
            lambda d: d["components"]["relay"]["bridgeImage"].update(ref=f"{BRIDGE_IMAGE}:sha-0123456789ab"),
            lambda d: d["components"]["relay"]["bridgeImage"].update(ref="ghcr.io/maudecode/talaria-web:3.0.0"),
            lambda d: d["components"]["relay"]["bridgeImage"].update(digest="sha256:short"),
            lambda d: d["components"]["relay"]["bridgeImage"].pop("digest"),
            lambda d: d.update(evidence=[r for r in d["evidence"] if r["gate"] != "buildBridge"]),
        ]
        for change in changes:
            with self.subTest(change=change):
                document = candidate()
                change(document)
                with self.assertRaises((ValueError, ValidationError)):
                    validate(document)

    def test_candidate_cannot_claim_publication_or_be_promoted_without_receipts(self):
        for gate in ("publishWeb", "publishBridge"):
            document = candidate()
            document["evidence"].append(receipt(gate, document["releaseSet"]))
            with self.subTest(gate=gate), self.assertRaisesRegex(ValueError, "cannot contain publication"):
                validate(document)
        document = complete(candidate())
        document["evidence"] = [r for r in document["evidence"] if r["gate"] != "publishBridge"]
        with self.assertRaisesRegex(ValueError, "missing successful gates: publishBridge"):
            validate(document)
        document = candidate()
        document["components"]["relay"]["deployedRevision"] = document["releaseSet"]
        with self.assertRaisesRegex(ValueError, "cannot claim"):
            validate(document)
        document["status"] = "complete"
        with self.assertRaisesRegex(ValueError, "missing successful gates"):
            validate(document)
        complete(document)
        document["components"]["relay"]["deployedRevision"] = "e" * 40
        with self.assertRaisesRegex(ValueError, "deployed source"):
            validate(document)

    def test_reuse_and_previous_app_contract(self):
        previous = complete(candidate())
        document = candidate("e" * 40)
        document["previousReleaseSet"] = previous["releaseSet"]
        for name in ("app", "relay"):
            document["components"][name] = deepcopy(previous["components"][name])
        document["components"]["web"].update(tag="web-v2.1.0", version="2.1.0")
        document["evidence"] = [r for r in document["evidence"] if r["gate"] not in ("buildApp", "buildRelay", "buildBridge")]
        self.assertEqual(validate(document, previous), ["web"])
        # The bridge image ships only with a changed Relay.
        for gate in ("buildBridge", "publishBridge"):
            republished = complete(deepcopy(document))
            republished["components"]["relay"] = deepcopy(previous["components"]["relay"])
            republished["evidence"] = [r for r in republished["evidence"] if r["gate"] not in ("deployRelay", "uploadApp", "publishBridge")]
            republished["evidence"].append(receipt(gate, document["releaseSet"]))
            with self.subTest(gate=gate), self.assertRaisesRegex(ValueError, "cannot be republished"):
                validate(republished, previous)
        with self.assertRaisesRegex(ValueError, "previous release manifest"):
            validate(document)
        for field in ("buildNumber", "version"):
            mutated = deepcopy(document)
            mutated["components"]["app"][field] = 2 if field == "buildNumber" else "9.0.0"
            with self.assertRaises(ValueError):
                validate(mutated, previous)
        mutated = deepcopy(document)
        mutated["contracts"]["appWeb"]["app"] = [1, 2]
        with self.assertRaisesRegex(ValueError, "reused app"):
            validate(mutated, previous)
        # New App and Web agree on v2, but previously installed App still needs v1.
        document["components"]["app"] = candidate("e" * 40)["components"]["app"]
        document["components"]["app"].update(tag="app-v1.1.0", version="1.1.0")
        document["contracts"]["appWeb"] = {"app": [2], "web": [2]}
        with self.assertRaisesRegex(ValueError, "previous App"):
            validate(document, previous)

    def test_cli_validates_before_writing_and_never_overwrites(self):
        with TemporaryDirectory() as directory:
            source, output = (Path(directory) / name for name in ("input.json", "release.json"))
            source.write_text(json.dumps(candidate()))
            command = [sys.executable, str(Path(__file__).with_name("release_set.py")), str(source), "--output", str(output)]
            subprocess.run(command, check=True, capture_output=True)
            saved = output.read_bytes()
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual(output.read_bytes(), saved)
            source.write_text('{}')
            output.unlink()
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertFalse(output.exists())

    def test_manifest_preserves_previous_web_during_relay_upgrade(self):
        previous = complete(candidate())
        document = candidate("e" * 40)
        document["previousReleaseSet"] = previous["releaseSet"]
        for name in ("app", "web", "relay"):
            version = document["components"][name]["version"].split(".")
            version[-1] = str(int(version[-1]) + 1)
            version = ".".join(version)
            document["components"][name].update(tag=f"{name}-v{version}", version=version)
        document["components"]["relay"]["bridgeImage"]["ref"] = f"{BRIDGE_IMAGE}:{document['components']['relay']['version']}"
        document["contracts"]["webRelay"] = {"web": [3], "relay": [3]}
        with self.assertRaisesRegex(ValueError, "previous Web"):
            validate(document, previous)
        document["contracts"]["webRelay"]["relay"] = [2, 3]
        validate(document, previous)

    def test_new_app_must_support_previous_web(self):
        from release_set import require_compatible_contracts

        previous = complete(candidate())
        previous["contracts"]["appWeb"]["web"] = [1]
        contracts = deepcopy(previous["contracts"])
        contracts["appWeb"] = {"app": [2], "web": [1, 2]}
        with self.assertRaisesRegex(ValueError, "previous Web"):
            require_compatible_contracts(contracts, previous)
        contracts["appWeb"]["app"] = [1, 2]
        require_compatible_contracts(contracts, previous)


if __name__ == "__main__":
    unittest.main()
