"""``connectors.*``: Nous tool-gateway apps over the Agent's portal client (TAL-818).

The page's reads and writes (catalog, accounts, remove, tools, policy) call ``PortalConnectorClient``; a connect
runs the Agent's account-owned operation (``tools.connectors.account``), and a chat's ``manage_connections`` card
registers its session operation here through ``remember_chat_operation``. Every call runs under the profile's
``scoped_home``; the server composes what the page and card show.
"""

from __future__ import annotations

import json
import logging
import threading
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.connectors")

# Operations the page or a chat card may still read, by (profile home, op_id). The Agent's ``live`` registry drops an
# operation once it settles, so its final state is kept here for the next poll.
# ponytail: a fixed cap, oldest out; an operation older than the last 64 reads as not found.
_OPS: OrderedDict[tuple[str, str], object] = OrderedDict()
_OPS_CAP = 64
_OPS_LOCK = threading.Lock()


def available() -> bool:
    try:
        from tools.connectors import connectors_available
    except Exception:  # noqa: BLE001 - an Agent without connectors
        return False
    return bool(connectors_available())


def _open() -> None:
    """The gate every page action passes: connectors available, and on an Agent with guest identities, one created
    for a user who has none (the page asking for apps is the user asking, as on the Agent's desktop)."""
    if not available():
        raise RpcError("Connectors are not available.", condition="connectors_unavailable")
    try:
        from tools.connectors import ensure_guest_identity
    except Exception:  # noqa: BLE001 - an Agent before guest identities
        return
    if failure := ensure_guest_identity():
        raise RpcError(failure, condition="connectors_failed")


def _portal():
    from tools.connectors.portal.client import PortalConnectorClient

    return PortalConnectorClient()


def _failure(exc: Exception) -> RpcError:
    """The Agent's connector errors as RPC conditions (its desktop RPC's reasons)."""
    from tools.connectors.gateway.errors import GatewayAuthError

    code = getattr(exc, "code", None)
    if isinstance(exc, GatewayAuthError):
        if code in {"no_access", "ORG_ACCESS_DENIED", "forbidden"}:
            return RpcError("This account cannot manage connectors.", condition="connectors_forbidden")
        return RpcError("Sign in to Nous Portal to use connectors.", condition="connectors_sign_in")
    if code == "policy_changed":
        return RpcError("Connector rules changed. Refresh and try again.", condition="policy_conflict")
    if code == "org_required":
        return RpcError("Select an organization to manage connector rules.", condition="connectors_org_required")
    if code in {"forbidden", "no_access"}:
        return RpcError("Connector rules cannot be changed for this account.", condition="connectors_forbidden")
    if code == "invalid_connector_policy" or (code == "HTTP_400" and getattr(exc, "status", None) == 400):
        return RpcError("Connector rule change is invalid.", condition="policy_invalid")
    if code == "connection_not_found":
        return RpcError("Connector account not found.", condition="connection_not_found")
    log.warning("connector request failed: %s", exc)
    return RpcError("Connector request failed.", condition="connectors_failed")


def _slug(params: dict, key: str = "connector") -> str:
    raw = params.get(key)
    from tools.connectors.portal.client import validate_slug
    from tools.connectors.portal.errors import InvalidConnectorSlug

    try:
        validate_slug(raw if isinstance(raw, str) else "")
    except InvalidConnectorSlug as exc:
        raise InvalidParams(f"{key} must be a connector slug") from exc
    return raw


def catalog() -> dict:
    rows = _portal().catalog().connectors
    return {"connectors": [row.model_dump(mode="json") for row in rows]}


def accounts() -> dict:
    return {"accounts": [{
        "connection_id": row["connectionId"], "connector": row["connector"], "status": row["status"],
        "status_reason": row.get("statusReason"), "label": row["label"], "alias": row.get("alias"),
        "active": bool(row["active"]), "disabled": bool(row.get("disabled")), "created_at": row["createdAt"],
    } for row in _portal().list_accounts()]}


def remove(connection_id: str) -> dict:
    removed = _portal().delete_account(connection_id)
    return {"connection_id": removed["connectionId"], "connector": removed["connector"], "status": removed["status"]}


def tools(slug: str, *, refresh: bool) -> dict:
    from tools.connectors.gateway.errors import GatewayUnavailable
    from tools.connectors.portal.tools_cache import read_tools

    client = _portal()
    client.require_authentication()
    try:
        listing = read_tools(slug, client=client, refresh=refresh)
    except GatewayUnavailable as exc:
        raise RpcError("Connector not found.", condition="connector_not_found") from exc
    keep = ("slug", "name", "description", "facet", "hints", "categories", "deprecated")
    return {"connector": listing.connector, "tools": [{k: v for k, v in tool.model_dump(mode="json").items() if k in keep} for tool in listing.tools]}


def policy() -> dict:
    client = _portal()
    client.require_authentication()
    current = client.policy()
    return {
        "layers": [{"kind": layer.kind, "revision": layer.revision, "body": layer.body.model_dump(mode="json", exclude_none=True)} for layer in current.layers],
        "effective": current.effective.model_dump(mode="json", exclude_none=True, exclude={"version", "issued_at_ms"}),
    }


def set_policy(connector: str, expected_revision: str, *, enabled: bool | None = None, tool: str | None = None, tool_enabled: bool | None = None) -> dict:
    """One member-layer change on top of the portal's current member rules: an app on or off, or one of its tools.
    The portal refuses the write when ``expected_revision`` is no longer its member revision."""
    from tools.connectors.portal.policy import InvalidMemberPolicy, compose_connector_write, compose_tools_write

    client = _portal()
    client.require_authentication()
    member = next((layer.body for layer in client.policy().layers if layer.kind == "member"), None)
    try:
        if tool is None:
            body = compose_connector_write(member, SimpleNamespace(connector=connector, enabled=bool(enabled)))
        else:
            rule = (getattr(member, "tools", None) or {}).get(connector)
            disabled = [name for name in (rule.disable if rule else []) if name != tool] + ([] if tool_enabled else [tool])
            body = compose_tools_write(member, SimpleNamespace(connector=connector, disabled_tools=disabled))
    except InvalidMemberPolicy as exc:
        raise RpcError("Connector rule change is invalid.", condition="policy_invalid") from exc
    body["expectedRevision"] = expected_revision
    return {"revision": client.set_policy(body).revision}


def _remember(home: Path, operation) -> None:
    with _OPS_LOCK:
        _OPS[(str(home), operation.op_id)] = operation
        _OPS.move_to_end((str(home), operation.op_id))
        while len(_OPS) > _OPS_CAP:
            _OPS.popitem(last=False)


def _operation(home: Path, op_id: str):
    with _OPS_LOCK:
        operation = _OPS.get((str(home), op_id))
    if operation is None:
        raise RpcError("No connection operation with that id.", condition="operation_not_found")
    return operation


def operation_view(operation) -> dict:
    """The operation as the sidecar reports it: every target's state, the vendor's text, the authorization link while
    the target waits on it (the Agent keeps a used link on a connected target), and the credentials an MCP install
    still asks for."""
    snapshot = operation.snapshot()
    return {
        "op_id": snapshot["op_id"],
        "settled": snapshot.get("settled_at") is not None,
        # The Connectors page's own operations are account-owned; a chat's carry the tool call that opened the card.
        "owner": "account" if operation.session_key.startswith("account:") else "session",
        "tool_call_id": operation.tool_call_id,
        "targets": [{
            "name": target["name"], "kind": target["kind"], "state": target["state"], "detail": target.get("detail") or "",
            "connect_url": target.get("connect_url") if target["state"] == "initiated" else None,
            "required_env": [{
                "name": str(field.get("name") or ""), "prompt": str(field.get("prompt") or ""), "required": bool(field.get("required")),
                "secret": bool(field.get("secret", True)),
            } for field in target.get("required_env") or [] if isinstance(field, dict) and field.get("name")],
        } for target in snapshot["targets"]],
    }


def connect(home: Path, connector: str) -> dict:
    """Start (or rejoin) the account-owned connect for ``connector`` and wait for its authorization link."""
    from tools.connectors import account
    from tools.connectors.contract import TargetState
    from tools.connectors.run import reissue

    start = account.find_or_start_operation([connector], action="connect", profile_home=str(home))
    _remember(home, start.operation)
    if not start.started:
        target = start.operation.target(connector)
        if target is not None and target.state in (TargetState.failed, TargetState.expired):
            reissue(start.operation, [connector])
        return operation_view(start.operation)
    if account.wait_for_prepare(start) and start.failed:
        raise RpcError("Connector request failed.", condition="connectors_failed")
    return operation_view(start.operation)


def respond(home: Path, op_id: str, action: str, target: str | None, env: dict) -> dict:
    """The card's move: Skip or Retry one target, Approve an MCP install with its credentials, or Continue."""
    from tools.connectors.contract import SettleReason
    from tools.connectors.run import apply_answer, reissue

    operation = _operation(home, op_id)
    if operation.settled:
        raise RpcError("The connection operation has settled.", condition="operation_settled")
    row = operation.target(target) if target else None
    if action != "continue" and row is None:
        raise InvalidParams("target must name a target of the operation")
    if action == "continue":
        apply_answer(operation, json.dumps({"settled_by": SettleReason.continue_.value}))
    elif action == "retry" and row.kind == "connector":
        if reissue(operation, [row.name]):
            raise RpcError("This target cannot be run again.", condition="operation_refused")
    else:
        status = "skipped" if action == "skip" else "approved"
        apply_answer(operation, json.dumps({"targets": [{"name": row.name, "status": status, "env": env}]}))
    operation.settle_if_all_resolved()
    return operation_view(operation)


def remember_chat_operation(home: Path, payload: dict) -> dict | None:
    """A chat's ``manage_connections`` card opened: keep its operation for the card's reads and moves, and answer the
    frame the turn streams. None when the Agent's registry no longer holds it."""
    from tools.connectors import live

    op_id = payload.get("op_id") if isinstance(payload, dict) else None
    operation = live.get_by_op_id(op_id, profile_home=str(home)) if isinstance(op_id, str) else None
    if operation is None:
        return None
    _remember(home, operation)
    return operation_view(operation)


def register(registry_) -> None:
    def page(params: dict, read):
        with scoped_home(profile_home_param(params)):
            _open()
            try:
                return read()
            except RpcError:
                raise
            except Exception as exc:  # noqa: BLE001 - the Agent's gateway errors become RPC conditions
                raise _failure(exc) from exc

    @registry_.method("connectors.available")
    def available_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"available": available()}

    @registry_.method("connectors.catalog")
    def catalog_(ctx: CallContext, params: dict) -> dict:
        return page(params, catalog)

    @registry_.method("connectors.accounts")
    def accounts_(ctx: CallContext, params: dict) -> dict:
        return page(params, accounts)

    @registry_.method("connectors.remove")
    def remove_(ctx: CallContext, params: dict) -> dict:
        connection_id = params.get("connection_id")
        if not isinstance(connection_id, str) or not connection_id:
            raise InvalidParams("connection_id is required")
        return page(params, lambda: remove(connection_id))

    @registry_.method("connectors.tools")
    def tools_(ctx: CallContext, params: dict) -> dict:
        slug = _slug(params)
        return page(params, lambda: tools(slug, refresh=params.get("refresh") is True))

    @registry_.method("connectors.policy.get")
    def policy_(ctx: CallContext, params: dict) -> dict:
        return page(params, policy)

    @registry_.method("connectors.policy.set")
    def set_policy_(ctx: CallContext, params: dict) -> dict:
        slug = _slug(params)
        revision = params.get("expected_revision")
        if not isinstance(revision, str) or not revision:
            raise InvalidParams("expected_revision is required")
        tool = params.get("tool")
        if tool is None:
            if not isinstance(params.get("enabled"), bool):
                raise InvalidParams("enabled is required")
            return page(params, lambda: set_policy(slug, revision, enabled=params["enabled"]))
        if not isinstance(tool, str) or not tool or not isinstance(params.get("tool_enabled"), bool):
            raise InvalidParams("tool and tool_enabled are required together")
        return page(params, lambda: set_policy(slug, revision, tool=tool, tool_enabled=params["tool_enabled"]))

    @registry_.method("connectors.connect")
    def connect_(ctx: CallContext, params: dict) -> dict:
        slug = _slug(params)
        home = profile_home_param(params)
        return page(params, lambda: connect(home, slug))

    @registry_.method("connectors.operation")
    def operation_(ctx: CallContext, params: dict) -> dict:
        home = profile_home_param(params)
        with scoped_home(home):
            return operation_view(_operation(home, str(params.get("op_id") or "")))

    @registry_.method("connectors.respond")
    def respond_(ctx: CallContext, params: dict) -> dict:
        home = profile_home_param(params)
        action = params.get("action")
        if action not in ("skip", "retry", "approve", "continue"):
            raise InvalidParams("action must be skip, retry, approve or continue")
        target = params.get("target")
        env = params.get("env") or {}
        if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
            raise InvalidParams("env must map names to strings")
        with scoped_home(home):
            return respond(home, str(params.get("op_id") or ""), action, target if isinstance(target, str) else None, env)
