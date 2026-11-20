"""Record the server's gateway-owner event fixture from a real disposable owner on a supported Agent release.

Usage, from the repository root, on the cached active pin (``web/sidecar/scripts/test.sh`` creates the venv):
  python3 scripts/check-agent-compatibility.py --skip-docker --skip-sidecar-tests \
    --command web/sidecar/.venv/bin/python web/sidecar/tests/fixtures/record_gateway_owner_events.py

It runs gateway_session_peer.py's ``detail`` mode: a native turn that reasons, delegates one child and answers on a
loopback provider. The fixture keeps that turn's reasoning, subagent, usage and completion events, with the ids the
owner mints and the timings it measures pinned, so the same release reproduces the file byte for byte.
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from conftest import AGENT_DIR, AGENT_PYTHON, SIDECAR_ROOT  # noqa: E402
from test_gateway_sessions import peer_env  # noqa: E402

TARGET = SIDECAR_ROOT.parent / "packages/server/src/test/fixtures/gateway-owner-events.json"
KEPT = {"reasoning.delta", "session.usage", "message.complete"}
# Timings the owner measures, and a prompt size that grows with the host's temporary paths. The fixture's server test
# asserts no projection of them.
VARYING = {"avg_latency_s", "avg_tps", "tokens_per_s", "duration_seconds", "context_tokens"}
# A child's first thinking line is a face and verb the Agent draws at random from its spinner lists.
SPINNER = re.compile(r".+ [a-z]+\.\.\.")


def pinned(value, ids):
    if isinstance(value, dict):
        return {key: 1.0 if key in VARYING else pinned(item, ids) for key, item in value.items()}
    if isinstance(value, list):
        return [pinned(item, ids) for item in value]
    return ids.get(value, value) if isinstance(value, str) else value


def main():
    if AGENT_DIR is None or AGENT_PYTHON is None:
        sys.exit("set TALARIA_WEB_AGENT_DIR to a provisioned Agent checkout")
    revision = subprocess.check_output(["git", "-C", str(AGENT_DIR), "rev-parse", "HEAD"], text=True).strip()
    support = json.loads((SIDECAR_ROOT / "agent_support.json").read_text())["releases"]
    release = next((r["releaseTag"] for r in support if r["sourceRevision"] == revision), None)
    if release is None:
        sys.exit(f"{AGENT_DIR} is at {revision}, which no release in agent_support.json names")
    with tempfile.TemporaryDirectory(prefix="tal2523-") as tmp:
        run = subprocess.run([AGENT_PYTHON, str(Path(__file__).with_name("gateway_session_peer.py")), "detail"],
                             env=peer_env(Path(tmp).resolve()), capture_output=True, text=True, timeout=200, check=False)
    line = next((line for line in run.stdout.splitlines() if line.startswith("DETAIL ")), None)
    if run.returncode or line is None:
        sys.exit(f"the detail peer failed:\n{run.stdout}\n{run.stderr}")
    events = json.loads(line.removeprefix("DETAIL "))["events"]
    # The submitted turn alone: the follow-up turn the child's completion starts is the owner's own work.
    turn = next(e["admission_id"] for e in events if e["type"] == "reasoning.delta")
    events = [e for e in events if e.get("admission_id") == turn and (e["type"] in KEPT or e["type"].startswith("subagent."))]
    child = next(e["payload"] for e in events if e["type"] == "subagent.start")
    ids = {events[0]["session_id"]: "native-detail-session", events[0]["replay_epoch"]: "detail-replay-epoch", turn: "native-input",
           child["subagent_id"]: "detail-child", child["child_session_id"]: "detail-child-session",
           child["delegation_id"]: "detail-delegation"}
    ids.update((e["payload"]["text"], "(◔_◔) pondering...") for e in events
               if e["type"] == "subagent.thinking" and SPINNER.fullmatch(e["payload"]["text"]))
    # A kept event's seq counts the left-out events, which the child's relayed thinking races; the test reads none.
    events = [{key: value for key, value in e.items() if key != "seq"} for e in events]
    fixture = {"release": release, "revision": revision, "events": pinned(events, ids)}
    TARGET.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {len(events)} {release} events to {TARGET}")


if __name__ == "__main__":
    main()
