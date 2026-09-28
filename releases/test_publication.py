"""Publication guards using synthetic jobs and local artifacts only."""

from copy import deepcopy
import hashlib
import io
from itertools import product
import json
import re
import os
from pathlib import Path
import plistlib
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import zipfile

from check_results import check
from collect import collect
from publish import authorize, finalize, relay, verify_ipa
import publish
from test_release_set import candidate, complete
from cli import require_latest_predecessor

# Workflows whose runners and handoffs scripts/check-hosted-runners.py guards (GitHub-hosted, no NAS keys).
_hosted = (Path(__file__).resolve().parents[1] / "scripts/check-hosted-runners.py").read_text()
HOSTED_SCOPE = set(re.findall(r'"([\w-]+\.yml)"', _hosted.split("SCOPE = (", 1)[1].split(")", 1)[0]))


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch("publish.require_latest_predecessor", return_value=[], create=True))

    def test_native_release_lookup_resolves_drafts_and_rejects_errors(self):
        draft = {"id": 123, "tag_name": "app-v1.0.0", "draft": True}
        def lookup(command, **kwargs):
            # The REST tag endpoint cannot see an unpublished draft.
            if command[1] == "api":
                return SimpleNamespace(returncode=1, stdout="", stderr="HTTP 404")
            self.assertEqual(command, ["gh", "release", "view", "app-v1.0.0", "--repo", "MaudeCode/talaria", "--json", "databaseId"])
            return SimpleNamespace(returncode=0, stdout='{"databaseId":123}', stderr="")
        with patch("publish.subprocess.run", side_effect=lookup), patch("publish.unused_release"), \
                patch("publish.subprocess.check_output", return_value=json.dumps(draft)) as read:
            self.assertEqual(publish._release_info("app-v1.0.0"), draft)
            self.assertEqual(read.call_args.args[0], ["gh", "api", "repos/MaudeCode/talaria/releases/123"])
        for error in ("release not found", "HTTP 403", "connection failed"):
            with self.subTest(error=error), patch("publish.subprocess.run", return_value=SimpleNamespace(returncode=1, stdout="", stderr=error)), \
                    patch("publish.unused_release") as unused:
                if error == "release not found":
                    self.assertIsNone(publish._release_info("app-v1.0.0"))
                    unused.assert_called_once()
                else:
                    with self.assertRaises(ValueError):
                        publish._release_info("app-v1.0.0")
                    unused.assert_not_called()

    def test_finalization_rejects_superseded_set_but_allows_exact_set_retry(self):
        manifest = complete(candidate())
        plan = {**deepcopy(manifest), "changed": dict.fromkeys(("app", "web", "relay"), True)}
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("maudecode-talaria-web-contracts-1.0.0.tgz", "maudecode-talaria-web-1.0.0.tgz"):
                tarball = root / "web-build/npm" / name
                tarball.parent.mkdir(parents=True, exist_ok=True)
                tarball.write_bytes(b"synthetic")
            for latest in (None, manifest["releaseSet"], "f" * 40):
                releases = [] if latest is None else [{"tag_name": "release-set-" + latest,
                                                       "draft": False, "published_at": "2026-01-01"}]
                with self.subTest(latest=latest), patch("publish._publish_release") as publish_release, \
                        patch("publish.require_latest_predecessor", wraps=require_latest_predecessor), \
                        patch("cli.subprocess.check_output", return_value=json.dumps([releases])):
                    if latest == "f" * 40:
                        with self.assertRaisesRegex(ValueError, "latest published"):
                            finalize(plan, manifest, None, root)
                        publish_release.assert_not_called()
                    else:
                        finalize(plan, manifest, None, root)
                        self.assertEqual(publish_release.call_count, 4)

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
                wheel = root / "web-build/npm/maudecode-talaria-web-1.0.0.tgz"
                wheel.parent.mkdir(parents=True)
                wheel.write_bytes(b"synthetic tarball")
                (root / "web-build/npm/maudecode-talaria-web-contracts-1.0.0.tgz").write_bytes(b"synthetic contracts tarball")
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
                        self.assertIn("--verify-tag", args)
                        self.assertNotIn("--target", args)
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
            with self.assertRaisesRegex(ValueError, "built npm tarballs"):
                finalize(plan, manifest, None, root)
            run.assert_not_called()
            wheel = root / "web-build/npm/maudecode-talaria-web-1.0.0.tgz"
            wheel.parent.mkdir(parents=True)
            wheel.write_bytes(b"synthetic archive; no publication")
            contracts = root / "web-build/npm/maudecode-talaria-web-contracts-1.0.0.tgz"
            contracts.write_bytes(b"synthetic contracts archive")
            finalize(plan, manifest, None, root)
            self.assertEqual(run.call_count, 4)
            self.assertEqual(run.call_args.args[0], "release-set-" + plan["releaseSet"])
            self.assertTrue(run.call_args.kwargs["latest"])
            self.assertEqual(run.call_args_list[1].args[3], [wheel, contracts])
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
        for package in ("contracts", "server"):
            metadata = json.loads((root / "web/packages" / package / "package.json").read_text())
            self.assertEqual(metadata["repository"]["url"], "git+https://github.com/MaudeCode/talaria.git")
            self.assertEqual(metadata["publishConfig"], {"access": "public"})
        self.assertEqual(ios["jobs"]["build"]["environment"], "testflight")
        for release_workflow in (document, ios):
            for name, job in release_workflow["jobs"].items():
                if "steps" not in job:
                    continue
                # Handoffs cross runners through the NAS store; producer digests travel in job outputs and the
                # release bucket credentials reach only the steps that move handoffs.
                for step in job["steps"]:
                    if "artifacts.py put" in step.get("run", "") or "artifacts.py get" in step.get("run", ""):
                        self.assertEqual(step.get("env", {}).get("TALARIA_S3_SECRET_ACCESS_KEY"),
                                         "${{ secrets.TALARIA_RELEASE_S3_SECRET_ACCESS_KEY }}", (name, step.get("name")))
        self.assertEqual(document["permissions"], {"contents": "read", "actions": "read"})
        # npm trusted publishing runs on the GitHub-hosted web-publication job; the GHCR push runs self-hosted in
        # web-publish. Both publish Web, so both use the web-release environment.
        environments = {"relay-publish": "relay-production", "web-publication": "web-release", "web-publish": "web-release",
                        "app-publish": "testflight", "publish-set": "release-set-publication"}
        secrets = {"relay-publish": {"CONVEX_DEPLOY_KEY"}, "app-publish": {
            "APP_STORE_CONNECT_ISSUER_ID", "APP_STORE_CONNECT_KEY_ID", "APP_STORE_CONNECT_PRIVATE_KEY"}}
        store = {"TALARIA_RELEASE_S3_ACCESS_KEY_ID", "TALARIA_RELEASE_S3_SECRET_ACCESS_KEY"}
        import re
        for name, job in document["jobs"].items():
            self.assertEqual(job.get("environment"), environments.get(name))
            self.assertEqual(job.get("secrets"), "inherit" if name == "app-signed-build" else None)
            self.assertEqual(set(re.findall(r"secrets\.([A-Z0-9_]+)", json.dumps(job))) - store, secrets.get(name, set()))
            permissions = job.get("permissions", document["permissions"])
            self.assertEqual(permissions.get("contents"), "write" if name == "publish-set" else "read")
            self.assertEqual(permissions.get("packages"), "write" if name == "web-publish" else None)
            self.assertEqual(permissions.get("id-token"), "write" if name == "web-publication" else None)
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
        self.assertIn("relay-publish", jobs["web-publication"]["needs"])
        self.assertIn("web-publication", jobs["web-publish"]["needs"])
        # The GitHub-hosted npm job cannot reach the private NAS: it never touches the store, and gets its
        # tarballs from the Actions cache under the digest the self-hosted build job recorded.
        hosted = json.dumps(jobs["web-publication"])
        self.assertNotIn("TALARIA_S3", hosted)
        self.assertNotIn("artifacts.py", hosted)
        restore = next(step for step in jobs["web-publication"]["steps"] if "actions/cache/restore" in step.get("uses", ""))
        self.assertIn("needs.web-build.outputs.npm_handoff_sha256", restore["with"]["key"])
        self.assertIs(restore["with"]["fail-on-cache-miss"], True)
        self.assertTrue(any("sha256sum --check" in step.get("run", "") for step in jobs["web-publication"]["steps"]))
        self.assertIn("web-publish", jobs["app-publish"]["needs"])
        self.assertEqual(set(jobs["publish-set"]["needs"]), {
            "prepare", "build-gate", "relay-publish", "web-publish", "app-publish"})
        self.assertTrue(any("check_results.py publication" in step.get("run", "")
                            for step in jobs["publish-set"]["steps"]))
        for job in (jobs["publish-set"], workflow("recover-cutover.yml")["jobs"]["publish-set"]):
            script = next(step["run"] for step in job["steps"] if "finalize" in step.get("run", ""))
            self.assertLess(script.index('refs/tags/release-set-${source}"'), script.index("finalize"),
                            "the root tag must exist before its release is created")
        cutover = workflow("production-cutover.yml")
        self.assertEqual(cutover["jobs"]["release"]["secrets"], "inherit")
        self.assertEqual(cutover["jobs"]["release"]["permissions"]["id-token"], "write")
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
        self.assertEqual(set(re.findall(r"secrets\.([A-Z0-9_]+)", json.dumps(recovery["jobs"]["publish-set"]))), store)
        self.assertEqual(recovery["permissions"], {"contents": "read", "actions": "read"})
        app_steps = recovery["jobs"]["app"]["steps"]
        upload_index = next(index for index, step in enumerate(app_steps) if "require Apple VALID" in step.get("name", ""))
        self.assertTrue(any("releases/recover.py" in step.get("run", "") for step in app_steps[:upload_index]))
        self.assertFalse(any("cli.py assemble" in step.get("run", "") for step in app_steps[:upload_index]),
                         "Partial publication receipts must not be assembled as a dry-run candidate")

    def test_artifacts_use_the_nas_store_with_bucket_scoped_credentials(self):
        # GitHub artifact storage is not used. CI workflows may only reference the talaria-ci key, release
        # workflows only the talaria-release key, and no other workflow references either.
        allowed = {
            "fuzz-soak.yml": {"soak": "CI"},
            "ui-performance.yml": {"measure": "CI"},
            "ios-release-build.yml": {"build": "RELEASE"},
            "release-set.yml": {name: "RELEASE" for name in (
                "prepare", "contracts", "component-contracts", "agent", "relay-build", "web-build", "app-dry-build",
                "candidate", "relay-publish", "web-publish", "app-publish", "publish-set")},
            "recover-cutover.yml": {"app": "RELEASE", "publish-set": "RELEASE"},
        }
        root = Path(__file__).resolve().parents[1]
        for path in sorted((root / ".github/workflows").glob("*.yml")):
            text = path.read_text()
            if path.name not in HOSTED_SCOPE:  # scripts/check-hosted-runners.py owns these (TAL-380).
                self.assertNotIn("upload-artifact", text, path.name)
                self.assertNotIn("download-artifact", text, path.name)
            document = json.loads(subprocess.check_output([
                "ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load_file(ARGV[0], aliases: true))", str(path),
            ], text=True))
            for name, job in document["jobs"].items():
                buckets = set(re.findall(r"secrets\.TALARIA_(CI|RELEASE)_S3_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)", json.dumps(job)))
                expected = allowed.get(path.name, {}).get(name)
                self.assertEqual(buckets, {expected} if expected else set(), (path.name, name))
                if expected and "uses" in job:
                    # A caller may only forward the CI key into the Docker smoke's NAS layer cache.
                    self.assertEqual(job["uses"], "./.github/workflows/web-docker-smoke.yml", (path.name, name))
                elif expected:
                    self.assertRegex(json.dumps(job), r"scripts/s3-artifact|artifacts\.py (put|get)|releases/recover\.py", (path.name, name))
        for path in (root / ".github/actions").glob("*/action.yml"):
            self.assertNotIn("artifact@", path.read_text(), path.name)

    def test_only_native_jobs_use_the_mac_runner(self):
        # The single Mac runner is reserved for Xcode, simulator and Apple signing work; every other job runs on
        # the Linux pool, or on GitHub-hosted Linux where npm trusted publishing requires it. Each allowed Mac job
        # names the native dependency its steps must still show; moving a portable job back fails here.
        native = {
            ("fuzz-soak.yml", "soak"): "xcodebuild",
            ("ui-performance.yml", "measure"): "xcodebuild",
            ("ios-release-build.yml", "build"): "xcodebuild archive",
            ("release-set.yml", "contracts"): "check-previous-app.py",
            ("release-set.yml", "app-dry-build"): "build.py app",
        }
        root = Path(__file__).resolve().parents[1]
        found = {}
        for path in sorted((root / ".github/workflows").glob("*.yml")):
            document = json.loads(subprocess.check_output([
                "ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load_file(ARGV[0], aliases: true))", str(path),
            ], text=True))
            for name, job in document["jobs"].items():
                if "steps" not in job or path.name in HOSTED_SCOPE:
                    continue
                runner = job["runs-on"]
                if runner == "maude-mac":
                    found[(path.name, name)] = json.dumps(job["steps"])
                else:
                    self.assertIn(runner, (["ghar-set-maudecode"], "ubuntu-latest"), (path.name, name))
                    self.assertEqual(runner == "ubuntu-latest", (path.name, name) in {("release-set.yml", "web-publication"),
                                                                                       ("web-experimental.yml", "publish"),
                                                                                       ("web-experimental.yml", "advance")})
        self.assertEqual(set(found), set(native))
        for job, dependency in native.items():
            self.assertIn(dependency, found[job], job)

    def test_assembly_restores_only_receipt_handoffs(self):
        # Candidate and publication assembly must not pull the Web image or iOS payloads off the NAS.
        root = Path(__file__).resolve().parents[1]
        document = json.loads(subprocess.check_output([
            "ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load_file(ARGV[0], aliases: true))",
            str(root / ".github/workflows/release-set.yml"),
        ], text=True))
        recovery = json.loads(subprocess.check_output([
            "ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load_file(ARGV[0], aliases: true))",
            str(root / ".github/workflows/recover-cutover.yml"),
        ], text=True))
        for workflow, name in ((document, "candidate"), (document, "publish-set"), (recovery, "publish-set")):
            runs = [step.get("run", "") for step in workflow["jobs"][name]["steps"]]
            restores = [run for run in runs if "artifacts.py get" in run]
            with self.subTest(job=name):
                self.assertTrue(restores)
                self.assertTrue(all("--receipts" in run for run in restores), restores)
        # Recovery consumes the IPA itself; finalization cannot use it, so it is never restaged.
        restage = "\n".join(step.get("run", "") for step in recovery["jobs"]["app"]["steps"] if "artifacts.py put" in step.get("run", ""))
        self.assertNotIn("ios-ipa", restage)
        self.assertNotIn("ios-dsyms", restage)

    def test_multi_platform_emulation_is_proven_by_an_arm64_build_step(self):
        # The pool's Talos kernel has no binfmt_misc, so neither apt QEMU nor a privileged binfmt installer can
        # register handlers. BuildKit's own buildkit-qemu-aarch64 runs arm64 steps; the action proves it by
        # building an arm64 RUN step instead of trusting the kernel-registered platform list.
        action = (Path(__file__).resolve().parents[1] / ".github/actions/docker-plugins/action.yml").read_text()
        self.assertNotIn("tonistiigi/binfmt", action)
        self.assertNotIn("--privileged", action)
        self.assertNotIn("qemu-user-static", action)
        self.assertRegex(action, r"FROM busybox:[\w.]+@sha256:[0-9a-f]{64}")
        self.assertIn("--platform linux/arm64", action)
        self.assertIn("aarch64", action)

    def test_pr_ci_full_history_checkouts_are_blobless(self):
        # Classification and tooling need history and trees, not every historical blob; release jobs keep
        # full clones because they make local --shared clones that cannot resolve a partial clone's objects.
        root = Path(__file__).resolve().parents[1]
        def checkout(name, job):
            document = json.loads(subprocess.check_output([
                "ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load_file(ARGV[0], aliases: true))",
                str(root / ".github/workflows" / name)], text=True))
            return next(step.get("with", {}) for step in document["jobs"][job]["steps"] if "actions/checkout" in step.get("uses", ""))
        changes = checkout("pr-ci.yml", "changes")
        self.assertEqual((changes.get("fetch-depth"), changes.get("filter"), changes.get("sparse-checkout")), (0, "blob:none", "scripts"))
        self.assertEqual(checkout("repository-tooling.yml", "tooling").get("filter"), "blob:none")
        for name in ("release-set.yml", "recover-cutover.yml", "ios-release-build.yml", "release.yml"):
            self.assertNotIn("blob:none", (root / ".github/workflows" / name).read_text(), name)

    def test_first_party_actions_run_on_node_24(self):
        # Older majors of these actions target Node 20, which GitHub deprecates (forced onto Node 24 with warnings).
        root = Path(__file__).resolve().parents[1]
        paths = [*(root / ".github/workflows").glob("*.yml"), *(root / ".github/actions").glob("*/action.yml")]
        for path in sorted(paths):
            for action, version in re.findall(r"uses: (actions/(?:checkout|setup-node|setup-python))@v(\d+)", path.read_text()):
                with self.subTest(path=path.name, action=action):
                    self.assertGreaterEqual(int(version), 7)

    def test_component_builds_run_in_parallel_with_the_gates(self):
        # Builds consume only the release plan, so they start after prepare; build-gate joins every gate and
        # build, and publication (in relay, web, app order) waits for build-gate.
        root = Path(__file__).resolve().parents[1]
        jobs = json.loads(subprocess.check_output([
            "ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load_file(ARGV[0], aliases: true))",
            str(root / ".github/workflows/release-set.yml")], text=True))["jobs"]
        builds = ("relay-build", "web-build", "app-dry-build", "app-signed-build")
        for name in builds:
            with self.subTest(job=name):
                self.assertEqual(jobs[name]["needs"], "prepare")
        self.assertTrue({"contracts", "component-contracts", "agent", *builds} <= set(jobs["build-gate"]["needs"]))

    def test_buildx_builders_are_never_fixed_names(self):
        # A Docker daemon that outlives a job would reject a second builder with the same fixed name.
        root = Path(__file__).resolve().parents[1]
        for path in sorted([*(root / ".github/workflows").glob("*.yml"), *(root / ".github/actions").glob("*/action.yml")]):
            for line in path.read_text().splitlines():
                if "buildx create" in line:
                    with self.subTest(path=path.name):
                        self.assertNotIn("--name", line)

    def test_ui_performance_runs_on_its_own_schedule(self):
        # Measurement-only UI classes stay out of every PR and main-push suite and run serially on a schedule.
        root = Path(__file__).resolve().parents[1]
        def workflow(name):
            return json.loads(subprocess.check_output([
                "ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load_file(ARGV[0], aliases: true))",
                str(root / ".github/workflows" / name),
            ], text=True))
        # PR and main CI skip them in every shard through app/ci/test_shards.py (tested there).
        shards = (root / "app/ci/test_shards.py").read_text()
        classes = re.findall(r'"(TalariaUITests/\w+PerformanceUITests)"', shards)
        self.assertEqual(len(classes), 4)
        # The behavioural halves of those classes stay in every CI suite (resume, dense open/dismiss).
        functional = (root / "app/TalariaUITests/PerformanceUITests.swift").read_text()
        self.assertIn("final class PerformancePathUITests: PerformanceUITestCase", functional)
        self.assertNotIn("TalariaUITests/PerformancePathUITests", classes)
        scheduled = workflow("ui-performance.yml")
        self.assertIn("schedule", scheduled["on"])
        self.assertIn("workflow_dispatch", scheduled["on"])
        measure = json.dumps(scheduled["jobs"]["measure"])
        for name in classes:
            self.assertIn(f"-only-testing:{name}", measure)
        self.assertIn("-parallel-testing-enabled NO", measure)
        self.assertIn("scripts/report-performance-metrics", measure)

    def test_linux_jobs_running_ruby_tooling_set_up_ruby(self):
        # The pool image has no Ruby; the Mac did. Tag validation (cli.py prepare) and TestFlight upload
        # (publish.py app) shell out to Ruby, so every Linux job that runs them must install it first.
        root = Path(__file__).resolve().parents[1]
        needs_ruby = ("cli.py prepare", "publish.py app", "validate_release_tag", ".rb")
        for path in sorted((root / ".github/workflows").glob("*.yml")):
            document = json.loads(subprocess.check_output([
                "ruby", "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load_file(ARGV[0], aliases: true))", str(path),
            ], text=True))
            for name, job in document["jobs"].items():
                if "steps" not in job or job["runs-on"] == "maude-mac":
                    continue
                runs = "\n".join(step.get("run", "") for step in job["steps"])
                if any(marker in runs for marker in needs_ruby):
                    with self.subTest(workflow=path.name, job=name):
                        uses = {step.get("uses") for step in job["steps"]}
                        self.assertTrue(uses & {"./.github/actions/release-ruby", "ruby/setup-ruby@v1"}, uses)

    def test_selected_jobs_must_succeed(self):
        for dry, app, web, relay_changed in product((False, True), repeat=4):
            for stage in ("build", "publication"):
                needs = {name: {"result": "success"} for name in ("prepare", "contracts", "component-contracts", "agent", "build-gate")}
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
                for job in jobs + (["prepare", "contracts", "component-contracts", "agent"] if stage == "build" else ["prepare", "build-gate"]):
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

    def test_web_publication_confirms_npm_before_the_image_tag_is_pushed(self):
        """GHCR follows npm (published on the GitHub-hosted runner): a registry that does not serve the built
        tarballs must stop the self-hosted job before `skopeo copy` publishes the GHCR tag."""
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "npm").mkdir()
            (root / "npm/maudecode-talaria-web-1.0.0.tgz").write_bytes(b"server tarball")
            (root / "npm/maudecode-talaria-web-contracts-1.0.0.tgz").write_bytes(b"contracts tarball")
            plan = {"releaseSet": "a" * 40, "components": {"web": {"version": "1.0.0", "tag": "web-v1.0.0"}}}
            build = {"result": "success", "gate": "buildWeb", "sourceRevision": "a" * 40, "tag": "web-v1.0.0",
                     "image": "ghcr.io/maudecode/talaria-web@sha256:" + "b" * 64, "npm": "@maudecode/talaria-web@1.0.0"}
            commands = []

            def run(args, **kwargs):
                commands.append(args)
                if args[:2] == ["npm", "view"]:
                    # The registry serves other bytes under this version: the npm publication did not land as built.
                    return SimpleNamespace(returncode=0, stdout=json.dumps("sha512-other"), stderr="")
                self.fail("unexpected command " + " ".join(args))

            with patch.dict(os.environ, {"GITHUB_ACTOR": "bot", "GH_TOKEN": "t"}), \
                    patch("publish.subprocess.run", side_effect=run), patch("publish.write") as write:
                with self.assertRaisesRegex(ValueError, "readback differs"):
                    publish.web(plan, build, root, root / "out.json")
            self.assertFalse([args for args in commands if args[0] == "skopeo"])
            write.assert_not_called()

    def test_npm_publication_verifies_existing_versions_and_applies_the_channel_tag(self):
        """An already-published version is accepted only with identical bytes, and the channel dist-tag is always applied."""
        for channel, tag in (("stable", "web-v1.0.0"), ("experimental", "web-exp-v1.0.0")):
            with self.subTest(channel=channel), TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "npm").mkdir()
                server = root / "npm/maudecode-talaria-web-1.0.0.tgz"
                contracts = root / "npm/maudecode-talaria-web-contracts-1.0.0.tgz"
                server.write_bytes(b"server tarball " + channel.encode())
                contracts.write_bytes(b"contracts tarball " + channel.encode())
                component = {"version": "1.0.0", "tag": tag}
                build = {"npm": "@maudecode/talaria-web@1.0.0"}
                dist_tag = "experimental" if channel == "experimental" else "latest"
                registry, tags, commands, tampered = {}, {}, [], []

                def run(args, **kwargs):
                    commands.append(args)
                    if args[:2] == ["npm", "view"]:
                        entry = registry.get(args[2])
                        if entry is None:
                            return SimpleNamespace(returncode=1, stdout="", stderr="npm ERR! code E404")
                        return SimpleNamespace(returncode=0, stdout=json.dumps(entry["integrity"]), stderr="")
                    if args[:2] == ["npm", "publish"]:
                        path = Path(args[2])
                        package = "@maudecode/talaria-web-contracts" if "contracts" in path.name else "@maudecode/talaria-web"
                        self.assertNotIn(f"{package}@1.0.0", registry)
                        registry[f"{package}@1.0.0"] = {"integrity": "sha512-tampered" if tampered else publish._npm_integrity(path)}
                        tags.setdefault(package, {})[args[args.index("--tag") + 1]] = "1.0.0"
                        return SimpleNamespace(returncode=0, stdout="", stderr="")
                    self.fail("unexpected command " + " ".join(args))

                def check_output(args, **kwargs):
                    self.assertEqual(args[:2], ["npm", "view"])
                    return json.dumps(tags.get(args[2], {}))

                with patch.dict(os.environ, {"ACTIONS_ID_TOKEN_REQUEST_URL": "https://oidc.invalid",
                                              "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "synthetic"}), patch("publish.subprocess.run", side_effect=run), \
                        patch("publish.subprocess.check_output", side_effect=check_output), \
                        patch("publish.time.sleep"), patch("publish.NPM_READBACK_ATTEMPTS", 2):
                    self.assertEqual(publish.publish_npm(component, build, root), "@maudecode/talaria-web@1.0.0")
                    self.assertEqual([args[2] for args in commands if args[1] == "publish"], [str(contracts), str(server)])
                    self.assertEqual(tags["@maudecode/talaria-web"], {dist_tag: "1.0.0"})
                    # A retry accepts the same immutable bytes and existing channel tag.
                    before = len([args for args in commands if args[1] == "publish"])
                    publish.publish_npm(component, build, root)
                    self.assertEqual(len([args for args in commands if args[1] == "publish"]), before)
                    # Trusted publishing authorizes npm publish, not dist-tag mutation. A damaged tag fails closed.
                    tags["@maudecode/talaria-web"].pop(dist_tag)
                    with self.assertRaisesRegex(ValueError, "dist-tag"):
                        publish.publish_npm(component, build, root)
                    tags["@maudecode/talaria-web"][dist_tag] = "1.0.0"
                    # The other channel's bytes under the same version are refused before any publish.
                    server.write_bytes(b"server tarball other channel")
                    mutations = len([args for args in commands if args[1] == "publish"])
                    with self.assertRaisesRegex(ValueError, "different contents"):
                        publish.publish_npm(component, build, root)
                    self.assertEqual(len([args for args in commands if args[1] == "publish"]), mutations)
                    server.write_bytes(b"server tarball " + channel.encode())
                    # A registry that serves different bytes right after publication fails the readback.
                    registry.clear()
                    tampered.append(True)
                    with self.assertRaisesRegex(ValueError, "readback differs"):
                        publish.publish_npm(component, build, root)

    def test_npm_readback_waits_for_the_registry_to_serve_a_new_version(self):
        """npm answers 404 for a few minutes after publishing; the readback waits instead of failing."""
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "npm").mkdir()
            server = root / "npm/maudecode-talaria-web-1.0.0.tgz"
            contracts = root / "npm/maudecode-talaria-web-contracts-1.0.0.tgz"
            server.write_bytes(b"server tarball")
            contracts.write_bytes(b"contracts tarball")
            component, build = {"version": "1.0.0", "tag": "web-v1.0.0"}, {"npm": "@maudecode/talaria-web@1.0.0"}
            lookups = {}

            def run(args, **kwargs):
                spec = args[2]
                lookups[spec] = lookups.get(spec, 0) + 1
                if lookups[spec] <= 2:
                    return SimpleNamespace(returncode=1, stdout="", stderr="npm ERR! code E404")
                path = contracts if "contracts" in spec else server
                return SimpleNamespace(returncode=0, stdout=json.dumps(publish._npm_integrity(path)), stderr="")

            with patch("publish.subprocess.run", side_effect=run), \
                    patch("publish.subprocess.check_output", return_value=json.dumps({"latest": "1.0.0"})), \
                    patch("publish.time.sleep") as sleep:
                self.assertEqual(publish.verify_npm(component, build, root), "@maudecode/talaria-web@1.0.0")
            self.assertEqual(sleep.call_count, 4)
            # A version that never appears still fails, once the wait runs out.
            with patch("publish.subprocess.run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="npm ERR! code E404")), \
                    patch("publish.subprocess.check_output", return_value=json.dumps({})), \
                    patch("publish.time.sleep"), patch("publish.NPM_READBACK_ATTEMPTS", 3):
                with self.assertRaisesRegex(ValueError, "never became available"):
                    publish.verify_npm(component, build, root)

    def test_npm_12_array_wrapped_views_are_read_as_their_value(self):
        """npm 12 prints `npm view <spec> <field> --json` as a one-element array; identical bytes must still match."""
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "npm").mkdir()
            server = root / "npm/maudecode-talaria-web-1.0.0.tgz"
            contracts = root / "npm/maudecode-talaria-web-contracts-1.0.0.tgz"
            server.write_bytes(b"server tarball")
            contracts.write_bytes(b"contracts tarball")
            component, build = {"version": "1.0.0", "tag": "web-v1.0.0"}, {"npm": "@maudecode/talaria-web@1.0.0"}

            def run(args, **kwargs):
                path = contracts if "contracts" in args[2] else server
                return SimpleNamespace(returncode=0, stdout=json.dumps([publish._npm_integrity(path)]), stderr="")

            with patch.dict(os.environ, {"ACTIONS_ID_TOKEN_REQUEST_URL": "https://oidc.invalid", "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "synthetic"}), \
                    patch("publish.subprocess.run", side_effect=run), \
                    patch("publish.subprocess.check_output", return_value=json.dumps([{"latest": "1.0.0"}])):
                # Already published with these bytes: preflight accepts it and the readback confirms it.
                self.assertTrue(all(publish.preflight_npm(component, build, root)["published"].values()))
                self.assertEqual(publish.verify_npm(component, build, root), "@maudecode/talaria-web@1.0.0")


if __name__ == "__main__":
    unittest.main()
