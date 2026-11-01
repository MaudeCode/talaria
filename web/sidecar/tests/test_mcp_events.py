"""TAL-1510: ``mcp.events`` reads the installed Agent's own MCP events state; Talaria adds no event engine."""
import json
import pathlib
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, isolated_env, requires_agent
from test_mcp_discovery import STUB_SERVER

FIXTURE = pathlib.Path(__file__).resolve().parents[3] / "contracts" / "fixtures" / "mcp-events.json"


@requires_agent
def test_native_mcp_events_utilities_consent_and_subscription_state(tmp_path):
    stub = tmp_path / "stub_mcp_server.py"
    stub.write_text(STUB_SERVER)
    probe = pathlib.Path(__file__).with_name("probe_mcp_events.py")
    run = subprocess.run([AGENT_PYTHON, str(probe), str(AGENT_DIR), str(stub), str(FIXTURE)], env=isolated_env(tmp_path / ".hermes"),
                         capture_output=True, text=True, timeout=180)
    assert run.returncode == 0, run.stdout + run.stderr[-4000:]
    outcome = json.loads(run.stdout.strip().splitlines()[-1])
    if outcome.get("agent") == "without MCP events":
        assert not (pathlib.Path(AGENT_DIR) / "tools" / "mcp_tool_events.py").exists(), outcome
    else:
        assert outcome == {"utilities": "native", "consent": ["mcp-events/events", "mcp-events/events"], "states": "observed"}, outcome
