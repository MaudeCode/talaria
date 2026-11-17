"""Release request from the dispatched version and commit (TAL-2342): local Git only, no credentials or publication."""

import subprocess
import tempfile
import unittest
from pathlib import Path

from autorelease import request_for


class AutoReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="talaria-autorelease-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "-q", "-b", "main")
        # The code under test tags with the repository's own identity, as CI does after `git config`.
        for key, value in (("user.name", "Test"), ("user.email", "test@example.invalid"),
                           ("commit.gpgSign", "false"), ("tag.gpgSign", "false")):
            self.git("config", key, value)
        for name in ("app", "web", "relay"):
            self.write(f"{name}/source.txt", "released")
        self.released = self.commit("released sources")
        self.previous = {"releaseSet": self.released, "components": {
            "app": {"tag": "app-v1.9.0", "sourceRevision": self.released},
            "web": {"tag": "web-v1.0.0", "sourceRevision": self.released},
            "relay": {"tag": "relay-v0.2.0", "sourceRevision": self.released, "deploymentId": "synthetic-relay"},
        }}

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                               "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", *args],
                              text=True, capture_output=True, check=True).stdout.strip()

    def write(self, path, text):
        (self.root / path).parent.mkdir(parents=True, exist_ok=True)
        (self.root / path).write_text(text)

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def release(self, tag="v1.10.1"):
        return request_for(self.root, tag, self.git("rev-parse", "HEAD"), self.previous)

    def test_only_changed_components_get_the_release_version(self):
        self.write("app/source.txt", "changed")
        self.write("web/source.txt", "changed")
        self.write("changelog.d/TAL-1.json", "{}")
        source = self.commit("app and web change")
        # A later commit on main does not move the release: it is planned from the dispatched commit.
        self.write("relay/source.txt", "changed after the dispatch")
        self.commit("relay change")
        request, changed = request_for(self.root, "v1.10.1", source, self.previous)
        self.assertEqual(changed, ["app", "web"])
        self.assertEqual(request, {"sourceRevision": source, "relayDeploymentId": "synthetic-relay",
                                   "tags": {"app": "app-v1.10.1", "web": "web-v1.10.1", "relay": "relay-v0.2.0"}})

    def test_nothing_changed_and_malformed_versions_are_refused(self):
        self.write("docs.md", "outside every component")
        source = self.commit("docs only")
        with self.assertRaisesRegex(ValueError, "nothing changed"):
            self.release()
        for tag in ("1.10.1", "v1.10", "app-v1.10.1", "v01.1.0", "v1.10.1-rc.1"):
            with self.assertRaisesRegex(ValueError, "must be vX.Y.Z"):
                request_for(self.root, tag, source, self.previous)
        with self.assertRaisesRegex(ValueError, "full commit SHA"):
            request_for(self.root, "v1.10.1", source[:7], self.previous)


if __name__ == "__main__":
    unittest.main()
