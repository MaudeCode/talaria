"""Sidecar test harness: spawn ``python -m talaria_sidecar`` on the Agent venv.

Every test owns a disposable HERMES_HOME. The Agent checkout and interpreter
come from ``HERMES_WEBUI_AGENT_DIR`` / ``HERMES_WEBUI_PYTHON`` or the same
discovery rules the server uses (``~/.hermes/hermes-agent`` with its venv).
Tests never touch ``~/.hermes``.
"""

from __future__ import annotations

import json
import os
import pathlib
import queue
import shutil
import subprocess
import sys
import threading
import time

import pytest

SIDECAR_ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures"
HOME = pathlib.Path.home()


def discover_agent_dir() -> pathlib.Path | None:
    candidates = [
        os.environ.get("HERMES_WEBUI_AGENT_DIR", ""),
        str(pathlib.Path(os.environ.get("HERMES_HOME") or HOME / ".hermes") / "hermes-agent"),
        str(HOME / ".hermes" / "hermes-agent"),
        str(HOME / "hermes-agent"),
    ]
    for raw in candidates:
        if raw and (pathlib.Path(raw).expanduser() / "run_agent.py").exists():
            return pathlib.Path(raw).expanduser().resolve()
    return None


def discover_python(agent_dir: pathlib.Path | None) -> str | None:
    if os.environ.get("HERMES_WEBUI_PYTHON"):
        return os.environ["HERMES_WEBUI_PYTHON"]
    if agent_dir:
        for venv in ("venv", ".venv"):
            candidate = agent_dir / venv / "bin" / "python"
            if candidate.exists():
                return str(candidate)
    return None


AGENT_DIR = discover_agent_dir()
AGENT_PYTHON = discover_python(AGENT_DIR)
requires_agent = pytest.mark.skipif(AGENT_DIR is None or AGENT_PYTHON is None, reason="pinned Hermes Agent checkout with venv not found")


def isolated_env(hermes_home: pathlib.Path, *, home: pathlib.Path | None = None, **extra: str) -> dict[str, str]:
    """Environment for a process on the Agent's interpreter: a disposable home and only PATH from the caller."""
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(home or hermes_home.parent),
        "HERMES_HOME": str(hermes_home),
        "PYTHONPATH": str(SIDECAR_ROOT),
        # The Agent's hermes_state refuses paths that look like a test tree
        # unless told the state is disposable; every home here is.
        "HERMES_STATE_DB_GUARD_BYPASS": "1",
        # A tirith scan downloads tirith into the home and leaves a detached
        # threat-DB updater writing there after the test ends.
        "TIRITH_ENABLED": "0",
    }
    # GitHub's relocated Linux Python (actions/setup-python) only loads libpython with this set.
    if os.environ.get("LD_LIBRARY_PATH"):
        env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
    env.update(extra)
    return env


class SidecarProcess:
    """Drive one sidecar over stdio from a test."""

    def __init__(self, hermes_home: pathlib.Path, *, env: dict | None = None, python: str | None = None, agent_dir: pathlib.Path | None = None):
        environ = isolated_env(hermes_home, **{
            "TALARIA_SIDECAR_AGENT_DIR": str(agent_dir or AGENT_DIR or ""),
            "PYTHONUNBUFFERED": "1",
            "TALARIA_SIDECAR_LOG_LEVEL": "DEBUG",
            **(env or {}),
        })
        self.proc = subprocess.Popen(
            [python or AGENT_PYTHON or sys.executable, "-m", "talaria_sidecar"],
            cwd=str(SIDECAR_ROOT), env=environ, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self._next_id = 0
        self._lines: queue.Queue = queue.Queue()
        self.stderr_lines: list[str] = []
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self._lines.put(json.loads(line))
        self._lines.put(None)

    def _pump_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            self.stderr_lines.append(line.rstrip("\n"))

    def send(self, message: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def request(self, method: str, params: dict | None = None) -> int:
        self._next_id += 1
        self.send({"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params or {}})
        return self._next_id

    def next_message(self, timeout: float = 30.0) -> dict | None:
        return self._lines.get(timeout=timeout)

    def call(self, method: str, params: dict | None = None, *, timeout: float = 60.0) -> tuple[dict, list[dict]]:
        """Send a request and collect its stream frames until the response."""
        request_id = self.request(method, params)
        frames: list[dict] = []
        deadline = time.monotonic() + timeout
        while True:
            message = self._lines.get(timeout=max(0.1, deadline - time.monotonic()))
            if message is None:
                raise RuntimeError(f"sidecar exited before answering {method}: {self.stderr_lines[-10:]}")
            if message.get("method") == "stream" and message["params"]["id"] == request_id:
                frames.append(message["params"])
                continue
            if message.get("id") == request_id:
                return message, frames

    def result(self, method: str, params: dict | None = None, **kwargs) -> dict:
        message, _ = self.call(method, params, **kwargs)
        assert "error" not in message, message["error"]
        return message["result"]

    def close(self, timeout: float = 10.0) -> int:
        if self.proc.stdin:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return self.proc.wait(timeout=timeout)


@pytest.fixture(autouse=True)
def no_surviving_processes(tmp_path_factory: pytest.TempPathFactory):
    """Fail a test that leaves a process naming the session's temp tree running, so cleanup never races a writer."""
    yield
    base = str(tmp_path_factory.getbasetemp())
    listing = subprocess.run(["ps", "-eo", "pid=,ppid=,args="], capture_output=True, text=True, check=True).stdout
    rows = [(int(parts[0]), int(parts[1]), parts[2]) for parts in (line.split(None, 2) for line in listing.splitlines()) if len(parts) == 3]
    # The runner and its parents may name the temp tree themselves (--basetemp).
    parents, runner, pid = {pid: ppid for pid, ppid, _ in rows}, set(), os.getpid()
    while pid > 1 and pid not in runner:
        runner.add(pid)
        pid = parents.get(pid, 0)
    left = [(pid, args) for pid, _, args in rows if base in args and pid not in runner]
    for pid, _ in left:
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass
    assert not left, f"processes outlived the test: {left}"


@pytest.fixture
def hermes_home(tmp_path: pathlib.Path) -> pathlib.Path:
    home = tmp_path / "home" / ".hermes"
    home.mkdir(parents=True)
    return home


@pytest.fixture
def sidecar(hermes_home: pathlib.Path):
    if AGENT_DIR is None or AGENT_PYTHON is None:
        pytest.skip("pinned Hermes Agent checkout with venv not found")
    proc = SidecarProcess(hermes_home)
    yield proc
    proc.close()


@pytest.fixture
def handshaken(sidecar: SidecarProcess):
    """A sidecar that completed a compatible handshake."""
    from talaria_sidecar import SIDECAR_RPC_VERSION

    result = sidecar.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})
    assert result["compatible"], result
    return sidecar


def load_schema(method: str) -> dict:
    """Load the JSON Schema exported from the contracts package for a method result."""
    schemas = json.loads((FIXTURES / "schemas.json").read_text())
    return schemas[method]


def _type_ok(value, expected: str) -> bool:
    return {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "null": value is None,
    }[expected]


def validate(value, schema: dict, path: str = "$") -> list[str]:
    """Minimal JSON Schema (draft 2020-12 subset) validator: enough for Zod's output."""
    errors: list[str] = []
    if "anyOf" in schema:
        if not any(not validate(value, option, path) for option in schema["anyOf"]):
            errors.append(f"{path}: matches none of anyOf")
        return errors
    if "const" in schema and value != schema["const"]:
        return [f"{path}: expected const {schema['const']!r}"]
    if "enum" in schema and value not in schema["enum"]:
        return [f"{path}: {value!r} not in enum"]
    expected = schema.get("type")
    if isinstance(expected, list):
        if not any(_type_ok(value, option) for option in expected):
            return [f"{path}: {type(value).__name__} not one of {expected}"]
        expected = next(option for option in expected if _type_ok(value, option))
    elif isinstance(expected, str) and not _type_ok(value, expected):
        return [f"{path}: expected {expected}, got {type(value).__name__}"]
    if expected == "object":
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}.{key}: required")
        props = schema.get("properties", {})
        for key, sub in props.items():
            if key in value:
                errors.extend(validate(value[key], sub, f"{path}.{key}"))
        additional = schema.get("additionalProperties", True)
        if additional is False:
            for key in value:
                if key not in props:
                    errors.append(f"{path}.{key}: unexpected property")
        elif isinstance(additional, dict):
            for key in value:
                if key not in props:
                    errors.extend(validate(value[key], additional, f"{path}.{key}"))
    if expected == "array" and "items" in schema:
        for index, item in enumerate(value):
            errors.extend(validate(item, schema["items"], f"{path}[{index}]"))
    return errors


def assert_matches(method: str, value) -> None:
    errors = validate(value, load_schema(method))
    assert not errors, f"{method} result does not match the contract schema: {errors}"
