"""One-step release request (TAL-336): local Git only, no credentials or publication."""

import subprocess
import tempfile
import unittest
from pathlib import Path

from autorelease import ensure_component_tags, request_for


class AutoReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="talaria-autorelease-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "-q", "-b", "main")
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
        self.git("tag", "-a", "-m", "root", tag)
        return request_for(self.root, tag, self.previous)

    def test_only_changed_components_get_the_release_version(self):
        self.write("app/source.txt", "changed")
        self.write("web/source.txt", "changed")
        self.write("changelog.d/TAL-1.json", "{}")
        source = self.commit("app and web change")
        request, changed = self.release()
        self.assertEqual(changed, ["app", "web"])
        self.assertEqual(request, {"sourceRevision": source, "relayDeploymentId": "synthetic-relay",
                                   "tags": {"app": "app-v1.10.1", "web": "web-v1.10.1", "relay": "relay-v0.2.0"}})

    def test_nothing_changed_and_malformed_tags_are_refused(self):
        self.write("docs.md", "outside every component")
        self.commit("docs only")
        with self.assertRaisesRegex(ValueError, "nothing changed"):
            self.release()
        for tag in ("1.10.1", "v1.10", "app-v1.10.1", "v01.1.0"):
            with self.assertRaisesRegex(ValueError, "must be vX.Y.Z"):
                request_for(self.root, tag, self.previous)

    def test_component_tags_are_created_once_at_the_release_source(self):
        self.write("app/source.txt", "changed")
        source = self.commit("app change")
        request, changed = self.release()
        self.assertEqual(ensure_component_tags(self.root, request, changed, "v1.10.1"), ["app-v1.10.1"])
        self.assertEqual(self.git("rev-parse", "app-v1.10.1^{commit}"), source)
        self.assertEqual(self.git("cat-file", "-t", "app-v1.10.1"), "tag")
        # A retried run reuses the tag it made.
        self.assertEqual(ensure_component_tags(self.root, request, changed, "v1.10.1"), [])

    def test_a_component_tag_at_another_commit_blocks_the_release(self):
        self.write("app/source.txt", "first")
        self.commit("first attempt")
        self.git("tag", "-a", "-m", "earlier", "app-v1.10.1")
        self.write("app/source.txt", "fixed")
        self.commit("fix")
        request, changed = self.release()
        with self.assertRaisesRegex(ValueError, "already exists"):
            ensure_component_tags(self.root, request, changed, "v1.10.1")


if __name__ == "__main__":
    unittest.main()
