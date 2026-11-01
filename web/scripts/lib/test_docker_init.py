"""Root-phase ownership alignment in docker_init.bash, run from the shipped script against disposable state.

The entrypoint's helpers and guards are extracted verbatim; only the hardcoded home is mapped into a temporary
directory. PATH stubs stand in for chown, find, id, getent, groupmod and usermod, so every error class is forced
deterministically and usermod never runs on the host.
"""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "docker_init.bash"
HOME = "/home/hermeswebui"
ENOENT = "No such file or directory"

# Each stub appends one JSON line per call to $STUB_LOG, then follows its $STUB_* instructions.
STUB = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, shutil, sys
    name, args = os.path.basename(sys.argv[0]), sys.argv[1:]
    with open(os.environ["STUB_LOG"], "a") as log:
        log.write(json.dumps([name, *args]) + "\\n")
    real = os.environ.get("STUB_REAL_" + name.upper())
    if name == "chown":
        target = os.environ.get("STUB_TARGET")
        if target in args:
            mode = os.environ.get("STUB_CHOWN", "")
            if mode == "vanish":
                if os.path.lexists(target):
                    shutil.rmtree(target) if os.path.isdir(target) and not os.path.islink(target) else os.remove(target)
            elif mode == "silent":
                sys.exit(1)
            elif mode:
                sys.stderr.write(mode.replace("{}", target) + "\\n")
                sys.exit(1)
        if os.environ.get("STUB_CHOWN_DRY"):
            sys.exit(0)
    if name == "find":
        code = os.spawnv(os.P_WAIT, real, [real, *args])
        extra = os.environ.get("STUB_FIND_STDERR")
        if extra:
            sys.stderr.write(extra + "\\n")
            sys.exit(1)
        sys.exit(code)
    if name in ("groupmod", "usermod"):
        if any(" ".join(args).startswith(prefix) for prefix in os.environ.get("STUB_FAIL", "").split("|") if prefix):
            sys.stderr.write(name + ": synthetic failure\\n")
            sys.exit(1)
        sys.exit(0)
    if name == "id":
        print(os.environ["STUB_ID_" + args[0][1:].upper()])
        sys.exit(0)
    if name == "getent":
        print("hermeswebui:x:1024:1024::" + os.environ["STUB_PASSWD_HOME"] + ":/bin/bash")
        sys.exit(0)
    os.execv(real, [real, *args])
""")


def entrypoint_code():
    """Every function and top-level helper string from the shipped script."""
    text = SCRIPT.read_text()
    parts = re.findall(r"^[A-Za-z_]\w*\(\) \{\n.*?^\}\n", text, re.M | re.S)
    parts += re.findall(r"^_\w+='\n.*?^'\n", text, re.M | re.S)
    return "\n".join(parts)


def startup_guard(name):
    """The entrypoint's own call of `name`, including its fatal error branch."""
    match = re.search(rf"^\s*{name} .*\|\| error_exit .*$", SCRIPT.read_text(), re.M)
    assert match, f"docker_init.bash has no guarded {name} call"
    return match.group(0).strip()


class HomeFixture(unittest.TestCase):
    """A home shared with a running Agent: state, a git checkout, an Agent source tree and symlinks."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="talaria-docker-init-")
        root = Path(self.temporary.name)
        self.home = root / "home"
        self.outside = root / "outside"
        stubs = root / "stubs"
        self.log = root / "calls.jsonl"
        for path in (self.home, self.outside, stubs):
            path.mkdir()
        self.env = {"PATH": f"{stubs}:{os.environ['PATH']}", "STUB_LOG": str(self.log), "LC_ALL": "C",
                    "WANTED_UID": str(os.getuid()), "WANTED_GID": str(os.getgid())}
        for name in ("chown", "find", "id", "getent", "groupmod", "usermod"):
            (stubs / name).write_text(STUB)
            (stubs / name).chmod(0o755)
            if real := shutil.which(name):
                self.env["STUB_REAL_" + name.upper()] = real
        for relative in (".hermes/state.db", ".hermes/sessions/a.json", ".hermes/churn/atomic.tmp",
                         ".hermes/churn/keep.json", "project/.git/HEAD", "project/.git/objects/pack/p.pack",
                         "project/src/main.py", ".hermes/hermes-agent/README.md", ".hermes/hermes-agent/.git/HEAD"):
            path = self.home / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture")
        (self.outside / "secret").write_text("outside")
        (self.home / "link-to-outside").symlink_to(self.outside)
        (self.home / "dangling").symlink_to(self.outside / "missing")

    def tearDown(self):
        if self.home.exists():
            for path in [self.home, *self.home.rglob("*")]:
                if path.is_dir() and not path.is_symlink():
                    path.chmod(0o755)
        self.temporary.cleanup()

    def run_entrypoint(self, command, **env):
        script = (entrypoint_code() + "\n" + command + "\necho STARTUP-CONTINUES\n").replace(HOME, str(self.home))
        self.log.write_text("")
        result = subprocess.run(["bash", "-c", script], env={**self.env, **env}, text=True, capture_output=True)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return result, calls

    def chowned(self, calls, owner):
        """Paths passed to chown with `owner`, excluding the per-entry retries of a failed batch."""
        return {Path(path) for call in calls if call[:3] == ["chown", "-h", owner] for path in call[3:]}

    def assertStarts(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("STARTUP-CONTINUES", result.stdout)

    def assertFails(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("STARTUP-CONTINUES", result.stdout)
        self.assertIn(message, result.stdout + result.stderr)

    def eligible(self):
        """Home entries the main walk must own: everything except .git trees and the Agent source."""
        skipped = (self.home / ".hermes/hermes-agent",)
        return {self.home} | {path for path in self.home.rglob("*")
                              if ".git" not in path.relative_to(self.home).parts
                              and not any(path == s or s in path.parents for s in skipped)}



class OwnershipWalk(HomeFixture):
    def test_child_removed_between_find_and_chown_does_not_stop_startup(self):
        vanished = self.home / ".hermes/churn/atomic.tmp"
        result, calls = self.run_entrypoint(startup_guard("chown_home_hermeswebui"),
                                            STUB_CHOWN="vanish", STUB_TARGET=str(vanished))
        self.assertStarts(result)
        self.assertFalse(vanished.exists())
        owner = f"{os.getuid()}:{os.getgid()}"
        surviving = self.eligible()
        self.assertTrue(surviving <= self.chowned(calls, owner), surviving - self.chowned(calls, owner))
        # Every surviving entry was chowned by a successful call: the retry covers the batch the vanished entry broke.
        failed_batch = next(call for call in calls if call[0] == "chown" and str(vanished) in call)
        for path in failed_batch[3:]:
            if path != str(vanished):
                self.assertIn(["chown", "-h", owner, path], calls)

    def test_main_walk_prunes_git_agent_source_and_never_follows_symlinks(self):
        result, calls = self.run_entrypoint(startup_guard("chown_home_hermeswebui"))
        self.assertStarts(result)
        walked = self.chowned(calls, f"{os.getuid()}:{os.getgid()}")
        self.assertEqual(walked, self.eligible())
        self.assertIn(self.home / "link-to-outside", walked)
        self.assertIn(self.home / "dangling", walked)
        self.assertFalse(any(self.outside in path.parents for path in walked))

    def test_directory_removed_before_find_opens_it_does_not_stop_startup(self):
        gone = self.home / ".hermes/churn"
        shutil.rmtree(gone)
        result, _ = self.run_entrypoint(startup_guard("chown_home_hermeswebui"),
                                        STUB_FIND_STDERR=f"find: '{gone}': {ENOENT}")
        self.assertStarts(result)

    def test_real_failures_still_stop_startup(self):
        target = str(self.home / ".hermes/state.db")
        guard = startup_guard("chown_home_hermeswebui")
        cases = {
            "EPERM": dict(STUB_CHOWN="chown: changing ownership of '{}': Operation not permitted"),
            "EACCES": dict(STUB_CHOWN="chown: cannot access '{}': Permission denied"),
            "EROFS": dict(STUB_CHOWN="chown: changing ownership of '{}': Read-only file system"),
            "EIO": dict(STUB_CHOWN="chown: changing ownership of '{}': Input/output error"),
            "ENOTDIR": dict(STUB_CHOWN="chown: cannot access '{}': Not a directory"),
            "unreadable chown diagnostic": dict(STUB_CHOWN="silent"),
            "ENOENT beside another diagnostic": dict(STUB_CHOWN="chown: warning\nchown: cannot access '{}': " + ENOENT),
            "find EIO": dict(STUB_FIND_STDERR=f"find: '{target}': Input/output error"),
            "find ENOENT outside the home": dict(STUB_FIND_STDERR=f"find: '/elsewhere/x': {ENOENT}"),
            "vanished root": dict(STUB_FIND_STDERR=f"find: '{self.home}': {ENOENT}"),
        }
        for name, env in cases.items():
            with self.subTest(name):
                result, _ = self.run_entrypoint(guard, STUB_TARGET=target, **env)
                self.assertFails(result, f"Failed to set owner of {self.home}")
        with self.subTest("root vanished before chown"):
            result, _ = self.run_entrypoint(guard, STUB_CHOWN="vanish", STUB_TARGET=str(self.home))
            self.assertFails(result, f"Failed to set owner of {self.home}")
        with self.subTest("missing root"):
            shutil.rmtree(self.home, ignore_errors=True)
            result, _ = self.run_entrypoint(guard)
            self.assertFails(result, f"Failed to set owner of {self.home}")

    @unittest.skipIf(os.geteuid() == 0, "root bypasses directory permissions")
    def test_unreadable_directory_still_stops_startup(self):
        locked = self.home / ".hermes/sessions"
        locked.chmod(0)
        result, _ = self.run_entrypoint(startup_guard("chown_home_hermeswebui"))
        self.assertFails(result, f"Failed to set owner of {self.home}")


@unittest.skipIf(os.geteuid() == 0, "root bypasses the read-only Agent source permission")
class IdentityChange(HomeFixture):
    """usermod's own home walk is skipped; the entrypoint restores the home and migrates old-UID files itself."""

    def align(self, old_uid="1024", fail="", readonly_root="false", **env):
        stubbed = dict(STUB_CHOWN_DRY="1", STUB_ID_U=old_uid, STUB_ID_G="1024", STUB_FAIL=fail,
                       STUB_PASSWD_HOME="/srv/configured-home", WANTED_UID="2000", WANTED_GID="3000")
        return self.run_entrypoint(f"align_hermeswebui_identity {readonly_root}", **{**stubbed, **env})

    def accounts(self, calls):
        return [call for call in calls if call[0] in ("groupmod", "usermod")]

    def test_uid_change_skips_usermod_walk_restores_home_and_migrates_pruned_trees(self):
        (self.home / ".hermes/hermes-agent").chmod(0o755)
        result, calls = self.align(old_uid=str(os.getuid()))
        self.assertStarts(result)
        accounts = self.accounts(calls)
        self.assertEqual(accounts[0], ["groupmod", "-o", "-g", "3000", "hermeswebui"])
        self.assertEqual(accounts[1][:4], ["usermod", "-o", "-u", "2000"])
        self.assertEqual(accounts[1][4], "-d")
        self.assertFalse(os.path.lexists(accounts[1][5]), "usermod -u must not see an existing home to walk")
        self.assertEqual(accounts[2], ["usermod", "-d", "/srv/configured-home", "hermeswebui"])
        self.assertEqual(len(accounts), 3)
        self.assertEqual(self.chowned(calls, "2000:3000"), self.eligible())
        migrated = self.chowned(calls, "2000")
        for path in ("project/.git/HEAD", "project/.git/objects/pack/p.pack", ".hermes/hermes-agent/README.md",
                     ".hermes/hermes-agent/.git/HEAD", "link-to-outside"):
            self.assertIn(self.home / path, migrated)
        self.assertFalse(any(self.outside in path.parents for path in migrated))
        self.assertTrue(all(call[:2] == ["find", str(self.home)] for call in calls if call[0] == "find"))
        uid_walk = next(call for call in calls if call[0] == "find" and "-uid" in call)
        self.assertEqual(uid_walk[uid_walk.index("-uid") + 1], str(os.getuid()))

    def test_read_only_agent_source_is_not_migrated(self):
        agent = self.home / ".hermes/hermes-agent"
        agent.chmod(0o555)
        result, calls = self.align(old_uid=str(os.getuid()))
        self.assertStarts(result)
        migrated = self.chowned(calls, "2000")
        self.assertIn(self.home / "project/.git/HEAD", migrated)
        self.assertFalse(any(path == agent or agent in path.parents for path in migrated))

    def test_unchanged_uid_skips_usermod_and_migration(self):
        result, calls = self.align(old_uid="2000")
        self.assertStarts(result)
        self.assertEqual(self.accounts(calls), [["groupmod", "-o", "-g", "3000", "hermeswebui"]])
        self.assertEqual(self.chowned(calls, "2000:3000"), self.eligible())
        self.assertEqual(self.chowned(calls, "2000"), set())

    def test_failed_uid_change_still_restores_home(self):
        result, calls = self.align(fail="-o -u")
        self.assertFails(result, "Failed to set UID of hermeswebui user")
        self.assertEqual(self.accounts(calls)[-1], ["usermod", "-d", "/srv/configured-home", "hermeswebui"])
        self.assertFalse(any(call[0] == "chown" for call in calls))

    def test_failed_home_restore_and_group_change_stop_startup(self):
        result, _ = self.align(fail="-d /srv/configured-home")
        self.assertFails(result, "Failed to restore home directory of hermeswebui user")
        result, calls = self.align(fail="-o -g")
        self.assertFails(result, "Failed to set GID of hermeswebui user")
        self.assertEqual(len(self.accounts(calls)), 1)

    def test_read_only_root_keeps_matching_identity_and_rejects_a_change(self):
        result, calls = self.align(old_uid="2000", readonly_root="true", STUB_ID_G="3000")
        self.assertStarts(result)
        self.assertEqual(self.accounts(calls), [])
        result, calls = self.align(readonly_root="true")
        self.assertFails(result, "read-only root fs")
        self.assertEqual(self.accounts(calls), [])

    def test_migration_failure_stops_startup(self):
        target = str(self.home / "project/.git/HEAD")
        result, _ = self.align(old_uid=str(os.getuid()), STUB_TARGET=target,
                               STUB_CHOWN="chown: changing ownership of '{}': Read-only file system")
        self.assertFails(result, "Failed to")


if __name__ == "__main__":
    unittest.main()
