#!/usr/bin/env python3
"""Exercise actual Agent imports and its SQLite contract without any provider."""

import atexit
import importlib
import json
import os
import socket
import sys
import tempfile
import time
import threading
import types
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def deny_network(*args, **kwargs):
    raise AssertionError("Agent compatibility probe must not use the network")


socket.socket.connect = deny_network
socket.create_connection = deny_network
socket.getaddrinfo = deny_network

# Own HOME as well as Agent state, even when someone invokes the probe directly.
state = tempfile.TemporaryDirectory(prefix="talaria-agent-probe-home-")
atexit.register(state.cleanup)
os.environ["HOME"] = state.name
os.environ["HERMES_HOME"] = str(Path(state.name) / "hermes")
home = Path(os.environ["HERMES_HOME"])
home.mkdir(parents=True, exist_ok=True)
for name in ("run_agent", "hermes_cli.runtime_provider", "agent.auxiliary_client", "agent.model_metadata",
             "agent.context_compressor", "agent.turn_context", "agent.turn_context_compaction",
             "tools.file_tools", "tools.approval", "tools.terminal_tool"):
    module = importlib.import_module(name)
    if agent := os.environ.get("HERMES_WEBUI_AGENT_DIR"):
        assert Path(module.__file__).resolve().is_relative_to(Path(agent).resolve()), (name, module.__file__)
for module, names in {
    "update_lock": ("UpdateLock",),
    "update_custody": ("popen", "git_argv"),
    "update_cmd_posix_pause": ("_empty_token", "_discover_systemd", "_discover_launchd", "_discover_bare", "_ask_to_drain", "_alive", "_disarm"),
    "update_pause_record": ("adopt_orphans", "record_pause", "tree_state", "tree_is_whole", "write", "recover", "identity_is_live"),
    "update_cmd_pause_gate": ("_checkout_move",),
    "update_cmd_windows": ("_resume_windows_gateways_after_update",),
    "process_identity": ("_read_ledger", "_ledger_path", "_pid_alive_matches", "install_id"),
}.items():
    native = importlib.import_module("hermes_cli." + module)
    assert all(callable(getattr(native, name, None)) for name in names), f"Agent native update protocol missing in {module}"
    if agent := os.environ.get("HERMES_WEBUI_AGENT_DIR"):
        assert Path(native.__file__).resolve().is_relative_to(Path(agent).resolve()), (module, native.__file__)
import sqlite3

from hermes_state import SessionDB
from talaria_sidecar.methods import state_db as sidecar_state_db
from talaria_sidecar.runtime import installed_agent_version

__version__ = installed_agent_version()

# A release check names its exact package version; an Agent main canary has none to require.
assert sys.argv[1:] in ([], [__version__]), (__version__, sys.argv[1:])
database = home / "state.db"  # the canonical Agent database the sidecar writes through
db = SessionDB(database)
try:
    db.create_session("talaria-synthetic-session", source="cli")
    db.append_message("talaria-synthetic-session", role="user", content="Synthetic compatibility message")
    db.append_message("talaria-synthetic-session", role="assistant", content="Synthetic response")
finally:
    db.close()
# The sidecar writes through the same SessionDB (state_db.* methods); the TypeScript
# server projects the resulting rows read-only. Verify the write side and the row
# shape that projection depends on.
with sqlite3.connect(database) as connection:
    rows = connection.execute("SELECT id, (SELECT COUNT(*) FROM messages WHERE session_id = sessions.id) FROM sessions ORDER BY id").fetchall()
assert rows == [("talaria-synthetic-session", 2)], rows
assert sidecar_state_db.sync_session_start(home, "talaria-sidecar-session", model="synthetic") is True
with sqlite3.connect(database) as connection:
    sidecar_rows = connection.execute("SELECT id FROM sessions WHERE id = ?", ("talaria-sidecar-session",)).fetchall()
assert sidecar_rows == [("talaria-sidecar-session",)], sidecar_rows


def ssh_config_approval():
    """Observe real file tools; replace only the human approval response, never path policy."""
    from tools import approval, file_tools, terminal_tool

    target = Path(os.environ["HOME"]) / ".ssh/config"
    target.parent.mkdir(parents=True, exist_ok=True)
    original = "Host synthetic\n  HostName before.invalid\n"
    updated = "Host synthetic\n  ProxyCommand echo synthetic\n"
    observations = {}
    previous_cwd = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="process-", dir=home) as process:
        try:
            os.chdir(process)
            for tool in ("write", "edit"):
                for spelling in ("absolute", "relative"):
                    for decision in ("deny", "allow"):
                        task = f"talaria-ssh-{tool}-{spelling}-{decision}"
                        terminal_tool.register_task_env_overrides(task, {"env_type": "local", "cwd": str(target.parent.parent)})
                        # Writes cover creation; edits cover preserving an existing file on denial.
                        target.unlink(missing_ok=True)
                        if tool == "edit":
                            target.write_text(original)
                        before = target.read_bytes() if target.exists() else None
                        path = str(target) if spelling == "absolute" else ".ssh/config"
                        with patch.object(approval, "_run_approval_gate", return_value={
                            "approved": decision == "allow", "message": "Synthetic approval denied",
                        }) as gate:
                            if tool == "write":
                                file_tools.write_file_tool(path=path, content=updated, task_id=task)
                            else:
                                file_tools.patch_tool(path=path, old_string=original, new_string=updated, task_id=task)
                        after = target.read_bytes() if target.exists() else None
                        observations[f"{tool}/{spelling}/{decision}"] = {
                            "gateCalls": gate.call_count, "mutated": after != before,
                            "expectedContent": after == updated.encode(),
                        }
        finally:
            os.chdir(previous_cwd)
            target.unlink(missing_ok=True)
    return observations


def compression_backoff():
    """Real compressor state and turn-start preflight; only clocks, tokens and the compression callback are synthetic."""
    from agent.context_compressor import ContextCompressor
    from agent.turn_context_compaction import run_turn_start_compaction

    clock = [1000.0]
    short = [{"role": "system", "content": "Synthetic system"},
             {"role": "user", "content": "x" * 400_000}]
    grown = short + [{"role": "assistant" if i % 2 == 0 else "user", "content": f"Synthetic turn {i}"}
                     for i in range(8)]
    observations = {}

    def request_tokens(agent, messages, system):
        return 90_000 if len(messages) >= 2 else 1000

    with patch("time.monotonic", side_effect=lambda: clock[0]), patch("time.time", side_effect=lambda: clock[0]), \
            patch("agent.context_compressor.get_model_context_length", return_value=100_000), \
            patch("agent.turn_context._preflight_request_tokens", side_effect=request_tokens):
        compressor = ContextCompressor(model="synthetic/model", threshold_percent=0.85,
                                       protect_first_n=1, protect_last_n=1, quiet_mode=True)

        def preflight(messages):
            calls, warnings = [], []

            def compress(messages, system, **kwargs):
                calls.append(kwargs["trigger"])
                return [messages[-1]], system

            agent = SimpleNamespace(
                context_compressor=compressor, compression_enabled=True, compression_idle_compact_after_seconds=0,
                model="synthetic/model", api_mode="chat_completions", session_id=None, max_compression_attempts=1,
                _request_pressure_anchored=True, _compress_context=compress, _emit_status=lambda message: None,
                _clear_context_overflow_warn=lambda: None,
                _warn_context_overflow_blocked=lambda reason, *args: warnings.append(reason),
            )
            run_turn_start_compaction(
                agent, messages=messages, system_message=None, active_system_prompt=None,
                conversation_history=None, current_turn_user_idx=len(messages) - 1,
                user_message=messages[-1]["content"], effective_task_id="talaria-synthetic-compression",
            )
            return {"compressionCalls": len(calls), "blockedReasons": warnings}

        result = compressor.compress(short, current_tokens=90_000)
        observations["structuralNoOp"] = {
            "unchanged": result == short, "reason": compressor.should_compress_info(90_000)[1],
            "ineffectiveCount": compressor._ineffective_compression_count,
        }
        observations["unchanged"] = preflight(short)
        observations["grown"] = preflight(grown)
        # A fresh structural no-op must also release on clock expiry without growth.
        compressor.compress(short, current_tokens=90_000)
        clock[0] += 301
        observations["expired"] = preflight(short)
        compressor.compress(short, current_tokens=90_000)
        compressor.record_completed_compaction()
        should, reason = compressor.should_compress_info(90_000)
        observations["success"] = {"shouldCompress": should, "blockReason": reason}
        # A genuine failed summary is different: growth must not bypass its cooldown.
        compressor._record_compression_failure_cooldown(120, "Synthetic summary failure")
        observations["failureUnchanged"] = preflight(short)
        observations["failureGrown"] = preflight(grown)
        clock[0] += 121
        observations["failureExpired"] = preflight(grown)
    return observations


compression = compression_backoff()
print("COMPRESSION_BACKOFF " + json.dumps(compression, sort_keys=True))
if expected := os.environ.get("TALARIA_AGENT_COMPRESSION_EXPECTED"):
    assert compression == json.loads(expected), "compression backoff differs in release image"
observations = ssh_config_approval()
print("SSH_CONFIG_APPROVAL " + json.dumps(observations, sort_keys=True))
if expected := os.environ.get("TALARIA_AGENT_SSH_EXPECTED"):
    assert observations == json.loads(expected), "task-relative SSH configuration approval differs in release image"
print(f"PASS Agent {__version__}: imports, real SessionDB, and the sidecar write path")


# These exact supported sources predate per-entry executor deadlines. Never infer
# this exception from a candidate's version or the presence of an Agent attribute.
LEGACY_MCP_DEADLINES = {
    "71d34bad1045610252eda02ee79549436896e784": "0.21.7",
    "e06df9c2eae6901f4c88f464e0ae6e753c0428b8": "0.22.0",
}

MCP_SERVER = '''
import asyncio
import sys
from pathlib import Path
from mcp.server.mcpserver import MCPServer

server = MCPServer("talaria-deadline-probe")
markers = Path(sys.argv[1])

@server.tool()
async def probe(token: str, delay: float) -> str:
    (markers / (token + ".started")).touch()
    try:
        await asyncio.sleep(delay)
        return "deadline-complete:" + token
    finally:
        (markers / (token + ".finished")).touch()

server.run()
'''


def probe_mcp_deadlines(report):
    """Use the real discovery, registry, batch planner, bridge and executor, with stdio-only tools."""
    from hermes_cli.config import atomic_config_write, get_config_path
    from run_agent import AIAgent
    from tools.mcp_tool_common import _resolve_tool_timeout
    from tools.mcp_tool_discovery import discover_mcp_tools
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers
    from tools.registry import registry

    revision = os.environ.get("TALARIA_AGENT_PROBE_REVISION")
    legacy = revision in LEGACY_MCP_DEADLINES and LEGACY_MCP_DEADLINES[revision] == __version__
    report["historicalMcpDeadline"] = legacy
    script = home / "deadline_mcp_server.py"
    script.write_text(MCP_SERVER)
    markers = home / "deadline-markers"
    markers.mkdir()
    generic, delay, server_budget = 0.5, 1.5, 8
    servers = {name: {"command": sys.executable, "args": [str(script), str(markers)],
                      "supports_parallel_tool_calls": True, "trust": "full", "lazy": False,
                      **({"timeout": server_budget} if name == "deadline_explicit" else {})}
               for name in ("deadline_explicit", "deadline_default")}
    config = {"mcp_servers": servers, "timeouts": {"tools": {"sequential_call": server_budget,
                                                         "concurrent_batch": server_budget}}}
    atomic_config_write(get_config_path(), config)
    agent = None
    try:
        names = discover_mcp_tools()
        expected_names = {f"mcp__{name}__probe" for name in servers}
        assert expected_names <= set(names), names
        report["mcpDefaultTimeout"] = _resolve_tool_timeout({})
        assert report["mcpDefaultTimeout"] == 300, "MCP default fallback changed"
        agent = AIAgent(model="test-model", provider="openai", api_key="unused-test-key",
                        base_url="http://127.0.0.1:9/v1", enabled_toolsets=[f"mcp-{name}" for name in servers],
                        quiet_mode=True, skip_context_files=True, skip_memory=True, save_trajectories=False)
        # Warm imports/middleware before arming the accelerated generic deadline.
        cases = [("warmup", "deadline_default", False, 1, 0)]
        cases += [(f"{server}/{mode}/{speed}", server, bridge, count, seconds)
                  for server in servers
                  for mode, bridge, count in (("sequential", False, 1), ("deferred", True, 1),
                                              ("batch", False, 2), ("deferred-batch", True, 2))
                  for speed, seconds in (("fast", 0), ("slow", delay))]
        for index, (case, server, bridge, count, seconds) in enumerate(cases):
            budget = server_budget if case == "warmup" else generic
            config["timeouts"]["tools"] = {"sequential_call": budget, "concurrent_batch": budget}
            atomic_config_write(get_config_path(), config)
            name = f"mcp__{server}__probe"
            entry = registry.get_entry(name)
            assert entry is not None, name
            calls, tokens = [], []
            for number in range(count):
                token = f"case-{index}-{number}"
                tokens.append(token)
                args = {"token": token, "delay": seconds}
                if bridge:
                    args = {"calls": [{"name": name, "arguments": args}]}
                calls.append(SimpleNamespace(id=token, type="function", function=SimpleNamespace(
                    name="tool_call" if bridge else name, arguments=json.dumps(args))))
            messages = []
            agent._execute_tool_calls(SimpleNamespace(tool_calls=calls), messages, f"deadline-{index}")
            results = [str(message["content"]) for message in messages if message.get("role") == "tool"]
            completed = len(results) == count and all(
                f"deadline-complete:{token}" in result and "timed out" not in result
                for token, result in zip(tokens, results))
            timed_out = len(results) == count and all("timed out" in result for result in results)
            # An outer timeout may abandon a worker. Observe its owned tool's exit
            # before the next case, so a late result cannot contaminate the next call.
            # A batch timeout can cancel a sibling before it reaches the transport.
            dispatched = [token for token in tokens if (markers / (token + ".started")).exists()]
            end = time.monotonic() + server_budget
            while not all((markers / (token + ".finished")).exists() for token in dispatched) and time.monotonic() < end:
                time.sleep(0.01)
            finished = sum((markers / (token + ".finished")).exists() for token in dispatched)
            succeeds = seconds == 0 or (server == "deadline_explicit" and not legacy)
            actual = "completed" if completed else "tool_timeout" if timed_out else "unexpected_result"
            expected = "completed" if succeeds else "tool_timeout"
            check = {"case": case, "expected": expected, "actual": actual, "started": len(dispatched), "finished": finished,
                     "executionTimeout": getattr(entry, "execution_timeout", None),
                     "effectDispositions": [message.get("effect_disposition") for message in messages
                                            if message.get("role") == "tool"]}
            report["checks"].append(check)
            if actual != expected or not dispatched or finished != len(dispatched) or (succeeds and len(dispatched) != count):
                report["findings"].append({"name": "mcp_execution_deadline", **check, "results": results})
    finally:
        try:
            if agent is not None:
                agent.close()
        finally:
            shutdown_mcp_servers()


report = {"sshConfigApproval": observations, "compressionBackoff": compression, "checks": [], "findings": []}
try:
    probe_mcp_deadlines(report)
except Exception as error:
    report["findings"].append({"name": "mcp_execution_deadline", "error": f"{type(error).__name__}: {error}"})
finally:
    if path := os.environ.get("TALARIA_AGENT_PROBE_REPORT"):
        Path(path).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))
assert not report["findings"], report["findings"]
print(f"PASS Agent {__version__}: real MCP registration and executor deadlines")


def probe_retained_cron():
    """Replay records written by v0.22.1's real writers; discovery and delivery never leave this fixture."""
    from talaria_sidecar.methods import cron, cron_execution
    fixture = json.loads((Path(__file__).resolve().parent.parent / "web/sidecar/tests/fixtures/cron-retained-v0.22.1.json").read_text())
    from hermes_cli import update_pause_record
    paused = json.loads((Path(__file__).resolve().parent.parent / "web/sidecar/tests/fixtures/agent-pause-v0.22.1.json").read_text())["record"]
    journal = home / "synthetic-native-pause.json"
    journal.write_text(json.dumps(paused))
    assert update_pause_record.read(journal) == paused, "target cannot read the base-written gateway resume obligation"
    compatible = cron_execution.supported({}, recovery=True)
    failures = []
    # Observe the original receipt synchronously, so this probe cannot submit or spawn a replacement turn.
    cron._run_in_child = lambda job, execution_home, ctx, heartbeat, execution: cron_execution.recover(
        job, execution.execution_id, threading.Event())
    ctx = types.SimpleNamespace(emit=lambda *args: None, cancelled=False)
    for stored_result in (False, True):
        record = {**fixture["manual"], "execution_home": str(home)}
        if stored_result:
            record["result"] = [True, "synthetic output", "synthetic answer", None]
        file = cron_execution.path(home, record["job"]["id"])
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(record))
        before = file.read_bytes()
        try:
            cron.run_tracked(record["job"], home, home, ctx, recovery_only=True)
            assert compatible, "incompatible recovery fabricated a completion"
        except cron_execution.Unverified as exc:
            if not compatible:
                assert "unsupported recovery protocol" in str(exc), exc
                assert file.read_bytes() == before, "unsupported recovery rewrote retained evidence"
            else:
                assert not stored_result, f"stored manual result could not be reconciled: {exc}"
                assert "owning gateway is unavailable" in str(exc), exc
                assert file.exists(), "unknown manual result lost its retained evidence"
        if not compatible:
            failures.append(f"manual recovery ({'stored' if stored_result else 'unknown'} result) is unsupported")
        file.unlink(missing_ok=True)

    from tools import bot_live_delivery
    bot_live_delivery.find_canonical_live_owner = lambda *args: None
    if hasattr(bot_live_delivery, "find_canonical_owner"):
        bot_live_delivery.find_canonical_owner = lambda *args: None
    from cron import scheduler_delivery
    scheduler_delivery._deliver_to_bot_chat = deny_network
    root = home / "cron/bot_chat_pending"
    root.mkdir(parents=True, exist_ok=True)
    file = root / "delivery-original.json"
    record = {**fixture["botChat"], "home": str(home)}
    file.write_text(json.dumps(record))
    before = file.read_bytes()
    try:
        try:
            from cron.bot_chat_legacy import drain_legacy_pending
        except ModuleNotFoundError:
            from cron.bot_chat_delivery import drain
            drain(root)
        else:
            drain_legacy_pending()
    except Exception as exc:
        failures.append(f"pending Bot Chat drain failed: {type(exc).__name__}: {exc}")
    if file.read_bytes() != before:
        failures.append("pending Bot Chat drain changed a base-written record without a live owner")
    assert not failures, "; ".join(failures)
    print(f"PASS Agent {__version__}: retained v0.22.1 manual recovery and Bot Chat delivery formats")


if os.environ.get("TALARIA_AGENT_UPGRADE_PROBE") == "1":
    probe_retained_cron()
