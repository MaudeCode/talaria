import json
import pathlib
import re
import unittest
import urllib.error
import urllib.request

REPO_ROOT = pathlib.Path(__file__).parent.parent
CONFIG_PY = (REPO_ROOT / "api" / "config.py").read_text(encoding="utf-8")
from tests._pytest_port import BASE


def _get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.loads(r.read()), r.status


def _post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code


class TestSidebarDensityConfig(unittest.TestCase):
    def test_sidebar_density_in_defaults(self):
        self.assertIn('"sidebar_density"', CONFIG_PY)

    def test_sidebar_density_default_is_compact(self):
        self.assertRegex(CONFIG_PY, r'"sidebar_density"\s*:\s*"compact"')

    def test_sidebar_density_in_enum_values(self):
        self.assertIn('"sidebar_density": {"compact", "detailed"}', CONFIG_PY)


class TestSidebarDensitySettingsAPI(unittest.TestCase):
    def test_sidebar_density_default_is_compact(self):
        try:
            data, status = _get("/api/settings")
        except OSError:
            self.skipTest("Server not running on test server port")
        self.assertEqual(status, 200)
        self.assertEqual(data.get("sidebar_density"), "compact")

    def test_sidebar_density_round_trips_detailed(self):
        try:
            _, status = _post("/api/settings", {"sidebar_density": "detailed"})
        except OSError:
            self.skipTest("Server not running on test server port")
        self.assertEqual(status, 200)
        data, _ = _get("/api/settings")
        self.assertEqual(data.get("sidebar_density"), "detailed")
        _post("/api/settings", {"sidebar_density": "compact"})

    def test_invalid_sidebar_density_is_ignored(self):
        try:
            _post("/api/settings", {"sidebar_density": "compact"})
            data, status = _post("/api/settings", {"sidebar_density": "nope"})
        except OSError:
            self.skipTest("Server not running on test server port")
        self.assertEqual(status, 200)
        self.assertEqual(data.get("sidebar_density"), "compact")
        current, _ = _get("/api/settings")
        self.assertEqual(current.get("sidebar_density"), "compact")
