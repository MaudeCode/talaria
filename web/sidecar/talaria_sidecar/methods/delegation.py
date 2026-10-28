"""Native delegation registry and route validation for the auxiliary settings owner."""

from __future__ import annotations

from dataclasses import asdict

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home


def registry(config: dict) -> dict:
    section = config.get("delegation")
    section = section if isinstance(section, dict) else {}
    try:
        from agent.delegation_backends import list_backends
        from agent.delegation_registry import backend_status, configured_backend
    except ImportError:
        configured = section.get("backend") or "default"
        return {"supported": False, "configured": configured, "effective": None, "available": False,
                "blocked_reason": "Update Hermes Agent to configure delegation modes.", "fixed_model_active": configured == "default",
                "backends": [{"name": configured, "label": configured, "description": "", "available": False, "reason": "Update Hermes Agent."}], "profiles": []}
    from hermes_cli.plugins import discover_plugins
    from hermes_cli.profiles import list_profile_names

    discover_plugins()
    configured = configured_backend(section)
    provider, reason = backend_status(configured)
    available = provider is not None and not reason
    backends = [asdict(info) for info in list_backends()]
    if not any(info["name"] == configured for info in backends):
        backends.append({"name": configured, "label": configured, "description": "", "available": False, "reason": reason})
    return {"supported": True, "configured": configured, "effective": configured if available else None,
            "available": available, "blocked_reason": reason or None, "fixed_model_active": available and configured == "default",
            "backends": backends, "profiles": list_profile_names()}


def clean_routes(backend: str, block: dict, current: dict) -> dict:
    """Use native canonical keys and parsers, preserving credentials by original route identity."""
    from agent.delegation_provider import ROUTE_KEYS
    from agent.fast_mode import STATIC_TIERS, parse_exact_service_tier
    from hermes_constants import parse_reasoning_effort
    from hermes_cli.profiles import list_profile_names

    field = "options" if backend == "model_map" else "profiles"
    entries = block.get(field)
    if not isinstance(entries, list):
        raise InvalidParams(f"{field} must be a list")
    stored = {row.get("name"): row for row in current.get(field, []) if isinstance(row, dict)}
    known = set(list_profile_names()) if backend == "profile_routes" else set()
    rows, names = [], []
    for entry in entries:
        if not isinstance(entry, dict):
            raise InvalidParams("Each route must be an object")
        name = str(entry.get("name") or "").strip()
        if not name or name in names:
            raise InvalidParams("Route names must be nonempty and unique")
        names.append(name)
        if backend == "profile_routes":
            if name not in known:
                raise InvalidParams(f"Profile {name!r} does not exist")
            rows.append({"name": name, **({"description": entry["description"].strip()} if entry.get("description", "").strip() else {})})
            continue
        source = stored.get(entry.get("original_name") or name, {})
        # Hidden canonical values survive both edits and renames.
        row = {key: value for key, value in source.items() if key in ROUTE_KEYS}
        row.update({key: value for key, value in entry.items() if key in ROUTE_KEYS or key in {"name", "description"}})
        row["name"] = name
        for key in ("description", "model", "provider", "base_url", "api_mode"):
            if key in row:
                row[key] = str(row[key] or "").strip()
        if not row.get("description") or not row.get("model") or not (row.get("provider") or row.get("base_url")):
            raise InvalidParams(f"Route {name!r} needs a description, model and provider or endpoint")
        for key in ("reasoning_effort", "service_tier"):
            if key in entry and not entry[key]:
                row.pop(key, None)
        effort = row.get("reasoning_effort")
        if effort and parse_reasoning_effort(effort) is None:
            raise InvalidParams("Unknown reasoning effort")
        tier = row.get("service_tier")
        if tier:
            try:
                parsed = parse_exact_service_tier(tier)
            except ValueError:
                raise InvalidParams("Unknown service tier") from None
            if parsed is None or parsed and parsed not in STATIC_TIERS:
                raise InvalidParams("Unknown service tier")
        if entry.get("api_key_clear"):
            row.pop("api_key", None)
        elif not entry.get("api_key") and source.get("api_key"):
            row["api_key"] = source["api_key"]
        if "fallback_providers" in row and not isinstance(row["fallback_providers"], list):
            raise InvalidParams("fallback_providers must be a list")
        rows.append(row)
    default = (block.get("default") or "").strip()
    if default and default not in names:
        raise InvalidParams("The default route must be in the list")
    return {field: rows, **({"default": default} if default else {})}


def register(methods) -> None:
    @methods.method("aux.delegation")
    def describe(ctx, params):
        with scoped_home(profile_home_param(params)):
            return registry(params.get("config") or {})

    @methods.method("aux.delegation_routes")
    def validate(ctx, params):
        with scoped_home(profile_home_param(params)):
            return {"block": clean_routes(params["backend"], params["block"], params["current"])}

    @methods.method("aux.delegation_backend")
    def select(ctx, params):
        from hermes_cli.config import get_config_path
        from agent.delegation_backends import set_global_backend
        from .config import config_path_param

        with scoped_home(profile_home_param(params)):
            if get_config_path().resolve() != config_path_param(params).resolve():
                raise RpcError("Native delegation config path differs from the configured file", condition="config_write_refused")
            try:
                set_global_backend(params["backend"])
            except PermissionError:
                raise RpcError("config.yaml is package-managed. Update the declarative configuration instead.", condition="config_write_refused") from None
            except ValueError as exc:
                raise InvalidParams(str(exc)) from None
        return {"ok": True}
