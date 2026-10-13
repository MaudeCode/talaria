#!/usr/bin/env python3
"""Synthetic support records and faked Git, uv, Docker and release API; no network, Agent or credentials."""

import copy
import fcntl
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPOSITORY = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("agent_compatibility", REPOSITORY / "scripts/check-agent-compatibility.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def release(tag, version, digit):
    return {"releaseTag": tag, "version": version, "sourceRevision": digit * 40,
            "image": "docker.io/nousresearch/hermes-agent@sha256:" + digit * 64, "validatedBy": "TAL-349"}


RELEASES = [release("v2026.9.14", "0.21.3", "a"), release("v2026.9.21", "0.21.4", "b"), release("v2026.9.24", "0.21.5", "c")]
CANDIDATE = {key: value for key, value in release("v0.21.6", "0.21.6", "d").items() if key != "validatedBy"}


class FakeTools:
    """Answers the checker's subprocesses and records what it ran."""

    def __init__(self, test, root):
        self.root, self.commands = root, []
        self.head = {}  # fetched ref -> commit it resolves to
        self.requires_python = ">=3.11, <3.14"
        self.sidecar_failures = 0
        self.published = {"draft": False, "prerelease": False}
        self.image_revision = None  # defaults to the tested source
        self.tag_digest = None  # defaults to the recorded image digest
        self.stamp = None  # an unlabelled image's build stamp
        self.attempt_digest = None  # the rc.N-<tag> Docker tag's digest
        self.remote_tags = {}  # Agent Git tag -> peeled commit
        self.missing_tags = set()  # Docker tags whose pull fails with pull_error
        self.pull_error = 'failed to resolve reference "{ref}": {ref}: not found'  # Docker's answer for a missing tag
        self.fetched = None
        for name, replacement in (("run", self.run), ("check_output", self.check_output)):
            patcher = patch.object(checker.subprocess, name, side_effect=replacement)
            patcher.start()
            test.addCleanup(patcher.stop)
        patcher = patch("urllib.request.urlopen", side_effect=self.urlopen)
        self.urlopen_mock = patcher.start()
        test.addCleanup(patcher.stop)

    def run(self, command, **kwargs):
        command = [str(part) for part in command]
        self.commands.append(command)
        if command[:2] == ["git", "init"]:
            Path(command[-1]).mkdir(parents=True)
        if command[:2] == ["git", "-C"] and command[3] == "fetch":
            self.refspec = command[-1]
            self.fetched = command[-1].removeprefix("+").split(":", 1)[0]
        if command[:2] == ["git", "-C"] and command[3] == "checkout":
            (Path(command[2]) / "uv.lock").write_text(f'version = 1\nrequires-python = "{self.requires_python}"\n')
        if command[0] == "uv":
            venv = Path(kwargs["cwd"]) / ".venv/bin"
            venv.mkdir(parents=True)
            (venv / "python").touch()
        if command[0] == "hold-check":  # an extra --command: can another run take the release away meanwhile?
            with open(command[1]) as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.release_free = True
                except BlockingIOError:
                    self.release_free = False
            return subprocess.CompletedProcess(command, int(command[2]))
        if command[0].endswith("test.sh"):
            failures = self.sidecar_failures
            for part in command:
                if part.startswith("--junitxml="):
                    Path(part.split("=", 1)[1]).write_text(f'<testsuites><testsuite tests="40" failures="{failures}" errors="0" skipped="1"/></testsuites>')
            if failures:
                raise subprocess.CalledProcessError(1, command)
        if command[:2] == ["docker", "pull"] and command[2].rsplit(":", 1)[-1] in self.missing_tags:
            stderr = f"Error response from daemon: {self.pull_error.format(ref=command[2])}\n"
            if kwargs.get("check"):
                raise subprocess.CalledProcessError(1, command, stderr=stderr)
            return subprocess.CompletedProcess(command, 1, stderr=stderr)
        if command[:2] == ["docker", "pull"]:
            return subprocess.CompletedProcess(command, 0, stderr="")
        if command[:3] == ["git", "-C", str(self.root)]:
            return subprocess.CompletedProcess(command, 0, stdout="e" * 40 + "\n")
        return subprocess.CompletedProcess(command, 0)

    def check_output(self, command, **kwargs):
        command = [str(part) for part in command]
        if command[-2:] == ["rev-parse", "HEAD"]:
            return self.head.get(self.fetched, self.fetched.rsplit("/", 1)[-1] if len(self.fetched) == 40 else self.recorded_sha())
        if "platform.python_version()" in command[-1]:
            return "3.13.7\n"
        if command[:3] == ["docker", "image", "inspect"]:
            if "@" not in command[3]:
                attempt = ":rc." in command[3]
                digest = (self.attempt_digest if attempt else self.tag_digest) or self.recorded()["image"].rsplit("@", 1)[1]
                return json.dumps([{"RepoDigests": [f"nousresearch/hermes-agent@{digest}"]}])
            revision = self.image_revision or self.recorded()["sourceRevision"]
            return json.dumps([{"Config": {"Labels": None if self.stamp else {"org.opencontainers.image.revision": revision}}}])
        if command[:2] == ["docker", "run"] and command[-1] == "/opt/hermes/install-stamp.json":
            return json.dumps(self.stamp)
        if command[:2] == ["git", "ls-remote"]:
            tag = command[-2].removeprefix("refs/tags/")
            return f"{'1' * 40}\trefs/tags/{tag}\n{self.remote_tags[tag]}\trefs/tags/{tag}^{{}}\n" if tag in self.remote_tags else ""
        raise AssertionError(f"unexpected command {command}")

    def recorded(self):
        tag = self.fetched.removeprefix("refs/tags/")
        return next(entry for entry in [*RELEASES, CANDIDATE] if entry["releaseTag"] == tag)

    def recorded_sha(self):
        return self.recorded()["sourceRevision"]

    def urlopen(self, request, timeout):
        tag = request.full_url.rsplit("/", 1)[-1]
        return io.BytesIO(json.dumps({"tag_name": tag, **self.published}).encode())

    def ran(self, program):
        return [command for command in self.commands if Path(command[0]).name == program or command[0] == program]


class CheckerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="talaria-agent-checker-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "web/sidecar").mkdir(parents=True)
        self.write(RELEASES, active=RELEASES[1])
        self.cache = self.root / "cache/talaria/agents"
        patcher = patch.dict(os.environ, {"XDG_CACHE_HOME": str(self.root / "cache")})
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(checker, "ROOT", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tools = FakeTools(self, self.root)
        patcher = patch("sys.stdout", new_callable=io.StringIO)  # Each run prints its receipt.
        self.stdout = patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, releases, active):
        record = {"schemaVersion": 1, "releases": releases}
        (self.root / "web/sidecar/agent_support.json").write_text(json.dumps(record))
        pin = {"x-talaria": {key: active[key] for key in ("releaseTag", "version", "sourceRevision")},
               "services": {"hermes-agent": {"image": active["image"]}}}
        (self.root / "web/sidecar/agent_dependency.json").write_text(json.dumps(pin))

    def main(self, *argv):
        with patch("sys.argv", ["check-agent-compatibility.py", *argv]):
            checker.main()

    def receipt(self, *argv):
        path = self.root / "receipts/result.json"
        try:
            self.main(*argv, "--receipt", str(path))
        finally:
            self.last = json.loads(path.read_text()) if path.exists() else None
        return self.last

    def test_record_that_cannot_claim_three_version_support_fails_before_provisioning(self):
        def changed(index, **values):
            releases = copy.deepcopy(RELEASES)
            releases[index].update(values)
            return releases

        cases = {
            "two releases": (RELEASES[:2], RELEASES[1]),
            "four releases": ([*RELEASES, release("v2026.9.11", "0.21.2", "f")], RELEASES[1]),
            "duplicate source": (changed(2, sourceRevision="a" * 40), RELEASES[1]),
            "duplicate tag": (changed(2, releaseTag="v2026.9.14"), RELEASES[1]),
            "duplicate version": (changed(2, version="0.21.3"), RELEASES[1]),
            "duplicate image": (changed(2, image=RELEASES[0]["image"]), RELEASES[1]),
            "prerelease version": (changed(2, version="0.21.5rc1"), RELEASES[1]),
            "mutable image": (changed(2, image="docker.io/nousresearch/hermes-agent:latest"), RELEASES[1]),
            "branch source": (changed(2, sourceRevision="main"), RELEASES[1]),
            "unvalidated entry": (changed(2, validatedBy=""), RELEASES[1]),
            "active pin outside": (RELEASES, release("v2026.9.11", "0.21.2", "f")),
            "active pin image differs": (RELEASES, {**RELEASES[1], "image": RELEASES[1]["image"][:-1] + "f"}),
        }
        for name, (releases, active) in cases.items():
            for argv in (["--list"], ["--skip-docker"], ["--release", "v2026.9.21", "--skip-docker"]):
                with self.subTest(name, argv=argv):
                    self.write(releases, active)
                    self.tools.commands.clear()
                    with self.assertRaises(ValueError):
                        self.main(*argv)
                    self.assertEqual(self.tools.commands, [])

    def test_list_prints_the_supported_tags(self):
        self.main("--list")
        self.assertEqual(json.loads(self.stdout.getvalue()), ["v2026.9.14", "v2026.9.21", "v2026.9.24"])

    def test_unsupported_release_selection_is_refused(self):
        with self.assertRaisesRegex(ValueError, "not a supported release"):
            self.main("--release", "v0.21.6", "--skip-docker")

    def test_supported_release_passes_with_a_complete_receipt(self):
        receipt = self.receipt("--release", "v2026.9.14")
        self.assertEqual(receipt, {
            "kind": "supported", **{key: RELEASES[0][key] for key in checker.IDENTITY}, "webRevision": "e" * 40,
            "python": "3.13.7", "tests": {"passed": 39, "failed": 0, "skipped": 1}, "imageVerified": True,
            "result": "success", "diagnostics": "result.junit.xml"})
        # The release tag lands as a local tag so git-derived Agent versions can resolve it.
        self.assertEqual(self.tools.refspec, "+refs/tags/v2026.9.14:refs/tags/v2026.9.14")
        probe = next(command for command in self.tools.commands if command[-2:] == [str(self.root / "releases/agent_probe.py"), "0.21.3"])
        self.assertTrue(probe)
        self.assertIn(["uv", "sync", "--frozen", "--no-dev", "--extra", "mcp", "--python", "3.13"], self.tools.commands)
        self.assertEqual(len([command for command in self.tools.commands if command[:2] == ["docker", "run"]]), 1)

    def test_active_pin_is_the_default_selection(self):
        self.assertEqual(self.receipt("--skip-docker")["releaseTag"], "v2026.9.21")
        self.assertEqual(self.last["kind"], "active")

    def test_moved_tag_fails_with_a_receipt(self):
        self.tools.head["refs/tags/v2026.9.24"] = "f" * 40
        with self.assertRaisesRegex(RuntimeError, "tag moved"):
            self.receipt("--release", "v2026.9.24", "--skip-docker")
        self.assertEqual(self.last["result"], "failure")
        self.assertIn("f" * 40, self.last["failure"])
        self.assertEqual(self.tools.ran("uv"), [])

    def test_unpublished_or_prerelease_tag_fails_before_provisioning(self):
        for published in ({"draft": True, "prerelease": False}, {"draft": False, "prerelease": True}, {}):
            with self.subTest(published):
                self.tools.published = published
                self.tools.commands.clear()
                with self.assertRaisesRegex(RuntimeError, "published stable"):
                    self.receipt("--release", "v2026.9.24", "--skip-docker")
                self.assertEqual(self.tools.ran("uv"), [])
                self.assertIsNone(self.tools.fetched)

    def test_unverified_release_image_fails(self):
        for attribute, value, message in (("tag_digest", "sha256:" + "f" * 64, "tag image"),
                                          ("image_revision", "f" * 40, "source label")):
            with self.subTest(attribute):
                setattr(self.tools, attribute, value)
                with self.assertRaisesRegex(RuntimeError, message):
                    self.receipt("--release", "v2026.9.24")
                self.assertFalse(self.last["imageVerified"])
                setattr(self.tools, attribute, None)

    def test_unlabelled_image_is_verified_by_its_build_stamp_and_release_attempt(self):
        sha = RELEASES[2]["sourceRevision"]
        self.tools.stamp = {"commit": sha, "branch": "rc.4-v2026.9.24", "dirty": False, "source": "ci"}
        self.tools.tag_digest = "sha256:" + "f" * 64  # the release tag kept an earlier attempt's image
        self.tools.remote_tags["rc.4-v2026.9.24"] = sha
        self.assertTrue(self.receipt("--release", "v2026.9.24")["imageVerified"])
        self.assertIn(["docker", "pull", "docker.io/nousresearch/hermes-agent:rc.4-v2026.9.24"], self.tools.commands)
        for change, message in (({"remote_tags": {"rc.4-v2026.9.24": "f" * 40}}, "tag image"),
                                ({"attempt_digest": "sha256:" + "e" * 64}, "tag image"),
                                ({"stamp": {**self.tools.stamp, "branch": "rc.4-v2026.9.21"}}, "tag image"),
                                ({"stamp": {**self.tools.stamp, "commit": "f" * 40}}, "source label"),
                                ({"stamp": {**self.tools.stamp, "dirty": True}}, "clean CI build"),
                                ({"stamp": {**self.tools.stamp, "source": "local"}}, "clean CI build")):
            with self.subTest(change), patch.multiple(self.tools, **change):
                with self.assertRaisesRegex(RuntimeError, message):
                    self.receipt("--release", "v2026.9.24")
                self.assertFalse(self.last["imageVerified"])

    def test_release_without_a_plain_docker_tag_is_verified_by_its_release_attempt(self):
        sha = RELEASES[2]["sourceRevision"]
        self.tools.stamp = {"commit": sha, "branch": "rc.15-v2026.9.24", "dirty": False, "source": "ci"}
        self.tools.remote_tags["rc.15-v2026.9.24"] = sha
        self.tools.missing_tags = {"v2026.9.24"}
        self.assertTrue(self.receipt("--release", "v2026.9.24")["imageVerified"])
        self.assertIn(["docker", "pull", "docker.io/nousresearch/hermes-agent:rc.15-v2026.9.24"], self.tools.commands)
        for change in ({"missing_tags": {"v2026.9.24", "rc.15-v2026.9.24"}},
                       {"attempt_digest": "sha256:" + "e" * 64},
                       {"remote_tags": {}}):
            with self.subTest(change), patch.multiple(self.tools, **change):
                with self.assertRaisesRegex(RuntimeError, "tag image does not match"):
                    self.receipt("--release", "v2026.9.24")
                self.assertFalse(self.last["imageVerified"])
        with patch.multiple(self.tools, pull_error="manifest for {ref} not found: manifest unknown: manifest unknown"):
            self.assertTrue(self.receipt("--release", "v2026.9.24")["imageVerified"])  # the classic image store
        for error in ("toomanyrequests: rate limit exceeded",
                      'error getting credentials - err: exec: "docker-credential-gone": executable file not found in $PATH'):
            with self.subTest(error), patch.multiple(self.tools, pull_error=error):
                with self.assertRaises(subprocess.CalledProcessError):  # only a missing tag is skipped
                    self.receipt("--release", "v2026.9.24")
                self.assertFalse(self.last["imageVerified"])

    def test_failed_candidate_reports_counts_and_leaves_the_record_intact(self):
        record = (self.root / "web/sidecar/agent_support.json").read_bytes()
        self.tools.sidecar_failures = 2
        self.tools.requires_python = ">=3.11,<3.15"
        with self.assertRaises(subprocess.CalledProcessError):
            self.receipt("--identity", json.dumps(CANDIDATE), "--skip-docker")
        self.assertEqual(self.last["kind"], "candidate")
        self.assertEqual((self.last["sourceRevision"], self.last["webRevision"]), ("d" * 40, "e" * 40))
        self.assertEqual(self.last["tests"], {"passed": 37, "failed": 2, "skipped": 1})
        self.assertEqual(self.last["result"], "failure")
        self.assertTrue((self.root / "receipts" / self.last["diagnostics"]).is_file())
        self.assertIn(["uv", "sync", "--frozen", "--no-dev", "--extra", "mcp", "--python", "3.14"], self.tools.commands)
        self.assertEqual((self.root / "web/sidecar/agent_support.json").read_bytes(), record)

    def test_candidate_identity_must_be_immutable(self):
        with self.assertRaises(ValueError):
            self.main("--identity", json.dumps({**CANDIDATE, "sourceRevision": "main"}), "--skip-docker")
        self.assertEqual(self.tools.commands, [])

    def test_main_canary_uses_an_exact_commit_and_its_own_python(self):
        self.write([], RELEASES[1])  # A canary never depends on, or enters, the stable record.
        receipt = self.receipt("--main", "9" * 40, "--python", "3.14")
        self.assertEqual((receipt["kind"], receipt["sourceRevision"], receipt["result"]), ("canary", "9" * 40, "success"))
        self.assertNotIn("releaseTag", receipt)
        self.assertEqual(self.tools.fetched, "9" * 40)
        self.assertIn(["uv", "sync", "--frozen", "--no-dev", "--extra", "mcp", "--python", "3.14"], self.tools.commands)
        self.assertEqual(next(command for command in self.tools.commands if command[-1].endswith("agent_probe.py"))[-1],
                         str(self.root / "releases/agent_probe.py"))
        self.assertEqual(self.tools.ran("docker"), [])
        self.tools.urlopen_mock.assert_not_called()
        with self.assertRaisesRegex(ValueError, "exact commit"):
            self.main("--main", "main")

    def provisioned(self):
        return [command[-1] for command in self.tools.commands if command[:2] == ["git", "init"]]

    def test_supported_release_is_cached_and_reused(self):
        self.receipt("--release", "v2026.9.14", "--skip-docker")
        self.assertEqual(self.provisioned(), [str(self.cache / "v2026.9.14")])
        self.tools.commands.clear()
        self.tools.urlopen_mock.reset_mock()
        receipt = self.receipt("--release", "v2026.9.14", "--skip-docker")
        self.assertEqual((receipt["result"], receipt["tests"]["passed"]), ("success", 39))
        self.assertEqual((self.provisioned(), self.tools.ran("uv")), ([], []))
        self.tools.urlopen_mock.assert_not_called()
        self.assertEqual(len(self.tools.ran("test.sh")), 1)
        self.assertTrue(any(command[-2:] == [str(self.root / "releases/agent_probe.py"), "0.21.3"] for command in self.tools.commands))

    def test_stale_or_broken_cache_entry_is_reprovisioned(self):
        self.receipt("--release", "v2026.9.14", "--skip-docker")
        marker = self.cache / "v2026.9.14.ready"
        for damage in (lambda: marker.write_text(json.dumps({**json.loads(marker.read_text()), "sourceRevision": "f" * 40})),
                       lambda: marker.write_text(json.dumps({**json.loads(marker.read_text()), "sync": ["uv", "sync"]})),
                       lambda: marker.write_text("{"),
                       lambda: (self.cache / "v2026.9.14/.venv/bin/python").unlink()):
            with self.subTest(damage):
                damage()
                self.tools.commands.clear()
                self.receipt("--release", "v2026.9.14", "--skip-docker")
                self.assertEqual(self.provisioned(), [str(self.cache / "v2026.9.14")])
        self.tools.commands.clear()
        self.receipt("--release", "v2026.9.14", "--skip-docker", "--python", "3.12")
        self.assertIn(["uv", "sync", "--frozen", "--no-dev", "--extra", "mcp", "--python", "3.12"], self.tools.commands)
        self.tools.commands.clear()
        self.receipt("--release", "v2026.9.14", "--skip-docker")  # back to the newest Python the lockfile allows
        self.assertIn(["uv", "sync", "--frozen", "--no-dev", "--extra", "mcp", "--python", "3.13"], self.tools.commands)

    def test_release_leaving_the_record_is_deleted_unless_another_run_holds_it(self):
        self.receipt("--release", "v2026.9.14", "--skip-docker")
        (self.cache / "v2026.9.14.python").mkdir()  # an interpreter uv downloaded for it
        self.receipt("--release", "v2026.9.24", "--skip-docker")
        newer = release("v0.21.6", "0.21.6", "d")
        self.write([*RELEASES[1:], newer], active=RELEASES[1])
        with open(self.cache / "v2026.9.24.lock") as held:
            fcntl.flock(held, fcntl.LOCK_SH)
            self.receipt("--release", "v2026.9.21", "--skip-docker")
            self.assertTrue((self.cache / "v2026.9.24").is_dir())  # still in the record
            self.write([RELEASES[1], newer, release("v0.21.7", "0.21.7", "8")], active=RELEASES[1])
            self.receipt("--release", "v2026.9.21", "--skip-docker")
            self.assertTrue((self.cache / "v2026.9.24.ready").is_file())  # in use elsewhere
        self.assertEqual({path.name for path in self.cache.iterdir() if path.name.startswith("v2026.9.14")}, {"v2026.9.14.lock"})
        self.receipt("--release", "v2026.9.21", "--skip-docker")
        # Lock files stay, so every run locks the same file for a tag.
        self.assertEqual(sorted(path.name for path in self.cache.iterdir()),
                         ["v2026.9.14.lock", "v2026.9.21", "v2026.9.21.lock", "v2026.9.21.ready", "v2026.9.24.lock"])

    def test_candidate_and_canary_checkouts_are_removed(self):
        self.receipt("--identity", json.dumps(CANDIDATE), "--skip-docker")
        self.write([], RELEASES[1])
        self.receipt("--main", "9" * 40)
        checkouts = self.provisioned()
        self.assertEqual(len(checkouts), 2)
        for checkout in checkouts:
            self.assertFalse(Path(checkout).exists())
            self.assertNotEqual(Path(checkout).parent.parent, self.cache)

    def test_extra_command_holds_the_release_and_returns_its_status(self):
        lock, path = self.cache / "v2026.9.21.lock", self.root / "receipts/result.json"
        # --command takes the rest of the arguments, so the receipt goes first.
        self.main("--receipt", str(path), "--skip-docker", "--skip-sidecar-tests", "--command", "hold-check", str(lock), "0")
        self.assertEqual((json.loads(path.read_text())["result"], self.tools.release_free, self.tools.ran("test.sh")),
                         ("success", False, []))
        with self.assertRaises(SystemExit) as raised:
            self.main("--receipt", str(path), "--skip-docker", "--skip-sidecar-tests", "--command", "hold-check", str(lock), "3")
        self.assertEqual((raised.exception.code, json.loads(path.read_text())["result"]), (3, "failure"))

    def test_lockfile_selects_the_newest_allowed_python(self):
        for requires, expected in ((">=3.11, <3.14", "3.13"), (">=3.11,<3.15", "3.14"), (">=3.12,<=3.12", "3.12"),
                                   ("==3.11.*", "3.11"), (">=3.11,!=3.14.*", "3.13"), ("~=3.13", "3.14"),
                                   (">=3.11,<4", "3.14"), ("<=3.13", "3.13"), (">=3.11.4,<3.13", "3.12"), ("~=3.12.1", "3.12")):
            with self.subTest(requires), tempfile.TemporaryDirectory() as agent:
                (Path(agent) / "uv.lock").write_text(f'requires-python = "{requires}"\n')
                self.assertEqual(checker.lockfile_python(Path(agent)), expected)
        with tempfile.TemporaryDirectory() as agent:
            (Path(agent) / "uv.lock").write_text('requires-python = ">=3.15"\n')
            with self.assertRaisesRegex(RuntimeError, "no supported Python"):
                checker.lockfile_python(Path(agent))


class CommittedRecordTests(unittest.TestCase):
    def test_committed_record_claims_three_version_support(self):
        releases = checker.supported_releases(REPOSITORY)
        self.assertEqual(len(releases), 3)
        self.assertIn(checker.active_pin(REPOSITORY), releases)


if __name__ == "__main__":
    unittest.main()
