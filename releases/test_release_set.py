#!/usr/bin/env python3
"""Synthetic release receipts: no credentials, tags, registry or deployment."""

from copy import deepcopy
import json
import fnmatch
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

from jsonschema import ValidationError

from release_set import COMMON_GATES, COMPONENTS, PUBLISH_GATES, validate


def candidate(sha="a" * 40):
    components = {
        name: {"tag": f"{name}-v{index}.0.0", "version": f"{index}.0.0", "sourceRevision": sha, "releaseSet": sha}
        for index, name in enumerate(COMPONENTS, 1)
    }
    components["app"]["buildNumber"] = 1
    components["web"].update(image="ghcr.io/maudecode/talaria-web@sha256:" + "b" * 64, npm="@maudecode/talaria-web@2.0.0")
    components["relay"].update(deploymentId="synthetic-relay", deployedRevision=None)
    notes = {name: f"{name} release notes" for name in COMPONENTS}
    notes["combined"] = "\n\n".join(f"## {name.title()}\n\n{notes[name]}" for name in COMPONENTS)
    gates = COMMON_GATES | {f"build{name.title()}" for name in COMPONENTS}
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
    document["evidence"].extend(receipt(gate, document["releaseSet"]) for gate in PUBLISH_GATES.values())
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

    def test_root_tag_workflow_only_starts_the_main_cutover(self):
        # One step (TAL-336): a signed vX.Y.Z push validates, tags changed components and dispatches the
        # production cutover on main; it holds no publishing credentials and publishes nothing itself.
        workflow = Path(__file__).resolve().parents[1] / ".github/workflows/release.yml"
        document = json.loads(subprocess.check_output([
            "ruby", "-ryaml", "-rjson", "-e",
            "puts JSON.generate(YAML.safe_load_file(ARGV[0], aliases: true))", str(workflow),
        ], text=True))
        triggers = document.get("on", document.get("true"))
        self.assertEqual(set(triggers), {"push"})
        patterns = triggers["push"]["tags"]
        self.assertTrue(any(fnmatch.fnmatchcase("v1.10.1", pattern) for pattern in patterns))
        for component_tag in ("app-v1.9.0", "web-v1.0.0", "web-exp-v1.0.0", "relay-v0.2.0"):
            self.assertFalse(any(fnmatch.fnmatchcase(component_tag, pattern) for pattern in patterns))
        self.assertEqual(document["permissions"], {"actions": "write", "contents": "write"})
        for job in document["jobs"].values():
            self.assertNotIn("environment", job)
            self.assertNotIn("secrets", job)
            self.assertNotIn("uses", job)  # Publication happens only in the dispatched main cutover.
            self.assertNotIn("permissions", job)
        commands = "\n".join(step.get("run", "") for job in document["jobs"].values() for step in job["steps"])
        for required in ("app/ci/validate_release_tag", "app/ci/require_successful_main_ci", "releases/autorelease.py",
                         "gh workflow run production-cutover.yml --repo \"$GITHUB_REPOSITORY\" --ref main"):
            self.assertIn(required, commands)
        self.assertIn("app/ci/require_successful_main_ci", commands)

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
        ]
        for change in changes:
            with self.subTest(change=change):
                document = candidate()
                change(document)
                with self.assertRaises((ValueError, ValidationError)):
                    validate(document)

    def test_candidate_cannot_claim_publication_or_be_promoted_without_receipts(self):
        document = candidate()
        document["evidence"].append(receipt("publishWeb", document["releaseSet"]))
        with self.assertRaisesRegex(ValueError, "cannot contain publication"):
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
        document["evidence"] = [r for r in document["evidence"] if r["gate"] not in ("buildApp", "buildRelay")]
        self.assertEqual(validate(document, previous), ["web"])
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
