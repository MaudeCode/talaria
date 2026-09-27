"""Experimental Web artifact identity, bundling and GHCR tag decisions with local Git and synthetic data only."""

import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

from build import CONTRACTS, experimental_component, require_bundled_contracts
from experimental import MOVING, moves_forward, pruned

REPOSITORY = Path(__file__).resolve().parents[1]


class ExperimentalTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="talaria-experimental-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git("init", "-b", "main")
        for name in ("scripts/stamp-release.py", "web/sidecar/agent_dependency.json", "web/contract_versions.json"):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPOSITORY / name, target)
        (self.root / "web/.gitignore").write_text("_release.json\n")
        self.commit("synthetic Web source")

    def git(self, *args):
        return subprocess.check_output([
            "git", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
            "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", *args,
        ], cwd=self.root, env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"},
            text=True, stderr=subprocess.PIPE).strip()

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "--allow-empty", "-m", message)
        return self.git("rev-parse", "HEAD")

    def stamp(self, component):
        return subprocess.run([sys.executable, "scripts/stamp-release.py", "web", "--version", component["version"],
                               "--source-revision", component["sourceRevision"], "--tag", component["tag"]],
                              cwd=self.root, capture_output=True, text=True, check=False)

    def test_version_follows_the_latest_stable_tag_and_the_source(self):
        with self.assertRaisesRegex(ValueError, "Stable"):
            experimental_component(self.root)
        for tag in ("web-v1.9.9", "web-v1.10.0", "web-v1.2.0", "web-exp-v2.0.0", "app-v3.0.0"):
            self.git("tag", tag)
        source = self.git("rev-parse", "HEAD")
        self.assertEqual(experimental_component(self.root), {
            "version": f"1.10.0-exp.{source[:12]}", "sourceRevision": source, "tag": f"web-exp-v1.10.0-exp.{source[:12]}",
        })

    def test_release_json_carries_the_experimental_runtime_identity(self):
        self.git("tag", "web-v1.4.0")
        component = experimental_component(self.root)
        stamped = self.stamp(component)
        self.assertEqual(stamped.returncode, 0, stamped.stderr)
        release = json.loads((self.root / "web/_release.json").read_text())
        pin = json.loads((REPOSITORY / "web/sidecar/agent_dependency.json").read_text())
        versions = json.loads((REPOSITORY / "web/contract_versions.json").read_text())
        self.assertEqual(release, {
            "version": component["version"], "tag": component["tag"],
            "sourceRevision": component["sourceRevision"], "releaseSet": component["sourceRevision"],
            "contracts": {"appWeb": [versions["appWeb"]["fixtureVersion"]], "webRelay": [versions["webRelay"]["protocolVersion"]]},
            "compatibleAgent": {**pin["x-talaria"], "image": pin["services"]["hermes-agent"]["image"]},
        })

    def test_stamp_rejects_an_experimental_version_for_another_source_or_channel(self):
        source = self.git("rev-parse", "HEAD")
        other = "b" * 12 if source[:12] != "b" * 12 else "c" * 12
        for version, tag in ((f"1.4.0-exp.{other}", f"web-exp-v1.4.0-exp.{other}"),
                             (f"1.4.0-exp.{source[:12]}", f"web-v1.4.0-exp.{source[:12]}")):
            with self.subTest(version=version, tag=tag):
                stamped = self.stamp({"version": version, "sourceRevision": source, "tag": tag})
                self.assertNotEqual(stamped.returncode, 0)
                self.assertFalse((self.root / "web/_release.json").exists())

    def tarball(self, manifest, bundled=None):
        path = self.root / "package.tgz"
        with tarfile.open(path, "w:gz") as archive:
            entries = {"package/package.json": manifest}
            if bundled is not None:
                entries[f"package/node_modules/{CONTRACTS}/package.json"] = bundled
            for name, document in entries.items():
                data = json.dumps(document).encode()
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        return path

    def test_packed_tarball_must_bundle_its_exact_contracts(self):
        version = "1.4.0-exp.aaaaaaaaaaaa"
        manifest = {"name": "@maudecode/talaria-web", "version": version, "bundleDependencies": [CONTRACTS]}
        contracts = {"name": CONTRACTS, "version": version}
        require_bundled_contracts(self.tarball(manifest, contracts), version)
        for label, candidate in (
            ("no bundleDependencies", self.tarball({**manifest, "bundleDependencies": []}, contracts)),
            ("contracts not packed", self.tarball(manifest)),
            ("other contracts version", self.tarball(manifest, {**contracts, "version": "1.4.0"})),
        ):
            with self.subTest(label), self.assertRaisesRegex(ValueError, "bundle"):
                require_bundled_contracts(candidate, version)

    def test_experimental_tag_moves_only_forward(self):
        base = self.git("rev-parse", "HEAD")
        ahead = self.commit("newer main")
        self.git("checkout", "-q", "-b", "side", base)
        side = self.commit("diverged")
        self.assertTrue(moves_forward(self.root, None, base))
        self.assertTrue(moves_forward(self.root, base, ahead))
        self.assertTrue(moves_forward(self.root, ahead, ahead))
        self.assertFalse(moves_forward(self.root, ahead, base))
        self.assertFalse(moves_forward(self.root, ahead, side))
        with self.assertRaisesRegex(ValueError, "cannot order"):
            moves_forward(self.root, "d" * 40, ahead)

    def test_retention_keeps_the_newest_fifty_and_the_experimental_target(self):
        def versions(moving):
            return [{"id": index, "created_at": f"2026-09-{1 + index // 24:02d}T{index % 24:02d}:00:00Z",
                     "metadata": {"container": {"tags": [f"sha-{index:040x}"] + ([MOVING] if index == moving else [])}}}
                    for index in range(60)]
        # Index 0 is the oldest; the newest fifty are 10..59.
        self.assertEqual(pruned(versions(moving=59)), list(range(9, -1, -1)))
        self.assertEqual(pruned(versions(moving=3)), [9, 8, 7, 6, 5, 4, 2, 1, 0])
        self.assertEqual(pruned(versions(moving=3)[:50]), [])


if __name__ == "__main__":
    unittest.main()
