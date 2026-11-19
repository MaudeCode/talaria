"""The Stable npm archive carries the production graph selected at build time."""

import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from build import CONTRACTS, pack_stable_web
from cli import write


class WebPackTests(unittest.TestCase):
    def test_stable_archive_pins_the_production_closure(self):
        with tempfile.TemporaryDirectory(prefix="talaria-web-pack-") as temporary:
            web = Path(temporary)
            version = "1.2.3"
            contracts = {"name": CONTRACTS, "version": version, "dependencies": {"child": "^2.0.0"}}
            server = {
                "name": "@maudecode/talaria-web", "version": version, "dependencies": {CONTRACTS: version},
                "devDependencies": {"dev-only": "3.0.0"}, "bin": {}, "engines": {"node": ">=24"},
            }
            for name, manifest in (("server", server), ("contracts", contracts)):
                package = web / "packages" / name
                package.mkdir(parents=True)
                write(package / "package.json", manifest)
            write(web / "package.json", {"name": "synthetic-web", "private": True, "workspaces": ["packages/*"]})
            child = {
                "version": "2.1.0", "resolved": "https://registry.npmjs.org/child/-/child-2.1.0.tgz",
                "integrity": "sha512-" + "a" * 86 + "==",
            }
            write(web / "package-lock.json", {"lockfileVersion": 3, "packages": {
                "packages/contracts": contracts,
                f"node_modules/{CONTRACTS}": {"resolved": "packages/contracts", "link": True},
                "node_modules/child": child,
                "node_modules/dev-only": {"version": "3.0.0", "dev": True},
            }})
            output = web / "output"
            output.mkdir()

            pack_stable_web(web, output, version)

            with tarfile.open(output / f"maudecode-talaria-web-{version}.tgz") as archive:
                lock = json.load(archive.extractfile("package/npm-shrinkwrap.json"))
            self.assertEqual(set(lock["packages"]), {"", f"node_modules/{CONTRACTS}", "node_modules/child"})
            self.assertEqual(lock["packages"]["node_modules/child"], child)
            self.assertNotIn("devDependencies", lock["packages"][""])
