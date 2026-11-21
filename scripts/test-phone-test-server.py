#!/usr/bin/env python3
"""Tests for scripts/phone-test-server (TAL-2621).

Run: python3 scripts/test-phone-test-server.py
"""
import http.cookiejar
import importlib.machinery
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path

SCRIPT = Path(__file__).with_name("phone-test-server")
_loader = importlib.machinery.SourceFileLoader("phone_test_server", str(SCRIPT))
_spec = importlib.util.spec_from_loader("phone_test_server", _loader)
pts = importlib.util.module_from_spec(_spec)
_loader.exec_module(pts)

# Mirrors the real CLI: `up` refuses with the restate-settings error and prints the command to run, or waits for a
# login and prints its URL. Each call is logged; `up --accept-routes` brings the backend to Running.
FAKE_TAILSCALE = """#!{python}
import json, sys
from pathlib import Path
here = Path(__file__).parent
scenario = (here / "scenario").read_text()
state = here / "state"
args = sys.argv[1:]
with (here / "calls").open("a") as calls:
    calls.write(" ".join(args) + "\\n")
if args == ["status", "--json"]:
    print(json.dumps({{"BackendState": state.read_text() if state.exists() else "Stopped", "AuthURL": ""}}))
elif args == ["ip", "-4"]:
    print("100.101.102.103")
elif args[0] == "up" and scenario == "login":
    sys.stderr.write("\\nTo authenticate, visit:\\n\\n\\thttps://login.tailscale.com/a/fake123\\n\\n")
    sys.stderr.write("timeout waiting for Tailscale service to enter a Running state; last state: NeedsLogin\\n")
    sys.exit(1)
elif args == ["up", "--timeout=20s"]:
    sys.stderr.write("Error: changing settings via 'tailscale up' requires mentioning all\\n"
                     "non-default flags. To proceed, either re-run your command with --reset or\\n"
                     "use the command below to explicitly mention the current value of\\n"
                     "all non-default settings:\\n\\n\\ttailscale up --accept-routes --timeout=20s\\n\\n")
    sys.exit(1)
elif args == ["up", "--accept-routes", "--timeout=20s"]:
    state.write_text("Running")
else:
    sys.exit(2)
"""


def fake_tailscale(test, scenario):
    directory = Path(os.path.realpath(tempfile.mkdtemp()))
    test.addCleanup(shutil.rmtree, directory)
    cli = directory / "tailscale"
    cli.write_text(FAKE_TAILSCALE.format(python=sys.executable))
    cli.chmod(0o755)
    (directory / "scenario").write_text(scenario)
    return cli, directory / "calls"


class TailscaleTests(unittest.TestCase):
    def test_a_stopped_backend_comes_up_through_the_suggested_command(self):
        cli, calls = fake_tailscale(self, "restate")
        self.assertEqual(pts.tailscale_ipv4(str(cli)), "100.101.102.103")
        ups = [line for line in calls.read_text().splitlines() if line.startswith("up")]
        self.assertEqual(ups, ["up --timeout=20s", "up --accept-routes --timeout=20s"])

    def test_a_login_exits_nonzero_with_the_login_url_and_never_binds(self):
        cli, calls = fake_tailscale(self, "login")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "start", "--no-build", "--tailscale", str(cli)], capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("https://login.tailscale.com/a/fake123", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("ip -4", calls.read_text())

    def test_host_override_refuses_wildcard_and_lan_addresses(self):
        for host in ("0.0.0.0", "192.168.1.20", "::1"):
            with self.assertRaises(pts.Failure, msg=host):
                pts.checked_host(host)


class ServerTests(unittest.TestCase):
    def test_start_serves_a_password_login_and_stop_removes_the_server(self):
        # A checkout web/.env with another password must not reach the server. Created exclusively, so a developer's
        # own web/.env is never overwritten.
        dotenv = SCRIPT.resolve().parents[1] / "web" / ".env"
        with dotenv.open("x") as hostile:
            hostile.write("TALARIA_WEB_PASSWORD=checkout-password\n")
        self.addCleanup(dotenv.unlink)
        started = subprocess.run(
            [sys.executable, str(SCRIPT), "start", "--host", "127.0.0.1"], capture_output=True, text=True
        )
        self.assertEqual(started.returncode, 0, started.stderr[-4000:])
        server = json.loads(started.stdout)
        try:
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            login = urllib.request.Request(
                f"{server['url']}/api/auth/login",
                data=json.dumps({"password": server["password"]}).encode(),
                headers={"Content-Type": "application/json"},
            )
            with opener.open(login, timeout=10) as response:
                self.assertIs(json.load(response)["ok"], True)
            with opener.open(f"{server['url']}/api/sessions", timeout=10) as response:
                self.assertEqual(response.status, 200)
        finally:
            stopped = subprocess.run([sys.executable, str(SCRIPT), "stop", server["stateDir"]], capture_output=True, text=True)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        with self.assertRaises(ProcessLookupError):
            os.kill(server["pid"], 0)
        self.assertFalse(Path(server["stateDir"]).exists())


if __name__ == "__main__":
    unittest.main()
