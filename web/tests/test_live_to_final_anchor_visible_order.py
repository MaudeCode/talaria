"""Visible-order contract for the first anchor-backed Compact Worklog handoff."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
ROUTES_PY = (ROOT / "api" / "routes.py").read_text(encoding="utf-8")
NODE = shutil.which("node")


def _function_body(src, name):
    start = src.find(f"function {name}")
    assert start != -1, f"{name} not found"
    params = src.find("(", start)
    assert params != -1, f"{name} params not found"
    depth = 0
    close = -1
    for idx in range(params, len(src)):
        if src[idx] == "(":
            depth += 1
        elif src[idx] == ")":
            depth -= 1
            if depth == 0:
                close = idx
                break
    assert close != -1, f"{name} params did not close"
    brace = src.find("{", close)
    depth = 0
    for idx in range(brace, len(src)):
        if src[idx] == "{":
            depth += 1
        elif src[idx] == "}":
            depth -= 1
            if depth == 0:
                return src[brace + 1:idx]
    raise AssertionError(f"{name} body did not close")


def _event_listener_body(src, event_name):
    marker = f"source.addEventListener('{event_name}',e=>{{"
    start = src.find(marker)
    if start == -1:
        marker = f"es.addEventListener('{event_name}', e => {{"
        start = src.find(marker)
    assert start != -1, f"{event_name} listener not found"
    brace = src.find("{", start)
    depth = 0
    for idx in range(brace, len(src)):
        if src[idx] == "{":
            depth += 1
        elif src[idx] == "}":
            depth -= 1
            if depth == 0:
                return src[brace + 1:idx]
    raise AssertionError(f"{event_name} listener did not close")


def _run_node_script(script):
    assert NODE, "node is required for DOM-executed anchor render tests"
    result = subprocess.run([NODE, "-e", script], text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


_EXTRACT_FUNC_JS = """
function extractFunc(name){
  const start = src.indexOf('function ' + name);
  if(start === -1) throw new Error(name + ' not found');
  const params = src.indexOf('(', start);
  let depth = 0, close = -1;
  for(let i=params; i<src.length; i++){
    if(src[i] === '(') depth++;
    else if(src[i] === ')'){
      depth--;
      if(depth === 0){ close = i; break; }
    }
  }
  const brace = src.indexOf('{', close);
  depth = 0;
  for(let i=brace; i<src.length; i++){
    if(src[i] === '{') depth++;
    else if(src[i] === '}'){
      depth--;
      if(depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(name + ' body did not close');
}
""".strip()


def test_server_started_turn_payload_carries_pending_started_at():
    recovery = ROUTES_PY.split("source\": \"subscribe_recovery\"", 1)[0].rsplit("try:", 1)[-1]
    assert "recover_session = get_session(sid, metadata_only=True)" in recovery
    assert "pending_started_at = getattr(recover_session, \"pending_started_at\", None)" in recovery
    assert '"pending_started_at": pending_started_at' in ROUTES_PY
    assert '"pending_started_at": getattr(session, "pending_started_at", None)' not in ROUTES_PY
    assert '"pending_started_at": (resp or {}).get("pending_started_at")' in ROUTES_PY


    # #5942/#5943: the restore path no longer forces {mode:'compact_worklog'} — it
    # resolves the active display mode so a transparent session restores as
    # transparent (not a compact grouped frame). The call itself is asserted above.
