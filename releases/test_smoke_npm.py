"""The packed-tarball boot check with synthetic npm packages only: no registry, Agent or network."""

import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

from smoke_npm import PACKAGE

SCRIPT = Path(__file__).resolve().with_name("smoke_npm.py")

# Serves /health only when the check hands it the isolated home and the package's own replay sidecar.
HEALTHY = """
import { existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
writeFileSync(process.env.SMOKE_TEST_PID_FILE, String(process.pid))
const sidecar = JSON.parse(process.env.HERMES_WEBUI_SIDECAR_COMMAND).at(-1)
const isolated = process.env.HERMES_HOME === process.env.HOME && process.env.HERMES_WEBUI_SKIP_ONBOARDING === '1' && existsSync(sidecar)
createServer((request, response) => {
  response.writeHead(request.url === '/health' && isolated ? 200 : 500)
  response.end()
}).listen(Number(process.env.HERMES_WEBUI_PORT), process.env.HERMES_WEBUI_HOST)
"""
# What TAL-1010 shipped: a dependency the bin imports is missing, so it exits 1 at import.
BROKEN = "import 'ws'\n"


class SmokeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="talaria-smoke-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.scratch = self.root / "tmp"
        self.scratch.mkdir()

    def tarball(self, bin_source):
        files = {
            "package.json": json.dumps({"name": PACKAGE, "version": "0.0.0-smoke", "type": "module",
                                        "bin": {"talaria-web": "./dist/bin/talaria-web.js"}}),
            "dist/bin/talaria-web.js": bin_source,
            "sidecar/scripts/replay_sidecar.py": "",
        }
        path = self.root / "talaria-web-smoke.tgz"
        with tarfile.open(path, "w:gz") as archive:
            for name, content in files.items():
                data = content.encode()
                info = tarfile.TarInfo("package/" + name)
                info.size, info.mode = len(data), 0o644
                archive.addfile(info, io.BytesIO(data))
        return path

    def smoke(self, tarball):
        pid_file = self.root / "server.pid"
        env = {**os.environ, "TMPDIR": str(self.scratch), "SMOKE_TEST_PID_FILE": str(pid_file),
               "npm_config_cache": str(self.root / "npm-cache")}
        result = subprocess.run([sys.executable, str(SCRIPT), str(tarball)], env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual([], list(self.scratch.glob("talaria-web-smoke-*")), "the check must remove its temporary directories")
        return result, pid_file

    def test_a_tarball_whose_bin_fails_at_import_fails_with_the_log_tail(self):
        result, _ = self.smoke(self.tarball(BROKEN))
        self.assertEqual(1, result.returncode, result.stderr)
        self.assertIn("did not serve /health", result.stderr)
        self.assertIn("ERR_MODULE_NOT_FOUND", result.stderr)

    def test_a_tarball_that_serves_health_passes_and_its_server_is_stopped(self):
        result, pid_file = self.smoke(self.tarball(HEALTHY))
        self.assertEqual(0, result.returncode, result.stderr)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid_file.read_text()), 0)


if __name__ == "__main__":
    unittest.main()
