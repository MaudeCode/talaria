#!/usr/bin/env python3
"""Tests for scripts/phone-test-server (TAL-2621, TAL-2622 scenarios, TAL-2623 add-server link).

Run: python3 scripts/test-phone-test-server.py
"""
import http.cookiejar
import importlib.machinery
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.parse
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

    def test_the_preferred_port_is_used_when_free_and_skipped_while_held(self):
        with socket.socket() as holder:
            holder.bind(("127.0.0.1", 0))
            holder.listen()
            held = holder.getsockname()[1]
            self.assertNotEqual(pts.server_port("127.0.0.1", preferred=held), held)
        self.assertEqual(pts.server_port("127.0.0.1", preferred=held), held)


def disposable_checkout(test):
    """A test-owned checkout with its own hostile web/.env: the script and server dist are copied, the rest of web/ is
    linked. The server finds its web root above its dist, so it reads this .env, never the developer's."""
    real = SCRIPT.resolve().parents[1] / "web"
    root = Path(os.path.realpath(tempfile.mkdtemp()))
    test.addCleanup(shutil.rmtree, root)
    server = root / "web" / "packages" / "server"
    server.mkdir(parents=True)
    for source, target, own in ((real, root / "web", {"packages", ".env"}), (real / "packages", server.parent, {"server"}),
                                (real / "packages" / "server", server, {"dist"})):
        for entry in source.iterdir():
            if entry.name not in own:
                (target / entry.name).symlink_to(entry)
    shutil.copytree(real / "packages" / "server" / "dist", server / "dist")
    (root / "web" / ".env").write_text("TALARIA_WEB_PASSWORD=checkout-password\n")
    (root / "scripts").mkdir()
    return Path(shutil.copy2(SCRIPT, root / "scripts" / SCRIPT.name))


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pts.build()

    def test_start_serves_a_password_login_and_stop_removes_the_server(self):
        script = disposable_checkout(self)
        started = subprocess.run(
            [sys.executable, str(script), "start", "--no-build", "--host", "127.0.0.1"], capture_output=True, text=True
        )
        self.assertEqual(started.returncode, 0, started.stderr[-4000:])
        server = json.loads(started.stdout)
        try:
            link = urllib.parse.urlsplit(server.get("addServerLink", ""))
            self.assertEqual((link.scheme, link.netloc), ("talaria-branch", "add-server"))
            self.assertEqual(urllib.parse.parse_qs(link.query), {"url": [server["url"]], "password": [server["password"]]})
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
            stopped = subprocess.run([sys.executable, str(script), "stop", server["stateDir"]], capture_output=True, text=True)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        with self.assertRaises(ProcessLookupError):
            os.kill(server["pid"], 0)
        self.assertFalse(Path(server["stateDir"]).exists())

    def test_stop_never_signals_a_reused_pid(self):
        bystander = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE)
        self.addCleanup(bystander.wait)
        self.addCleanup(bystander.kill)
        state_dir = Path(os.path.realpath(tempfile.mkdtemp(prefix=pts.STATE_PREFIX)))
        self.addCleanup(shutil.rmtree, state_dir, True)
        # The record names the bystander's PID with another process's start time, as after the server exited and the
        # PID was reused.
        (state_dir / "server.json").write_text(json.dumps({"pid": bystander.pid, "started": "Thu Jan  1 00:00:00 1970"}))
        stopped = subprocess.run([sys.executable, str(SCRIPT), "stop", str(state_dir)], capture_output=True, text=True)
        self.assertIsNone(bystander.poll())
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertFalse(state_dir.exists())


EXAMPLE = SCRIPT.parent / "phone-test-scenarios" / "example.json"


class ScenarioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pts.build()

    def seeded(self):
        """Starts a server seeded with the example (start verifies it and exits non-zero on a mismatch) and returns it
        with a logged-in API client."""
        started = subprocess.run([sys.executable, str(SCRIPT), "start", "--no-build", "--host", "127.0.0.1", "--scenario", str(EXAMPLE)],
                                 capture_output=True, text=True)
        self.assertEqual(started.returncode, 0, started.stderr[-4000:])
        server = json.loads(started.stdout)
        self.addCleanup(subprocess.run, [sys.executable, str(SCRIPT), "stop", server["stateDir"]], capture_output=True)
        return server, pts.Api(server["url"], server["password"])

    def session_id(self, api, title):
        return next(row["session_id"] for row in api.call("/api/sessions", include_archived="1")["sessions"] if row["title"] == title)

    def test_start_seeds_the_example_and_names_any_difference_from_it(self):
        server, api = self.seeded()
        scenario = json.loads(EXAMPLE.read_text())
        self.assertTrue((Path(server["stateDir"]) / "workspace" / "notes" / "todo.md").is_file())
        self.assertEqual(pts.verify(api, scenario), [])
        scenario["chats"][0]["pinned"] = False
        scenario["chats"][0]["turns"][0]["tools"].pop()
        self.assertEqual(pts.verify(api, scenario), [
            "chat 'Wide table': expected pinned False, got True",
            "chat 'Wide table': turn 'Read my todo list': expected tool rows ['read_file'], got ['read_file', 'terminal']",
        ])

    def test_answering_a_seeded_approval_and_clarification_completes_the_turn_with_its_reply(self):
        _, api = self.seeded()
        sid = self.session_id(api, "Waiting for approval")
        approval = api.call("/api/approval/pending", session_id=sid)["pending"]
        self.assertEqual(approval["command"], "rm -rf build")
        self.assertIs(api.call("/api/approval/respond", {"session_id": sid, "choice": "once", "approval_id": approval["approval_id"]})["ok"], True)
        clarify = pts.until("the clarification", lambda: api.call("/api/clarify/pending", session_id=sid).get("pending"))
        api.call("/api/clarify/respond", {"session_id": sid, "clarify_id": clarify["clarify_id"], "response": "Keep logs"})
        messages = pts.until("the reply", lambda: (lambda rows: rows if rows[-1].get("content") == "The build folder is clean." else None)(
            api.call("/api/session", session_id=sid, messages="1")["session"]["messages"]))
        self.assertEqual([(row["role"], row.get("name")) for row in messages],
                         [("user", None), ("assistant", None), ("tool", "search_files"), ("assistant", None)])

    def test_seeded_transcripts_keep_their_tool_rows_and_replies_after_a_restart(self):
        server, _ = self.seeded()
        state_dir = Path(server["stateDir"])
        pts.terminate(state_dir)
        url = pts.launch(state_dir)
        self.addCleanup(pts.terminate, state_dir)  # in this process, so the relaunched child is reaped
        api = pts.Api(url, server["password"])
        settled = [chat for chat in json.loads(EXAMPLE.read_text())["chats"] if chat["title"] in ("Wide table", "Archived notes")]
        for chat in settled:
            self.assertEqual(pts.transcript_mismatches(api, self.session_id(api, chat["title"]), chat["turns"]), [], chat["title"])

    def test_a_scenario_the_seeding_cannot_reproduce_is_refused(self):
        directory = Path(os.path.realpath(tempfile.mkdtemp()))
        self.addCleanup(shutil.rmtree, directory)
        bad = directory / "bad.json"
        bad.write_text(json.dumps({"files": [{"path": "../escape.md", "content": ""}], "chats": [
            {"title": "A", "project": "Missing", "turns": [{"user": "hi", "approval": {"command": "ls"}}, {"user": "again", "reply": "x"}]},
            {"title": "B", "turns": [{"user": "hi", "reply": "y"}]},
        ]}))
        with self.assertRaises(pts.Failure) as refused:
            pts.load_scenario(bad)
        for problem in ("'../escape.md' needs a relative path", "unknown project 'Missing'", "only its last turn may wait",
                        "turn message 'hi' is used twice"):
            self.assertIn(problem, str(refused.exception))


if __name__ == "__main__":
    unittest.main()
