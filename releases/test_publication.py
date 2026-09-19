"""Publication guards using synthetic jobs and local artifacts only."""

from copy import deepcopy
import hashlib
from itertools import product
import json
import os
from pathlib import Path
import plistlib
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import zipfile

from check_results import check
from collect import collect
from publish import authorize, finalize, relay, verify_ipa
from test_release_set import candidate, complete


class PublicationTests(unittest.TestCase):
    def test_completed_manifest_is_published_last(self):
        manifest = complete(candidate())
        plan = {**deepcopy(manifest), "changed": dict.fromkeys(("app", "web", "relay"), True)}
        with TemporaryDirectory() as temporary, patch("publish.unused_release"), patch("publish.subprocess.run") as run:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "built wheel"):
                finalize(plan, manifest, None, root, root)
            run.assert_not_called()
            wheel = root / "web-build/wheel/talaria_web-1.0.0-py3-none-any.whl"
            wheel.parent.mkdir(parents=True)
            wheel.write_bytes(b"synthetic archive; no publication")
            finalize(plan, manifest, None, root, root)
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(len(commands), 8)
            self.assertEqual(commands[-1][:4], ["gh", "release", "edit", "release-set-" + plan["releaseSet"]])
            self.assertIn("--draft=false", commands[-1])
            self.assertIn("--draft", commands[-2])
            self.assertIn(str(wheel), commands[2])
            run.reset_mock()
            broken = deepcopy(manifest)
            broken["agent"]["sourceRevision"] = "f" * 40
            with self.assertRaisesRegex(ValueError, "compatibility metadata"):
                finalize(plan, broken, None, root, root)
            run.assert_not_called()

    def test_workflow_credentials_and_final_gate(self):
        root = Path(__file__).resolve().parents[1]
        def workflow(name):
            return json.loads(subprocess.check_output([
                "ruby", "-ryaml", "-rjson", "-e",
                "puts JSON.generate(YAML.safe_load_file(ARGV[0], aliases: true))",
                str(root / ".github/workflows" / name),
            ], text=True))
        document = workflow("release-set.yml")
        for release_workflow in (document, workflow("ios-release-build.yml")):
            for job in release_workflow["jobs"].values():
                if "steps" in job:
                    self.assertEqual(job["runs-on"], "maude-mac")
                    for step in job["steps"]:
                        self.assertNotIn("upload-artifact", step.get("uses", ""))
                        self.assertNotIn("download-artifact", step.get("uses", ""))
        self.assertEqual(document["permissions"], {"contents": "read", "actions": "read"})
        environments = {"relay-publish": "relay-production", "web-publish": "web-release",
                        "app-publish": "testflight", "publish-set": "release-set-publication"}
        secrets = {"relay-publish": {"CONVEX_DEPLOY_KEY"}, "app-publish": {
            "APP_STORE_CONNECT_ISSUER_ID", "APP_STORE_CONNECT_KEY_ID", "APP_STORE_CONNECT_PRIVATE_KEY"}}
        import re
        for name, job in document["jobs"].items():
            self.assertEqual(job.get("environment"), environments.get(name))
            self.assertNotIn("secrets", job)
            self.assertEqual(set(re.findall(r"secrets\.([A-Z_]+)", json.dumps(job))), secrets.get(name, set()))
            permissions = job.get("permissions", document["permissions"])
            self.assertEqual(permissions.get("contents"), "write" if name == "publish-set" else "read")
            self.assertEqual(permissions.get("packages"), "write" if name == "web-publish" else None)
        jobs = document["jobs"]
        self.assertIn("build-gate", jobs["relay-publish"]["needs"])
        self.assertIn("relay-publish", jobs["web-publish"]["needs"])
        self.assertIn("web-publish", jobs["app-publish"]["needs"])
        self.assertEqual(set(jobs["publish-set"]["needs"]), {
            "prepare", "build-gate", "relay-publish", "web-publish", "app-publish"})
        self.assertTrue(any("check_results.py publication" in step.get("run", "")
                            for step in jobs["publish-set"]["steps"]))
        cutover = workflow("production-cutover.yml")
        self.assertEqual(cutover["jobs"]["release"]["needs"], "authorization")
        self.assertIs(cutover["jobs"]["release"]["with"]["dry_run"], False)

    def test_selected_jobs_must_succeed(self):
        for dry, app, web, relay_changed in product((False, True), repeat=4):
            for stage in ("build", "publication"):
                needs = {name: {"result": "success"} for name in ("prepare", "contracts", "agent", "build-gate")}
                needs["prepare"]["outputs"] = {
                    name + "_changed": str(changed).lower()
                    for name, changed in zip(("app", "web", "relay"), (app, web, relay_changed))
                }
                jobs = []
                for name, changed in zip(("app", "web", "relay"), (app, web, relay_changed)):
                    job = name + "-publish" if stage == "publication" else (
                        ("app-dry-build" if dry else "app-signed-build") if name == "app" else name + "-build")
                    jobs.append(job)
                    needs[job] = {"result": "success" if changed else "skipped"}
                if stage == "build":
                    needs["app-signed-build" if dry else "app-dry-build"] = {"result": "skipped"}
                if stage == "publication" and dry:
                    with self.assertRaises(ValueError):
                        check(needs, stage, dry)
                    continue
                check(needs, stage, dry)
                for job in jobs + (["prepare", "contracts", "agent"] if stage == "build" else ["prepare", "build-gate"]):
                    for result in ("failure", "cancelled", "skipped", "success"):
                        if result == needs[job]["result"]:
                            continue
                        broken = deepcopy(needs)
                        broken[job]["result"] = result
                        with self.subTest(stage=stage, dry=dry, job=job, result=result):
                            with self.assertRaises(ValueError):
                                check(broken, stage, dry)

    def test_production_requires_trusted_main_dispatch_and_exact_source(self):
        plan = {"dryRun": False, "releaseSet": "a" * 40}
        env = {
            "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_WORKFLOW_REF": "MaudeCode/talaria/.github/workflows/production-cutover.yml@refs/heads/main",
            "GITHUB_REPOSITORY": "MaudeCode/talaria", "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1",
        }
        with patch.dict(os.environ, env, clear=True), patch("publish.git", return_value=plan["releaseSet"]):
            authorize(plan)
            with self.assertRaises(ValueError):
                authorize({**plan, "dryRun": True})
            for key in env:
                with patch.dict(os.environ, {key: "untrusted"}):
                    with self.assertRaises(ValueError):
                        authorize(plan)
            with patch("publish.git", return_value="b" * 40):
                with self.assertRaises(ValueError):
                    authorize(plan)

    def test_ipa_identity_and_hash(self):
        component = {"version": "1.0.0", "buildNumber": 4, "sourceRevision": "a" * 40,
                     "releaseSet": "a" * 40, "contracts": {"appWeb": [1]}}
        info = {"CFBundleIdentifier": "dev.kil.talaria", "CFBundleShortVersionString": "1.0.0",
                "CFBundleVersion": "4", "TalariaRelease": component}
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "synthetic.ipa"
            def save(value):
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr("Payload/Talaria.app/Info.plist", plistlib.dumps(value))
            save(info)
            self.assertEqual(verify_ipa(path, component), hashlib.sha256(path.read_bytes()).hexdigest())
            for key in info:
                broken = deepcopy(info)
                broken[key] = {} if key == "TalariaRelease" else "wrong"
                save(broken)
                with self.assertRaises(ValueError):
                    verify_ipa(path, component)
            for key in component:
                broken = deepcopy(info)
                broken["TalariaRelease"][key] = "wrong"
                save(broken)
                with self.assertRaises(ValueError):
                    verify_ipa(path, component)

    def test_wrong_relay_key_cannot_execute(self):
        plan = {"components": {"relay": {"deploymentId": "synthetic-relay"}}}
        with patch("publish.subprocess.run") as run:
            for key in ("", "prod:other|secret", "dev:synthetic-relay|secret", "prod:synthetic-relay|"):
                with patch.dict(os.environ, {"CONVEX_DEPLOY_KEY": key}):
                    with self.assertRaises(ValueError):
                        relay(plan, None)
            run.assert_not_called()

    def test_receipt_collection_rejects_unknown_and_duplicate_gates(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "artifacts/contract-receipts"
            source.mkdir(parents=True)
            first = source / "first.json"
            first.write_text(json.dumps({"gate": "currentContracts"}))
            collect(root / "artifacts", root / "receipts")
            self.assertEqual(json.loads((root / "receipts/currentContracts.json").read_text()), {"gate": "currentContracts"})
            with self.assertRaises(FileExistsError):
                collect(root / "artifacts", root / "receipts")
            first.write_text(json.dumps({"gate": "not-a-gate"}))
            with self.assertRaises(ValueError):
                collect(root / "artifacts", root / "other")


if __name__ == "__main__":
    unittest.main()
