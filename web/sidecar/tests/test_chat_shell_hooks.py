"""TAL-1258: a Web turn runs the profile's consented shell hooks, like the CLI and gateway. A ``fail_closed``
``pre_tool_call`` guard blocks the turn's tool call; a hook removed from ``config.yaml`` stops on the next turn unless
the config or allowlist cannot be trusted, and a replaced outbound webhook stops too. A hook without consent never runs,
and nothing writes consent. Deleting a profile drops its hooks, so a profile recreated at the same path inherits none.
Real sidecar, pinned Agent, disposable home."""

from __future__ import annotations

import json
import pathlib
import threading
import time

from conftest import OneToolCallModel, SidecarProcess, requires_agent, serve_model

pytestmark = requires_agent

TODOS = [{"id": "1", "content": "write repro", "status": "in_progress"}]


class _Todo(OneToolCallModel):
    def first_call(self, body: dict) -> dict:
        return {"name": "todo_list", "arguments": json.dumps({"todos": TODOS})}


def _guard(home: pathlib.Path) -> tuple[str, pathlib.Path]:
    """A guard script that records each run and exits non-zero without JSON, which a ``fail_closed`` hook treats as a block."""
    runs = home / "guard-runs.log"
    script = home / "guard.sh"
    script.write_text(f"#!/bin/sh\necho run >> '{runs}'\nexit 1\n")
    script.chmod(0o755)
    return str(script), runs


class _Recorder(_Todo):
    """Also receives outbound webhook deliveries on ``/hook-*``, in delivery order."""

    deliveries: list[str] = []
    delivered = threading.Condition()

    def do_POST(self):  # noqa: N802
        if not self.path.startswith("/hook-"):
            return super().do_POST()
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send_response(204)
        self.end_headers()
        with self.delivered:
            self.deliveries.append(self.path)
            self.delivered.notify_all()


class _Memory(OneToolCallModel):
    def first_call(self, body: dict) -> dict:
        return {"name": "memory", "arguments": json.dumps({"action": "add", "target": "memory", "content": "deploy with blue"})}


def _config(url: str, command: str | None, webhook: str | None = None, matcher: str = "todo_list") -> str:
    hooks = f"  pre_tool_call:\n    - command: {command}\n      matcher: {matcher}\n      fail_closed: true\n" if command else ""
    hooks += f"  outbound:\n    - url: {url.removesuffix('/v1')}/{webhook}\n      events: [post_tool_call]\n" if webhook else ""
    hooks = f"hooks:\n{hooks}" if hooks else ""
    # Offer todo_list directly rather than behind the tool_call bridge.
    return f"model:\n  provider: custom\n  default: stub-model\n  base_url: {url}\n  api_key: sk-stub\ntools:\n  tool_search:\n    defer: []\n{hooks}"


def _turn(proc: SidecarProcess, home: pathlib.Path, n: int) -> dict:
    """One turn's todo_list tool row, parsed. A blocked call never starts, so only the transcript carries its result."""
    params = {"profile_home": str(home), "session_id": f"web-hook-{n}", "stream_id": f"st-hook-{n}", "user_message": "plan it",
              "conversation_history": [], "model": "stub-model", "model_provider": "custom", "workspace": str(home.parent),
              "enabled_toolsets": ["todo"]}
    message, _ = proc.call("chat.start", params, timeout=120)
    result = message.get("result", {})
    assert result.get("status") == "completed", (message, proc.stderr_lines[-20:])
    rows = [m for m in result["messages"] if m.get("role") == "tool"]
    assert [r.get("name") for r in rows] == ["todo_list"], rows
    return json.loads(rows[0]["content"])


def _runs(log: pathlib.Path) -> int:
    return len(log.read_text().splitlines()) if log.exists() else 0


def test_a_consented_fail_closed_hook_blocks_web_tool_calls_until_revoked(hermes_home: pathlib.Path) -> None:
    command, runs = _guard(hermes_home)
    (hermes_home / "shell-hooks-allowlist.json").write_text(json.dumps({"approvals": [{"event": "pre_tool_call", "command": command}]}))
    with serve_model(type("Stub", (_Todo,), {})) as url:
        (hermes_home / "config.yaml").write_text(_config(url, command))
        proc = SidecarProcess(hermes_home)
        try:
            blocked = _turn(proc, hermes_home, 1)
            assert _runs(runs) == 1
            assert "failed closed" in blocked.get("error", ""), blocked
            (hermes_home / "config.yaml").write_text(_config(url, None))
            after = _turn(proc, hermes_home, 2)
        finally:
            proc.close()
    assert _runs(runs) == 1
    assert after["todos"] == TODOS, after


def test_an_unreadable_allowlist_never_disarms_a_registered_guard(hermes_home: pathlib.Path) -> None:
    command, runs = _guard(hermes_home)
    allowlist = hermes_home / "shell-hooks-allowlist.json"
    allowlist.write_text(json.dumps({"approvals": [{"event": "pre_tool_call", "command": command}]}))
    with serve_model(type("Stub", (_Todo,), {})) as url:
        (hermes_home / "config.yaml").write_text(_config(url, command))
        proc = SidecarProcess(hermes_home)
        try:
            assert "failed closed" in _turn(proc, hermes_home, 1).get("error", "")
            allowlist.write_text("{")
            after = _turn(proc, hermes_home, 2)
        finally:
            proc.close()
    assert _runs(runs) == 2
    assert "failed closed" in after.get("error", ""), after



def test_a_hook_approved_after_the_first_turn_guards_the_next(hermes_home: pathlib.Path) -> None:
    command, runs = _guard(hermes_home)
    with serve_model(type("Stub", (_Todo,), {})) as url:
        (hermes_home / "config.yaml").write_text(_config(url, command))
        proc = SidecarProcess(hermes_home)
        try:
            assert _turn(proc, hermes_home, 1)["todos"] == TODOS  # configured, not yet approved
            (hermes_home / "shell-hooks-allowlist.json").write_text(json.dumps({"approvals": [{"event": "pre_tool_call", "command": command}]}))
            blocked = _turn(proc, hermes_home, 2)
        finally:
            proc.close()
    assert _runs(runs) == 1
    assert "failed closed" in blocked.get("error", ""), blocked

def test_a_hook_without_consent_never_runs(hermes_home: pathlib.Path) -> None:
    command, runs = _guard(hermes_home)
    with serve_model(type("Stub", (_Todo,), {})) as url:
        (hermes_home / "config.yaml").write_text(_config(url, command))
        proc = SidecarProcess(hermes_home)
        try:
            done = _turn(proc, hermes_home, 1)
        finally:
            proc.close()
    assert _runs(runs) == 0
    assert done["todos"] == TODOS, done
    assert not (hermes_home / "shell-hooks-allowlist.json").exists()


def _delivered(model, path: str) -> None:
    with model.delivered:
        assert model.delivered.wait_for(lambda: path in model.deliveries, timeout=30), model.deliveries


def test_a_replaced_outbound_webhook_stops_on_the_next_turn(hermes_home: pathlib.Path) -> None:
    model = type("Stub", (_Recorder,), {"deliveries": [], "delivered": threading.Condition()})
    with serve_model(model) as url:
        (hermes_home / "config.yaml").write_text(_config(url, None, "hook-old"))
        proc = SidecarProcess(hermes_home)
        try:
            _turn(proc, hermes_home, 1)
            _delivered(model, "/hook-old")
            (hermes_home / "config.yaml").write_text(_config(url, None, "hook-new"))
            _turn(proc, hermes_home, 2)
            _delivered(model, "/hook-new")  # one FIFO delivery worker: a surviving old target would have delivered first
        finally:
            proc.close()
    assert model.deliveries == ["/hook-old", "/hook-new"]


def test_a_recreated_profile_inherits_none_of_the_deleted_profiles_hooks(hermes_home: pathlib.Path) -> None:
    model = type("Stub", (_Recorder,), {"deliveries": [], "delivered": threading.Condition()})
    with serve_model(model) as url:
        proc = SidecarProcess(hermes_home)
        try:
            base = {"base_home": str(hermes_home), "name": "guarded"}
            home = pathlib.Path(proc.result("profiles.create", base)["profile"]["path"])
            command, runs = _guard(hermes_home)  # outside the profile, so the run log survives its deletion
            (home / "shell-hooks-allowlist.json").write_text(json.dumps({"approvals": [{"event": "pre_tool_call", "command": command}]}))
            (home / "config.yaml").write_text(_config(url, command, "hook-old"))
            assert "failed closed" in _turn(proc, home, 1).get("error", "")
            _delivered(model, "/hook-old")
            message, _ = proc.call("profiles.delete", base)
            # The Agent may leave its identity purge pending in a disposable home; the directory is gone either way.
            assert message.get("result") == {"ok": True} or "ProfileIdentitySettlementPending" in message["error"]["message"], message
            assert not home.exists()
            assert pathlib.Path(proc.result("profiles.create", base)["profile"]["path"]) == home
            (home / "config.yaml").write_text(_config(url, None, "hook-new"))
            after = _turn(proc, home, 2)
            _delivered(model, "/hook-new")
        finally:
            proc.close()
    assert _runs(runs) == 1
    assert after["todos"] == TODOS, after
    assert model.deliveries == ["/hook-old", "/hook-new"]


def test_a_refine_that_is_the_first_agent_work_runs_the_profiles_guard(hermes_home: pathlib.Path) -> None:
    """After a sidecar restart ``chat.refine`` can build the session's agent before any turn; its review fork's tool
    calls still pass the profile's guard."""
    command, runs = _guard(hermes_home)
    (hermes_home / "shell-hooks-allowlist.json").write_text(json.dumps({"approvals": [{"event": "pre_tool_call", "command": command}]}))
    with serve_model(type("Stub", (_Memory,), {})) as url:
        (hermes_home / "config.yaml").write_text(_config(url, command, matcher="memory"))
        proc = SidecarProcess(hermes_home)
        try:
            params = {"profile_home": str(hermes_home), "session_id": "web-refine", "model": "stub-model", "model_provider": "custom",
                      "enabled_toolsets": ["memory"], "messages": [{"role": "user", "content": "deploy with blue"}, {"role": "assistant", "content": "done"}]}
            assert "Reviewing this conversation" in proc.result("chat.refine", params)["output"]
            deadline = time.monotonic() + 60
            while not _runs(runs) and time.monotonic() < deadline:  # the review runs in the background
                time.sleep(0.1)
        finally:
            proc.close()
    assert _runs(runs) == 1
