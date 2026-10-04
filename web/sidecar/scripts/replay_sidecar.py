#!/usr/bin/env python3
"""A scripted sidecar that replays the recorded fixtures and stages an approval.

The App contract runner and other consumers that need Web's HTTP surface but no
Hermes Agent point the server at this script with
``HERMES_WEBUI_SIDECAR_COMMAND='["python3", "<web>/sidecar/scripts/replay_sidecar.py"]'``.
Every recorded method answers with its first fixture (placeholders resolved to the
disposable home); ``chat.start`` emits one ``approval`` frame for
``pattern_key`` ``talaria_contract_fixture`` so the approval SSE stream can be
exercised end to end, then completes with a synthetic response. Nothing here
touches ``~/.hermes``, a model provider, or the network.

The App probe's ``talaria contract fixture`` message also stages a single-question
multi-select clarification after the approval is answered.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SIDECAR_ROOT))

from talaria_sidecar.rpc import RpcServer  # noqa: E402

FIXTURES = SIDECAR_ROOT.parent / "packages" / "contracts" / "fixtures" / "sidecar"
APPROVAL_PATTERN_KEY = "talaria_contract_fixture"
APPROVAL_COMMAND = "printf talaria-contract"
# ponytail: one fixture turn at a time; use per-session events for concurrent probe turns.
_APPROVAL_ANSWERED = threading.Event()
_CLARIFICATION_ANSWERED = threading.Event()


def _substitutions() -> list[tuple[str, str]]:
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    agent = os.environ.get("TALARIA_SIDECAR_AGENT_DIR") or os.environ.get("HERMES_WEBUI_AGENT_DIR") or str(SIDECAR_ROOT)
    return [("<profile>", home), ("<home>", home), ("<user-home>", str(Path(home).parent)), ("<agent>", agent), ("<python>", sys.executable)]


def _resolve(value, subs):
    if isinstance(value, str):
        for token, replacement in subs:
            value = value.replace(token, replacement)
        return value
    if isinstance(value, list):
        return [_resolve(item, subs) for item in value]
    if isinstance(value, dict):
        return {key: _resolve(item, subs) for key, item in value.items()}
    return value


def _replay(entry: dict):
    def handler(ctx, params):
        for frame in entry.get("stream") or []:
            ctx.emit(frame["event"], frame.get("data") or {})
        return entry["result"]
    return handler


def _chat_start(ctx, params: dict) -> dict:
    _APPROVAL_ANSWERED.clear()
    ctx.emit("approval", {"request_id": "talaria-contract-approval", "pattern_key": APPROVAL_PATTERN_KEY, "command": APPROVAL_COMMAND, "tool_name": "terminal", "cwd": params.get("workspace") or ""})
    # Like a real turn, stay pending until the approval is answered (or the request is cancelled / times out).
    for _ in range(200):
        if _APPROVAL_ANSWERED.wait(0.1) or ctx.cancelled:
            break
    if str(params.get("user_message", "")).endswith("talaria contract fixture") and not ctx.cancelled:
        _CLARIFICATION_ANSWERED.clear()
        ctx.emit("clarify", {"clarify_id": "talaria-contract-clarification", "question": "Which checks?", "choices_offered": ["unit", "ui"], "multi_select": True})
        for _ in range(200):
            if _CLARIFICATION_ANSWERED.wait(0.1) or ctx.cancelled:
                break
    ctx.emit("token", {"text": "talaria-contract"})
    history = [*params.get("conversation_history", []), {"role": "user", "content": params.get("user_message", "")}, {"role": "assistant", "content": "talaria-contract"}]
    return {
        "status": "completed", "messages": history, "final_response": "talaria-contract", "error": None, "failed": False, "partial": False, "compression_exhausted": False,
        "tool_limit_reached": False, "usage": {"prompt_tokens": 0, "completion_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "estimated_cost_usd": None},
        "context": {}, "model": params.get("model") or "replay", "provider": params.get("model_provider") or "replay", "compressed": False,
        "agent_session_id": params.get("session_id", ""), "token_sent": True, "pending_steer": "", "live_tool_calls": [],
    }


def _approval_respond(ctx, params: dict) -> dict:
    _APPROVAL_ANSWERED.set()
    return {"ok": True, "resolved": 1, "choice": str(params.get("choice") or "once")}


def _clarify_respond(ctx, params: dict) -> dict:
    _CLARIFICATION_ANSWERED.set()
    return {"ok": True}


def _shutdown(ctx, params: dict) -> dict:
    ctx.server.request_shutdown(int(params.get("exit_code") or 0))
    return {"ok": True}


def build_methods() -> dict:
    subs = _substitutions()
    methods = {}
    for path in sorted(FIXTURES.glob("*.json")):
        for method, entries in json.loads(path.read_text()).items():
            if entries:
                methods[method] = _replay(_resolve(entries[0], subs))
    handshake = methods["runtime.handshake"]
    methods["runtime.handshake"] = lambda ctx, params: {**handshake(ctx, params), "rpc_version": params.get("rpc_version", 1)}
    methods["chat.start"] = _chat_start
    methods["chat.interrupt"] = lambda ctx, params: {"ok": True, "reason": "replay"}
    methods["chat.steer"] = lambda ctx, params: {"accepted": True, "fallback": None}
    methods["chat.evict_agent"] = lambda ctx, params: {"evicted": False}
    methods["approval.respond"] = _approval_respond
    methods["clarify.respond"] = _clarify_respond
    methods["approval.pending"] = lambda ctx, params: {"pending": []}
    methods["approval.set_yolo"] = lambda ctx, params: {"yolo_enabled": bool(params.get("enabled")), "released": 0}
    # Every settled turn asks the goal judge (TAL-396); the replay holds no goal, so it answers as the sidecar does then.
    methods["goals.evaluate"] = lambda ctx, params: {"status": None, "should_continue": False, "continuation_prompt": None, "verdict": "inactive", "reason": "no active goal", "message": ""}
    methods["runtime.shutdown"] = _shutdown
    return methods


def main() -> int:
    out = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    sys.stdout = sys.stderr
    return RpcServer(build_methods(), stdout=out).serve_forever()


if __name__ == "__main__":
    sys.exit(main())
