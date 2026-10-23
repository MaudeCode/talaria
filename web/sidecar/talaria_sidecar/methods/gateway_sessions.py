"""Authenticated observations, fenced controls and diagnostic creation through an existing native owner.

Never ensure/start a gateway, build an Agent, or write its transcript locally.
Each call owns its connection and subscription; cancellation only detaches it.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, closing, suppress
from importlib.util import find_spec
import json
from pathlib import Path
import re
import sqlite3

from ..errors import InvalidParams
from ..home import profile_home_param, scoped_home

_ACTIONS = {"snapshot", "watch", "context_detail", "submit", "receipt", "cancel", "steer_queued", "replace_queued", "interrupt", "approval", "clarify",
            "clarify_lock", "discard", "mutate", "export", "checkpoint_diff"}
_OWNER_READ_MAX_BYTES = 4 * 1024 * 1024
# A restart's after-turn wait keeps the owner reachable only to finish its parked turn (the owner's
# RESTART_WAIT_WS_METHODS); new work waits for the next owner.
_RESTART_ACTIONS = {"snapshot", "watch", "receipt", "approval", "clarify", "clarify_lock", "interrupt"}
_CAPABILITIES = {"durable-admission-v1", "event-replay-v1"}
_CONTROL_REFUSALS = {"native_clarify_batch_unavailable", "owner_controls_unverified"}
_CREATE_FIELDS = {"request_id", "source", "cwd", "model", "provider", "base_url", "toolsets", "safe_mode", "ignore_user_config"}


def _batch_locks() -> bool:
    """v0.22.3 owners serve ``clarify.lock``, so an attached viewer can answer a clarify batch per question."""
    return find_spec("gateway.session_clarify_lock") is not None


def _restart_wait(home: Path) -> bool:
    """Whether the owner has entered a restart's after-turn wait since a watch attached. The owner announces
    it on no socket, and the watch must not send on its own: a socket opened before the wait is cut when it does."""
    from hermes_cli import gateway_runtime
    if not hasattr(gateway_runtime, "attachable"):
        return False
    try:
        found = gateway_runtime.discover_gateway_endpoint(home)
    except Exception:  # noqa: BLE001 - a failed probe leaves the watch as it was; every action rediscovers anyway
        return False
    return found.state != "ready" and gateway_runtime.attachable(found)


def _control_refusal(home: Path, sid: str) -> str | None:
    """Only canonical PendingControls can be recovered before v0.22.3. Never infer a missing batch.

    Read the owner's committed admission in a read-only connection; opening SessionDB here
    would run its schema writer alongside the owner. Compression keeps the logical target.
    """
    try:
        with closing(sqlite3.connect((home / "state.db").as_uri() + "?mode=ro", uri=True, timeout=2)) as db:
            rows = db.execute("""SELECT payload_json FROM session_admissions
                WHERE target_session_id=? AND status IN ('queued', 'started')""", (sid,))
            for (raw,) in rows:
                payload = json.loads(raw)
                policy = payload.get("cli_turn_v1", {})
                if not isinstance(policy, dict):
                    return "owner_controls_unverified"
                if "clarify_batch" in policy and not isinstance(policy["clarify_batch"], bool):
                    return "owner_controls_unverified"
                if policy.get("clarify_batch") is True and not _batch_locks():
                    return "native_clarify_batch_unavailable"
    except (sqlite3.Error, OSError, ValueError, TypeError, AttributeError):
        return "owner_controls_unverified"
    return None


def _snapshot(value: dict) -> dict:
    # Raw conversation rows contain private principal/admission metadata; the client needs
    # display rows, not those bindings or the inventory's system prompt and credential hint.
    message_keys = {"role", "content", "tool_calls", "tool_call_id", "name", "timestamp", "message_id", "row_id",
                    "reasoning", "reasoning_content", "display_kind", "finish_reason"}
    info_keys = {"title", "model", "cwd", "source", "provider", "config_warning"}
    return {**value, "messages": [{k: v for k, v in row.items() if k in message_keys} for row in value["messages"]],
            "info": {k: v for k, v in value["info"].items() if k in info_keys}}


def _refused(state: str, reason: str) -> dict:
    return {"state": state, "reason": reason, "snapshot": None, "receipt": None}


@asynccontextmanager
async def _connect(home: Path, endpoint):
    from hermes_constants import get_hermes_home
    from hermes_cli.gateway_client import GatewayClientError, connect_gateway

    # The supplied endpoint selects the native client's attach-only branch. The home
    # override is mandatory so its bootstrap ticket cannot fall back to the launch profile.
    if Path(get_hermes_home()).resolve() != home:
        raise GatewayClientError("profile_mismatch")
    async with connect_gateway(endpoint) as client:
        websocket = client.websocket
        # GatewayClient queues server requests as events. Drain continuously, including
        # during an RPC, so unsupported sudo/secure inputs never wait for a Web renderer.
        events = asyncio.Queue(maxsize=4096)

        async def drain():
            while True:
                frame = await client.events.get()
                if isinstance(frame, dict) and frame.get("method") in {"sudo", "secret"} and "id" in frame:
                    await websocket.send(json.dumps({"jsonrpc": "2.0", "id": frame["id"], "result": {"value": ""}}))
                else:
                    await events.put(frame)

        reader = asyncio.create_task(drain())
        try:
            yield client, events
        finally:
            reader.cancel()
            with suppress(asyncio.CancelledError):
                await reader


def _served(home: Path, endpoint, *, allow_verified: bool = False) -> bool:
    if not endpoint.control_home or Path(endpoint.control_home).resolve() == home:
        return False
    if not allow_verified:
        return True
    # The private control socket reports the owner's boot revision, not the sidecar's
    # checkout or a version label. The authenticated describe must still match below.
    try:
        record = json.loads((Path(__file__).resolve().parents[2] / "agent_support.json").read_text())
        revisions = record["nativeContracts"]["served-local-policy-v1"]
        return (not isinstance(revisions, list)
                or not all(isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha) for sha in revisions)
                or getattr(endpoint, "code_sha", None) not in revisions)
    except (OSError, ValueError, KeyError, TypeError):
        return True


def _owner_refusal(described: dict, endpoint) -> dict | None:
    if (not isinstance(described, dict)
            or described.get("instance_id") != endpoint.instance_id
            or described.get("profile_id") != endpoint.profile_id
            or type(described.get("authority_epoch")) is not int
            or described.get("authority_epoch") != endpoint.authority_epoch
            or not isinstance(described.get("capabilities"), list)
            or not all(isinstance(capability, str) for capability in described["capabilities"])
            or not _CAPABILITIES.issubset(described.get("capabilities", []))):
        return _refused("incompatible", "owner_capabilities")
    return None


def _checkpoint_read(value, *, no_baseline=False):
    comparison = {"provenance": "native_owner", "baseline": "earliest_retained_project_checkpoint",
                  "available": False, "reason": None, "truncated": False}
    result = {"diff": "", "stat": "", "comparison": comparison}
    reason = None
    if not isinstance(value, dict) or type(value.get("enabled")) is not bool:
        reason = "invalid_payload"
    elif not value["enabled"]:
        reason = "checkpoints_disabled"
    elif value.get("success") is not True:
        reason = "checkpoint_unavailable"
    elif (not isinstance(value.get("diff"), str) or not isinstance(value.get("stat"), str)
          or type(value.get("diff_lines")) is not int or value["diff_lines"] < 0
          or type(value.get("empty")) is not bool):
        reason = "invalid_payload"
    elif sum(len(json.dumps(value[key], ensure_ascii=False).encode("utf-8", "surrogatepass")) - 2
             for key in ("stat", "diff")) > _OWNER_READ_MAX_BYTES:
        reason = "payload_too_large"
    elif no_baseline:
        reason = "no_baseline"
    else:
        result.update(diff=value["diff"], stat=value["stat"])
        comparison.update(available=True, truncated=value["diff_lines"] > len(value["diff"].splitlines()))
    comparison["reason"] = reason
    return result


async def _run(ctx, params: dict, home: Path, discovery) -> dict:
    from hermes_cli.gateway_client import GatewayRPCError

    endpoint = discovery.endpoint
    if _served(home, endpoint, allow_verified=True):
        return _refused("incompatible", "served_profile_sessions_unavailable")
    restarting = discovery.state != "ready"
    if restarting and params["action"] not in _RESTART_ACTIONS:
        return _refused("refused", "gateway_restarting")
    subscription = None
    async with _connect(home, endpoint) as (client, events):
        described = await client.rpc("runtime.describe")
        if refusal := _owner_refusal(described, endpoint):
            return refusal
        sid = params["session_id"]

        async def snapshot():
            nonlocal subscription, sid
            value = await client.rpc("session.resume", session_id=sid)
            sid = value["session_id"]
            # Native attach reuses this actor's subscription; overflow retires it before
            # a replacement is issued. A resume does not accumulate live subscriptions.
            subscription = value["subscription_id"]
            if reason := await asyncio.to_thread(_control_refusal, home, sid):
                raise GatewayRPCError(reason)
            return _snapshot(value)

        receipt = lock = None
        try:
            if params["action"] == "checkpoint_diff":
                # The owner resolves the physical target and frozen policy. Never resume or read host files.
                value = await asyncio.wait_for(client.rpc("rollback.session_diff", session_id=sid, _timeout=25), timeout=30)
                read = _checkpoint_read(value)
                if read["comparison"]["available"] and value["empty"] and not value["diff"] and not value["stat"]:
                    listed = await asyncio.wait_for(client.rpc("rollback.list", session_id=sid, _timeout=3), timeout=3)
                    if (not isinstance(listed, dict) or listed.get("enabled") is not True
                            or not isinstance(listed.get("checkpoints"), list)):
                        read = _checkpoint_read(None)
                    elif not listed["checkpoints"]:
                        read = _checkpoint_read(value, no_baseline=True)
                return {"state": "attached", "reason": None, "snapshot": None, "receipt": None, "checkpoint_diff": read}
            if params["action"] == "export":
                # No resume/subscription or mutation: the owner selects its current physical target.
                fmt = "md" if params["format"] == "markdown" else params["format"]
                value = await asyncio.wait_for(client.rpc("session.export", session_id=sid,
                    format=fmt, redact=params["redact"], _timeout=25), timeout=30)
                if (not isinstance(value, dict) or value.get("format") != fmt
                        or not isinstance(value.get("filename"), str) or not 0 < len(value["filename"]) <= 255
                        or not isinstance(value.get("content"), str)):
                    return _refused("refused", "owner_export_invalid")
                if len(value["content"]) > _OWNER_READ_MAX_BYTES or len(value["content"].encode("utf-8")) > _OWNER_READ_MAX_BYTES:
                    return _refused("refused", "export_too_large")
                return {"state": "attached", "reason": None, "snapshot": None, "receipt": None,
                        "export": {"format": params["format"], "filename": value["filename"], "content": value["content"]}}
            snap = await snapshot()
            action = params["action"]
            common = {"session_id": sid}
            if action == "context_detail":
                from ..context_detail import project, unavailable
                # The authorized native read owns lookup and prompt interpretation. No local Agent is built.
                try:
                    payload = await client.rpc("session.context_breakdown", **common)
                    usage = None
                    with suppress(Exception):
                        usage = await client.rpc("session.stats", **common)
                    after = await snapshot()
                    marks = ("session_id", "stored_session_id", "authority_epoch", "replay_epoch", "revision", "execution_generation", "running", "last_sequence")
                    stable = all(snap.get(k) == after.get(k) for k in marks) and snap.get("info") == after.get("info")
                    detail = project(payload, usage=usage, running=after.get("running") is True) if stable else unavailable("changed")
                except Exception:  # unsupported owners and failed reads never authorize a fallback Agent
                    detail = unavailable("unsupported")
                return {"state": "attached", "reason": None, "snapshot": snap, "receipt": None, "context_detail": detail}
            if action == "submit":
                # The caller retains this identity across lost ACKs. An ambiguous error never
                # causes this adapter to generate a replacement or replay started work.
                receipt = await client.rpc("prompt.submit", **common, submission_id=params["request_id"], text=params["text"])
            elif action == "receipt":
                receipt = await client.rpc("prompt.receipt", **common, admission_id=params["admission_id"])
            elif action in {"cancel", "discard"}:
                method = "prompt.cancel" if action == "cancel" else "prompt.resolve_unknown"
                receipt = await client.rpc(method, **common, admission_id=params["admission_id"],
                    **({"execution_generation": params["execution_generation"]} if action == "discard" else {}))
            elif action in {"steer_queued", "replace_queued"}:
                receipt = await client.rpc("prompt." + action, **common, admission_id=params["admission_id"],
                    **({"submission_id": params["submission_id"], "text": params["text"]} if action == "replace_queued" else {}))
            elif action == "interrupt":
                await client.rpc("session.interrupt", **common, execution_generation=params["execution_generation"])
            elif action == "clarify_lock":
                # The lock that answers the last question settles the batch with every locked answer.
                lock = await client.rpc("clarify.lock", request_id=params["request_id"],
                                        question_id=params["question_id"], answer=params["answer"])
            elif action in {"approval", "clarify"}:
                await client.rpc(action + ".respond", **common, prompt_id=params["prompt_id"],
                    execution_generation=params["execution_generation"],
                    **({"choice": params["choice"]} if action == "approval" else {"answer": params["text"]}))
            elif action == "mutate":
                receipt = await client.rpc("session.mutate", **common, request_id=params["request_id"],
                    expected_revision=params["expected_revision"], expected_generation=params["execution_generation"],
                    operation=params["operation"], payload=params["payload"], _timeout=660)
            if action not in {"snapshot", "watch"}:
                snap = await snapshot()
            result = {"state": "attached", "reason": None, "snapshot": snap, "receipt": receipt, "restarting": restarting,
                      **({"lock": lock} if action == "clarify_lock" else {})}
            if action != "watch":
                return result
            # Display negotiation is best effort on older owners. It changes no persisted config.
            if isinstance(params.get("show_reasoning"), bool):
                with suppress(GatewayRPCError, TimeoutError):
                    await client.rpc("config.set", **common, key="show_reasoning",
                                     value="1" if params["show_reasoning"] else "0", _timeout=10)
            ctx.emit("snapshot", {**result, "replaying": True})
            epoch, sequence = snap["replay_epoch"], snap["last_sequence"]
            # Rebuild the active turn's display from retained events, even when its initial
            # tokens predate this viewer. A gap replaces the subscription, never invents replay.
            replay = await client.rpc("session.events.since", **common, replay_epoch=epoch, last_sequence=0)
            if replay.get("snapshot_required"):
                snap = await snapshot()
                ctx.emit("snapshot", {**result, "snapshot": snap, "replay_gap": True, "replaying": True})
                epoch, sequence = snap["replay_epoch"], snap["last_sequence"]
            else:
                for event in replay["events"]:
                    if event.get("session_id") != sid or event.get("replay_epoch") != epoch:
                        continue
                    if (event.get("type") in {"session.updated", "notification.show", "notification.clear"}
                            or event.get("execution_generation") == snap["execution_generation"]
                            or event.get("type") == "session.info" and event.get("payload", {}).get("execution_generation") == snap["execution_generation"]):
                        ctx.emit("event", event)
                sequence = replay["last_sequence"]
            ctx.emit("replay_complete", {})
            checked = asyncio.get_running_loop().time()
            while not ctx.cancelled:
                try:
                    frame = await asyncio.wait_for(events.get(), .25)
                except TimeoutError:
                    now = asyncio.get_running_loop().time()
                    if not restarting and now - checked >= 2:
                        checked = now
                        # One-way for this owner: its next state is exit, which ends the watch.
                        if restarting := await asyncio.to_thread(_restart_wait, home):
                            result["restarting"] = True
                            ctx.emit("restarting", {"restarting": True})
                    continue
                if isinstance(frame, Exception):
                    raise frame
                if frame.get("method") == "clarify" and "id" in frame:
                    if not _batch_locks():
                        raise GatewayRPCError("native_clarify_batch_unavailable")
                    # The owner asks attached viewers only, once; its later request.cancel event settles it.
                    request = frame.get("params", {})
                    if request.get("session_id") == sid:
                        ctx.emit("clarify_batch", {"request_id": frame["id"], "questions": request.get("questions", [])})
                    continue
                if frame.get("method") != "event":
                    continue
                event = frame.get("params", {})
                if event.get("session_id") != sid:
                    continue
                if event.get("type") == "session.info":
                    if reason := await asyncio.to_thread(_control_refusal, home, sid):
                        raise GatewayRPCError(reason)
                if (event.get("type") == "session.replay_gap" or event.get("replay_epoch") != epoch
                        or event.get("seq", sequence + 1) > sequence + 1):
                    current = await snapshot()
                    # A queued frame from an obsolete epoch is not a gap in the current subscription.
                    if (event.get("type") != "session.replay_gap" and event.get("replay_epoch") != epoch
                            and current["replay_epoch"] == epoch):
                        continue
                    snap = current
                    ctx.emit("snapshot", {**result, "snapshot": snap, "replay_gap": True})
                    epoch, sequence = snap["replay_epoch"], snap["last_sequence"]
                    continue
                if event.get("seq", 0) <= sequence:
                    continue
                sequence = event["seq"]
                ctx.emit("event", event)
            return result
        except GatewayRPCError as exc:
            if params["action"] == "export":
                return _refused("refused", "export_too_large" if str(exc) == "export_too_large" else "owner_export_unsupported")
            return {**_refused("incompatible" if str(exc) in _CONTROL_REFUSALS else "refused", str(exc)), "receipt": receipt}
        except Exception:  # noqa: BLE001 - native transport/contract failures never authorize another writer
            # A received receipt remains admission proof even if the following observation
            # disconnects. Losing that ACK would invite a new request identity for admitted work.
            return {**_refused("unavailable", "owner_connection_lost"), "receipt": receipt}
        finally:
            if subscription:
                with suppress(Exception):
                    await client.rpc("session.detach", session_id=sid, subscription_id=subscription)


def session(ctx, params: dict) -> dict:
    home = profile_home_param(params).resolve()
    action = params.get("action", "snapshot")
    sid = params.get("session_id")
    if action not in _ACTIONS or not isinstance(sid, str) or not sid.strip() or sid != sid.strip():
        raise InvalidParams("session_id and supported action are required")
    params = {**params, "action": action}
    if action == "export" and (params.get("format") not in ("json", "markdown", "html")
                               or not isinstance(params.get("redact"), bool)):
        raise InvalidParams("export requires an allowed format and redaction policy")
    required = {
        "submit": ("request_id", "text"), "receipt": ("admission_id",), "cancel": ("admission_id",),
        "steer_queued": ("admission_id",), "replace_queued": ("admission_id", "submission_id", "text"),
        "interrupt": ("execution_generation",), "approval": ("execution_generation", "prompt_id", "choice"),
        "clarify": ("execution_generation", "prompt_id", "text"), "clarify_lock": ("request_id", "question_id", "answer"), "discard": ("execution_generation", "admission_id"),
        "mutate": ("request_id", "expected_revision", "execution_generation", "operation", "payload"),
    }.get(action, ())
    if any(key not in params for key in required):
        raise InvalidParams("missing gateway session action fields")
    return _with_owner(home, lambda discovery: _run(ctx, params, home, discovery))


def _with_owner(home: Path, run) -> dict:
    try:
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override  # noqa: F401
        from hermes_cli import gateway_runtime
        from hermes_cli.gateway_client import connect_gateway  # noqa: F401
    except ImportError:
        return _refused("incompatible", "native_sessions_unavailable")
    # v0.22.3 also admits a restart's after-turn wait, so a parked approval or clarify can still be answered.
    attachable = getattr(gateway_runtime, "attachable", lambda found: found.state == "ready")
    with scoped_home(home):
        discovery = gateway_runtime.discover_gateway_endpoint(home)
        if discovery.endpoint is None or not attachable(discovery):
            return _refused("stopped" if discovery.state in {"stopped", "absent"} else "unavailable", discovery.reason_code or discovery.state)
        try:
            return asyncio.run(run(discovery))
        except Exception:  # noqa: BLE001 - native transport/contract failures never authorize another writer
            # Do not expose peer diagnostics, endpoint paths or bootstrap credentials.
            return _refused("unavailable", "owner_connection_lost")


async def _create(params: dict, home: Path, discovery) -> dict:
    """Mint one diagnostic session through the owner, which freezes the bypass in its creation
    policy and runs every turn in a fresh private worker. Talaria never imports the Agent with
    that policy, flips a process global or passes it through the environment."""
    from hermes_cli.gateway_client import GatewayRPCError

    endpoint = discovery.endpoint
    if _served(home, endpoint):
        return _refused("incompatible", "served_profile_sessions_unavailable")
    if discovery.state != "ready":
        return _refused("unavailable", "gateway_restarting")
    async with _connect(home, endpoint) as (client, _):
        described = await client.rpc("runtime.describe")
        if refusal := _owner_refusal(described, endpoint):
            return refusal
        accepted = set((described.get("session_create") or {}).get("parameters", []))
        if "local-cli-create-v1" not in described.get("capabilities", []) or not _CREATE_FIELDS.issubset(accepted):
            return _refused("incompatible", "execution_mode_unavailable")
        if params.get("probe") is True:
            return {"state": "attached", "reason": None, "snapshot": None, "receipt": None}
        fields = {key: params[key] for key in ("cwd", "model", "provider", "base_url", "toolsets") if params.get(key) is not None}
        try:
            # Safe implies config-only; the owner normalizes it too. No credential is sent or receipted.
            created = await client.rpc("session.create", request_id=params["request_id"], source="cli", **fields,
                                       safe_mode=params["execution_mode"] == "safe", ignore_user_config=True)
        except GatewayRPCError as exc:
            return _refused("refused", str(exc))
        with suppress(Exception):
            await client.rpc("session.detach", session_id=created["session_id"], subscription_id=created["subscription_id"])
        return {"state": "attached", "reason": None, "snapshot": _snapshot(created), "receipt": None}


def _text(params: dict, key: str, required: bool = True) -> bool:
    value = params.get(key)
    if value is None:
        return not required
    return isinstance(value, str) and bool(value) and value == value.strip()


def create(params: dict) -> dict:
    """``probe`` answers whether this owner can create diagnostic sessions, without creating one."""
    home = profile_home_param(params).resolve()
    toolsets = params.get("toolsets")
    if params.get("probe") is not True and (
            params.get("execution_mode") not in {"ignore_config", "safe"}
            or not _text(params, "request_id") or len(params["request_id"]) > 128
            or not _text(params, "model") or not _text(params, "cwd") or not Path(params["cwd"]).is_absolute()
            or not _text(params, "provider", False) or not _text(params, "base_url", False)
            or toolsets is not None and (not isinstance(toolsets, list) or not all(isinstance(t, str) and t for t in toolsets))):
        raise InvalidParams("execution_mode, request_id, model and an absolute cwd are required")
    return _with_owner(home, lambda discovery: _create(params, home, discovery))
