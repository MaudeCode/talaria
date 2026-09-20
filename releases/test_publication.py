"""Publication guards using synthetic jobs and local artifacts only."""

from copy import deepcopy
import hashlib
import io
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
import publish
from test_release_set import candidate, complete


class PublicationTests(unittest.TestCase):
    def test_app_receipt_requires_verified_apple_readback(self):
        plan = {"releaseSet": "a" * 40, "changed": {"app": True}, "contracts": {"appWeb": {"app": [1]}},
                "components": {"app": {"tag": "app-v1.9.0", "version": "1.9.0"}}}
        build = {"gate": "buildApp", "result": "success", "sourceRevision": plan["releaseSet"],
                 "tag": "app-v1.9.0", "buildNumber": 7, "ipaSha256": "b" * 64}
        apple = {"buildId": "synthetic-build", "uploadId": "synthetic-upload", "version": "1.9.0",
                 "buildNumber": 7, "ipaSha256": "b" * 64, "processingState": "VALID"}
        env = {"GITHUB_REPOSITORY": "MaudeCode/talaria", "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "2"}
        for field in (None, "version", "buildNumber", "ipaSha256", "processingState", "buildId", "uploadId"):
            with self.subTest(field=field), TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "plan.json").write_text(json.dumps(plan))
                (root / "build.json").write_text(json.dumps(build))
                (root / "synthetic.ipa").write_bytes(b"IPA verification covered separately")
                response = {**apple, **({field: ""} if field else {})}
                output = root / "publication/receipt.json"
                argv = ["publish.py", "app", "--plan", str(root / "plan.json"), "--build", str(root / "build.json"),
                        "--directory", str(root), "--output", str(output)]
                with patch("sys.argv", argv), patch.dict(os.environ, env), patch("publish.authorize"), \
                        patch("publish.verify_ipa", return_value=build["ipaSha256"]), \
                        patch("publish.subprocess.check_output", return_value=json.dumps(response)) as upload:
                    if field:
                        with self.assertRaisesRegex(ValueError, "readback differs"):
                            publish.main()
                        self.assertFalse(output.exists())
                    else:
                        publish.main()
                        self.assertEqual(json.loads(output.read_text())["gate"], "uploadApp")
                        self.assertEqual(json.loads(output.with_name("apple-build.json").read_text()), apple)
                    self.assertEqual(upload.call_args.args[0][-1], build["ipaSha256"])

    def test_partial_release_publication_resumes_without_recreating_releases(self):
        for failure in ("web-create", "root-upload", "root-edit", "root-upload-after", "root-edit-after"):
            with self.subTest(failure=failure), TemporaryDirectory() as temporary:
                root = Path(temporary)
                manifest = complete(candidate())
                if failure == "root-edit":
                    manifest["components"]["web"]["tag"] = "web-exp-v2.0.0"
                plan = {**deepcopy(manifest), "changed": dict.fromkeys(("app", "web", "relay"), True)}
                wheel = root / "web-build/wheel/talaria_web-1.0.0-py3-none-any.whl"
                wheel.parent.mkdir(parents=True)
                wheel.write_bytes(b"synthetic wheel")
                releases, assets, commands = {}, {}, []
                failed = False

                def unused(tag):
                    if tag in releases:
                        raise ValueError("release already exists")

                def command(args, **kwargs):
                    nonlocal failed
                    commands.append(args)
                    operation, tag = args[2:4]
                    key = ("root" if tag.startswith("release-set-") else "web") + "-" + operation
                    fail_here = not failed and key == failure.removesuffix("-after") and (tag.startswith("release-set-") or tag.startswith("web-"))
                    if fail_here and not failure.endswith("-after"):
                        failed = True
                        raise subprocess.CalledProcessError(1, args)
                    if operation == "create":
                        self.assertNotIn(tag, releases)
                        releases[tag] = {"tag_name": tag, "name": tag, "draft": True, "prerelease": "--prerelease" in args,
                                         "body": Path(args[args.index("--notes-file") + 1]).read_text(), "assets": []}
                    elif operation == "upload":
                        path = Path(args[4])
                        identifier = len(assets) + 1
                        assets[identifier] = path.read_bytes()
                        releases[tag]["assets"].append({"id": identifier, "name": path.name})
                    elif operation == "edit":
                        releases[tag]["draft"] = False
                    else:
                        self.fail("unexpected mutation " + operation)
                    if fail_here and failure.endswith("-after"):
                        failed = True
                        raise subprocess.CalledProcessError(1, args)

                with patch.object(publish, "_release_info", side_effect=lambda tag: deepcopy(releases.get(tag)), create=True), \
                        patch.object(publish, "unused_release", side_effect=unused), \
                        patch.object(publish.subprocess, "run", side_effect=command), \
                        patch.object(publish.subprocess, "check_output", side_effect=lambda args: assets[int(args[2].rsplit("/", 1)[1])]):
                    with self.assertRaises(subprocess.CalledProcessError):
                        finalize(plan, manifest, None, root)
                    self.assertFalse(releases[plan["components"]["app"]["tag"]]["draft"])
                    finalize(plan, manifest, None, root)
                    self.assertEqual(len(releases), 4)
                    self.assertTrue(all(not value["draft"] for value in releases.values()))
                    published = [args[3] for args in commands if args[2] == "edit"]
                    self.assertEqual(published.count(plan["components"]["app"]["tag"]), 1)
                    self.assertEqual(published[-1], "release-set-" + plan["releaseSet"])
                    before = len(commands)
                    finalize(plan, manifest, None, root)
                    self.assertEqual(len(commands), before)
                    another_run = deepcopy(manifest)
                    for receipt in another_run["evidence"]:
                        receipt["runUrl"] = "https://github.com/MaudeCode/talaria/actions/runs/2/attempts/1"
                    with self.assertRaises(ValueError):
                        finalize(plan, another_run, None, root)
                    wheel_id = releases[plan["components"]["web"]["tag"]]["assets"][0]["id"]
                    assets[wheel_id] = b"changed after publication"
                    with self.assertRaisesRegex(ValueError, "asset differs"):
                        finalize(plan, manifest, None, root)
                    assets[wheel_id] = wheel.read_bytes()
                    releases[plan["components"]["app"]["tag"]]["body"] = "unrelated release"
                    with self.assertRaises(ValueError):
                        finalize(plan, manifest, None, root)

    def test_completed_manifest_is_published_last(self):
        manifest = complete(candidate())
        plan = {**deepcopy(manifest), "changed": dict.fromkeys(("app", "web", "relay"), True)}
        with TemporaryDirectory() as temporary, patch("publish._publish_release") as run:
            root = Path(temporary)
            with self.assertRaisesRegex(ValueError, "built wheel"):
                finalize(plan, manifest, None, root)
            run.assert_not_called()
            wheel = root / "web-build/wheel/talaria_web-1.0.0-py3-none-any.whl"
            wheel.parent.mkdir(parents=True)
            wheel.write_bytes(b"synthetic archive; no publication")
            finalize(plan, manifest, None, root)
            self.assertEqual(run.call_count, 4)
            self.assertEqual(run.call_args.args[0], "release-set-" + plan["releaseSet"])
            self.assertTrue(run.call_args.kwargs["latest"])
            self.assertEqual(run.call_args_list[1].args[3], [wheel])
            run.reset_mock()
            broken = deepcopy(manifest)
            broken["agent"]["sourceRevision"] = "f" * 40
            with self.assertRaisesRegex(ValueError, "compatibility metadata"):
                finalize(plan, broken, None, root)
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
        ios = workflow("ios-release-build.yml")
        self.assertEqual(ios["jobs"]["build"]["environment"], "testflight")
        for release_workflow in (document, ios):
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
            self.assertEqual(job.get("secrets"), "inherit" if name == "app-signed-build" else None)
            self.assertEqual(set(re.findall(r"secrets\.([A-Z_]+)", json.dumps(job))), secrets.get(name, set()))
            permissions = job.get("permissions", document["permissions"])
            self.assertEqual(permissions.get("contents"), "write" if name == "publish-set" else "read")
            self.assertEqual(permissions.get("packages"), "write" if name == "web-publish" else None)
        jobs = document["jobs"]
        # The alternate dry/signed App build is deliberately skipped. Publication
        # must follow the explicit build gate instead of implicit success().
        for name in ("relay-publish", "web-publish", "app-publish", "publish-set"):
            self.assertIn("!cancelled()", jobs[name]["if"])
        relay_step = next(step for step in jobs["relay-publish"]["steps"]
                          if step.get("name") == "Deploy the existing Relay and verify readiness/provenance")
        self.assertIn("${GITHUB_WORKFLOW_SHA}:releases/publish.py", relay_step["run"])
        self.assertIn('PYTHONPATH="$PWD/releases"', relay_step["run"])
        self.assertIn("build-gate", jobs["relay-publish"]["needs"])
        self.assertIn("relay-publish", jobs["web-publish"]["needs"])
        self.assertIn("web-publish", jobs["app-publish"]["needs"])
        self.assertEqual(set(jobs["publish-set"]["needs"]), {
            "prepare", "build-gate", "relay-publish", "web-publish", "app-publish"})
        self.assertTrue(any("check_results.py publication" in step.get("run", "")
                            for step in jobs["publish-set"]["steps"]))
        cutover = workflow("production-cutover.yml")
        self.assertEqual(cutover["jobs"]["release"]["secrets"], "inherit")
        self.assertNotIn("environment", cutover["jobs"]["release"])
        self.assertEqual(cutover["jobs"]["release"]["needs"], "authorization")
        self.assertIs(cutover["jobs"]["release"]["with"]["dry_run"], False)
        recovery = workflow("recover-cutover.yml")
        self.assertEqual(recovery["concurrency"]["group"], document["concurrency"]["group"])
        self.assertIn("inputs.confirm_publication", recovery["jobs"]["app"]["if"])
        self.assertIn("refs/heads/main", recovery["jobs"]["app"]["if"])
        self.assertEqual(recovery["jobs"]["app"]["environment"], "testflight")
        self.assertEqual(recovery["jobs"]["publish-set"]["environment"], "release-set-publication")
        self.assertEqual(recovery["jobs"]["publish-set"]["needs"], "app")
        self.assertNotIn("secrets.", json.dumps(recovery["jobs"]["publish-set"]))
        self.assertEqual(recovery["permissions"], {"contents": "read", "actions": "read"})

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
            with patch.dict(os.environ, {"GITHUB_WORKFLOW_REF": "MaudeCode/talaria/.github/workflows/recover-cutover.yml@refs/heads/main"}):
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
            def save(value, widget_release=None):
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr("Payload/Talaria.app/Info.plist", plistlib.dumps(value))
                    for name, identifier in (("TalariaShareExtension", "dev.kil.talaria.shareextension"),
                                             ("TalariaLiveActivityWidget", "dev.kil.talaria.liveactivitywidget")):
                        extension = {**info, "CFBundleIdentifier": identifier}
                        if name == "TalariaLiveActivityWidget" and widget_release is not None:
                            extension["TalariaRelease"] = widget_release
                        archive.writestr(f"Payload/Talaria.app/PlugIns/{name}.appex/Info.plist",
                                         plistlib.dumps(extension))
            save(info)
            self.assertEqual(verify_ipa(path, component), hashlib.sha256(path.read_bytes()).hexdigest())
            for key in info:
                broken = deepcopy(info)
                broken[key] = {} if key == "TalariaRelease" else "wrong"
                save(broken)
                with self.assertRaises(ValueError):
                    verify_ipa(path, component)
            save(info, widget_release={})
            with self.assertRaises(ValueError):
                verify_ipa(path, component)
            for key in component:
                broken = deepcopy(info)
                broken["TalariaRelease"][key] = "wrong"
                save(broken)
                with self.assertRaises(ValueError):
                    verify_ipa(path, component)

    def test_relay_uses_private_scoped_env_file_and_removes_it(self):
        key = "prod:synthetic-relay|synthetic-key"
        component = {"deploymentId": "synthetic-relay", "version": "1.0.0",
                     "sourceRevision": "a" * 40, "releaseSet": "a" * 40}
        plan = {"releaseSet": "a" * 40, "components": {"relay": component}}
        for fail in (False, True):
            with self.subTest(fail=fail), TemporaryDirectory() as temporary:
                paths = []
                def run(command, **kwargs):
                    if command[:4] == ["pnpm", "exec", "convex", "deploy"]:
                        path = Path(command[command.index("--env-file") + 1])
                        paths.append(path)
                        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                        self.assertEqual(path.read_text(), "CONVEX_DEPLOY_KEY=" + json.dumps(key) + "\n")
                        self.assertTrue(path.is_relative_to(Path(temporary)))
                        if fail:
                            raise subprocess.CalledProcessError(1, command)
                env = {"CONVEX_DEPLOY_KEY": key, "RUNNER_TEMP": temporary,
                       "GITHUB_REPOSITORY": "MaudeCode/talaria", "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1"}
                health = io.BytesIO(json.dumps({"ok": True, "release": component}).encode())
                with patch.dict(os.environ, env), patch("publish.subprocess.run", side_effect=run), \
                        patch("publish.urllib.request.urlopen", return_value=health):
                    if fail:
                        with self.assertRaises(subprocess.CalledProcessError):
                            relay(plan, Path(temporary) / "receipt.json")
                    else:
                        relay(plan, Path(temporary) / "receipt.json")
                self.assertEqual(len(paths), 1)
                self.assertFalse(paths[0].exists())

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
