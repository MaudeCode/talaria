"""``providers.*`` and ``models.*``: the Agent's provider registry, credentials,
runtime resolution, model catalogs, and model metadata.

The WebUI's provider catalog logic (static tables, picker labels, caches)
moves to the TypeScript server; this namespace exposes the Agent primitives it
composes: ``hermes_cli.auth``, ``hermes_cli.models``, ``hermes_cli.runtime_provider``,
``agent.credential_pool``, ``agent.model_metadata``, ``agent.models_dev``.
"""

from __future__ import annotations

import dataclasses
import logging
import sys
import threading
from pathlib import Path
from typing import Any

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.providers")


def _plain(value: Any) -> Any:
    """JSON-safe projection of registry objects (dataclasses, namespaces, sets)."""
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {k: _plain(v) for k, v in dataclasses.asdict(value).items()}
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_plain(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if hasattr(value, "__dict__"):
        return {k: _plain(v) for k, v in vars(value).items() if not k.startswith("_")}
    return str(value)


def registry() -> dict[str, dict]:
    try:
        from hermes_cli.auth import PROVIDER_REGISTRY
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"provider registry unavailable: {exc}", condition="providers_unavailable") from exc
    out = {}
    for pid, cfg in PROVIDER_REGISTRY.items():
        row = _plain(cfg)
        if isinstance(row, dict):
            out[str(pid)] = row
    return out


def auth_status(provider_id: str | None) -> dict:
    try:
        from hermes_cli.auth import get_auth_status
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"auth status unavailable: {exc}", condition="providers_unavailable") from exc
    try:
        status = get_auth_status(provider_id or None)
    except Exception as exc:  # noqa: BLE001
        log.debug("get_auth_status(%r) failed", provider_id, exc_info=True)
        return {"logged_in": False, "error": f"{type(exc).__name__}: {exc}"}
    return _plain(status) if isinstance(status, dict) else {"logged_in": bool(status)}


def _module_dir(module: Any) -> Path | None:
    try:
        return Path(module.__file__).resolve().parent
    except Exception:  # noqa: BLE001 - namespace/builtin modules have no file
        return None


# The Agent's module-name prefix for provider plugins it imports from a ``$HERMES_HOME`` (``providers._import_plugin_dir``).
_USER_PLUGIN_MODULE = "_hermes_user_provider_"
_LOAD_LOCK = threading.Lock()
_LOAD_ATTEMPTED: set[Path] = set()


def _user_plugin_profiles() -> dict[int, tuple[Any, Path]]:
    """Each registered profile a ``$HERMES_HOME`` provider plugin module holds, with that module's directory."""
    from providers import list_providers
    from providers.base import ProviderProfile

    registered = {id(p) for p in list_providers()}
    out: dict[int, tuple[Any, Path]] = {}
    for name, module in list(sys.modules.items()):
        directory = _module_dir(module) if module is not None and name.startswith(_USER_PLUGIN_MODULE) else None
        if directory is None:
            continue
        for value in list(vars(module).values()):
            if isinstance(value, ProviderProfile) and id(value) in registered:
                out.setdefault(id(value), (value, directory))
    return out


def _load_plugin(root: Path) -> None:
    """Load the scoped profile's installed plugin that the process-wide discovery (run under the launch profile) skipped.

    Uses the Agent's own loader, as ``hermes plugins dev`` does, once per directory. A plugin never displaces a provider
    that is already registered, so one profile's plugin cannot change what another profile's provider id runs.
    """
    import providers

    with _LOAD_LOCK:
        if root in _LOAD_ATTEMPTED:
            return
        _LOAD_ATTEMPTED.add(root)
        before = {p.name: p for p in providers.list_providers()}
        try:
            providers._import_plugin_dir(root, "user")
        except Exception:  # noqa: BLE001 - a broken plugin reads as not loaded
            log.debug("loading provider plugin %s failed", root, exc_info=True)
            return
        after = {p.name: p for p in providers.list_providers()}
        for name, previous in before.items():
            if after.get(name) is not previous:
                providers.register_provider(previous)


def installed_plugin_profiles() -> list[tuple[str, Any]]:
    """``(manifest name, profile | None)`` for each enabled model-provider plugin installed in the scoped home.

    Bundled providers are built-ins, not plugins. The Agent keeps one provider registry per process, so a profile
    belongs to this home only when the plugin module that registered it lives in one of this home's plugin
    directories; a plugin the launch discovery skipped is loaded here. ``None`` means the plugin could not be loaded:
    it failed to import, its provider id is taken by another plugin, or another profile's plugin has the same directory
    name. ponytail: ownership is read from the plugin module's globals, so a plugin that registers an unbound inline
    profile also reads as not loaded; track registrations in the Agent if one ever does.
    """
    try:
        from hermes_cli.plugins_discovery import _get_disabled_plugins, _get_enabled_plugins, collect_directory_manifests, gate_manifest
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"plugin providers unavailable: {exc}", condition="plugins_unavailable") from exc
    disabled, enabled = _get_disabled_plugins(), _get_enabled_plugins()
    roots = {
        Path(m.path).resolve(): str(m.name)
        for m in collect_directory_manifests()
        if m.kind == "model-provider" and m.source == "user" and m.path and gate_manifest(m, disabled, enabled).enabled
    }
    if not roots:
        return []

    def owned() -> dict[Path, list]:
        found: dict[Path, list] = {root: [] for root in roots}
        for profile, directory in _user_plugin_profiles().values():
            root = next((r for r in roots if directory == r or r in directory.parents), None)
            if root is not None:
                found[root].append(profile)
        return found

    found = owned()
    missing = [root for root, profiles in found.items() if not profiles]
    if missing:
        for root in missing:
            _load_plugin(root)
        found = owned()
    return [(name, p) for root, name in roots.items() for p in (found[root] or [None])]


def _other_profile_plugin(provider_id: str) -> bool:
    """Whether ``provider_id`` is a plugin provider that another profile installed (the registry is process-wide)."""
    from providers import get_provider_profile

    profile = get_provider_profile(provider_id)
    if profile is None or id(profile) not in _user_plugin_profiles():
        return False
    return not any(p is profile for _name, p in installed_plugin_profiles())


def _setup_state(profile: Any) -> str:
    """The Agent's own setup verdict for a plugin provider, without spawning its CLI or reading its credentials."""
    try:
        status = auth_status(profile.name)
    except RpcError:
        return "unavailable"
    if status.get("error"):
        return "unavailable"
    if profile.auth_type == "external_process":
        return "ready" if status.get("configured") else "missing_cli"
    return "ready" if status.get("logged_in") or status.get("configured") else "needs_setup"


def plugin_providers() -> list[dict]:
    """Sanitized rows for this profile's enabled model-provider plugins: identity and setup state, no paths or secrets."""
    rows = []
    for manifest_name, profile in installed_plugin_profiles():
        if profile is None:
            rows.append({"name": manifest_name, "display_name": manifest_name, "auth_type": "", "setup": "not_loaded"})
            continue
        name = str(profile.name).strip().lower()
        rows.append({"name": name, "display_name": str(profile.display_name or name).strip(), "auth_type": str(profile.auth_type), "setup": _setup_state(profile)})
    return rows


def _plugin_catalog(provider_id: str) -> list[str]:
    """Discovery for an installed plugin the Agent's catalog has no fetcher for: the profile's own listing, then its fallback.

    API-key plugins already get both from ``provider_model_ids`` with their key, so only keyless auth types list here.
    """
    for _name, profile in installed_plugin_profiles():
        if profile is None or str(profile.name).strip().lower() != provider_id.strip().lower():
            continue
        try:
            live = profile.fetch_models(timeout=8.0) if profile.supports_model_listing and profile.auth_type != "api_key" else None
        except Exception:  # noqa: BLE001 - a broken plugin answers with its fallback catalog
            log.debug("fetch_models(%r) failed", provider_id, exc_info=True)
            live = None
        return [str(m) for m in (live or profile.fallback_models or ()) if m]
    return []


def model_ids(provider_id: str, *, force_refresh: bool) -> list[str]:
    try:
        from hermes_cli.models import provider_model_ids
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"model catalog unavailable: {exc}", condition="providers_unavailable") from exc
    try:
        if _other_profile_plugin(provider_id):
            return []
    except Exception:  # noqa: BLE001 - no readable provider registry means no plugin to keep apart
        log.debug("plugin ownership check for %r failed", provider_id, exc_info=True)
    try:
        ids = provider_model_ids(provider_id, force_refresh=force_refresh)
    except TypeError:
        ids = provider_model_ids(provider_id)
    except Exception:  # noqa: BLE001
        log.debug("provider_model_ids(%r) failed", provider_id, exc_info=True)
        ids = []
    ids = [str(m) for m in (ids or []) if m]
    if ids:
        return ids
    try:
        return _plugin_catalog(provider_id)
    except RpcError:
        return []


def resolve_runtime(*, requested: str | None, api_key: str | None, base_url: str | None, target_model: str | None) -> dict:
    try:
        from hermes_cli.runtime_provider import format_runtime_provider_error, resolve_runtime_provider
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"runtime provider unavailable: {exc}", condition="providers_unavailable") from exc
    try:
        runtime = resolve_runtime_provider(requested=requested or None, explicit_api_key=api_key or None, explicit_base_url=base_url or None, target_model=target_model or None)
    except Exception as exc:  # noqa: BLE001
        try:
            message = format_runtime_provider_error(exc)
        except Exception:  # noqa: BLE001
            message = str(exc)
        raise RpcError(message, condition="credential_missing", data={"error_type": type(exc).__name__})
    return _plain(runtime) if isinstance(runtime, dict) else {"runtime": _plain(runtime)}


def credential_pool(provider_id: str) -> dict:
    """Credential-pool entries for the profile, secrets stripped (api/config.py::_pool_entry_payloads)."""
    try:
        from agent.credential_pool import load_pool
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"credential pool unavailable: {exc}", condition="providers_unavailable") from exc
    try:
        pool = load_pool(provider_id)
    except Exception:  # noqa: BLE001
        log.debug("load_pool(%r) failed", provider_id, exc_info=True)
        return {"available": False, "strategy": "", "entries": []}
    if pool is None:
        return {"available": False, "strategy": "", "entries": []}
    entries_fn = getattr(pool, "entries", None)
    try:
        raw_entries = list(entries_fn()) if callable(entries_fn) else list(entries_fn or [])
    except Exception:  # noqa: BLE001
        raw_entries = []
    entries = []
    for entry in raw_entries:
        if hasattr(entry, "to_dict") and callable(entry.to_dict):
            payload = entry.to_dict()
        elif isinstance(entry, dict):
            payload = dict(entry)
        else:
            try:
                payload = dict(vars(entry))
            except TypeError:
                payload = {}
        payload = _plain(payload) if isinstance(payload, dict) else {}
        payload.setdefault("source", str(getattr(entry, "source", "") or ""))
        payload.setdefault("label", str(getattr(entry, "label", "") or ""))
        payload.setdefault("key_source", str(getattr(entry, "key_source", "") or ""))
        for attr in ("base_url", "inference_base_url"):
            value = getattr(entry, attr, None)
            if value:
                payload[attr] = value
        for secret in ("api_key", "runtime_api_key", "token", "secret", "refresh_token", "access_token", "id_token"):
            if payload.get(secret):
                payload[secret + "_present"] = True
            payload.pop(secret, None)
        entries.append(payload)
    strategy = getattr(pool, "strategy", "")
    return {"available": True, "strategy": str(strategy() if callable(strategy) else strategy or ""), "entries": entries}


def context_length(model: str, *, base_url: str, api_key: str, provider: str, config_context_length: int | None) -> int | None:
    try:
        from agent.model_metadata import get_model_context_length
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"model metadata unavailable: {exc}", condition="providers_unavailable") from exc
    try:
        value = get_model_context_length(model, base_url=base_url or "", api_key=api_key or "", config_context_length=config_context_length, provider=provider or "")
    except TypeError:
        value = get_model_context_length(model, base_url=base_url or "", api_key=api_key or "")
    except Exception:  # noqa: BLE001
        log.debug("get_model_context_length(%r) failed", model, exc_info=True)
        return None
    try:
        return int(value) if value else None
    except (TypeError, ValueError):
        return None


def estimate_tokens(messages: list) -> int:
    try:
        from agent.model_metadata import estimate_messages_tokens_rough
    except Exception as exc:  # noqa: BLE001
        raise RpcError(f"model metadata unavailable: {exc}", condition="providers_unavailable") from exc
    try:
        return int(estimate_messages_tokens_rough(list(messages or [])) or 0)
    except Exception:  # noqa: BLE001
        log.debug("estimate_messages_tokens_rough failed", exc_info=True)
        return 0


def capabilities(provider: str, model: str) -> dict | None:
    try:
        from agent.models_dev import get_model_capabilities
    except Exception:  # noqa: BLE001
        return None
    try:
        caps = get_model_capabilities(provider, model)
    except TypeError:
        try:
            caps = get_model_capabilities(model)
        except Exception:  # noqa: BLE001
            return None
    except Exception:  # noqa: BLE001
        return None
    row = _plain(caps)
    return row if isinstance(row, dict) else None


def register(reg) -> None:
    @reg.method("providers.registry")
    def registry_(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"providers": registry()}

    @reg.method("providers.auth_status")
    def auth(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"status": auth_status(params.get("provider"))}

    @reg.method("providers.model_ids")
    def ids(ctx: CallContext, params: dict) -> dict:
        provider = str(params.get("provider") or "").strip()
        if not provider:
            raise InvalidParams("provider is required")
        with scoped_home(profile_home_param(params)):
            return {"provider": provider, "model_ids": model_ids(provider, force_refresh=bool(params.get("force_refresh", False)))}

    @reg.method("providers.resolve_runtime")
    def runtime(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"runtime": resolve_runtime(requested=params.get("requested"), api_key=params.get("api_key"), base_url=params.get("base_url"), target_model=params.get("target_model"))}

    @reg.method("providers.credential_pool")
    def pool(ctx: CallContext, params: dict) -> dict:
        provider = str(params.get("provider") or "").strip()
        if not provider:
            raise InvalidParams("provider is required")
        with scoped_home(profile_home_param(params)):
            return credential_pool(provider)

    @reg.method("models.context_length")
    def ctx_len(ctx: CallContext, params: dict) -> dict:
        model = str(params.get("model") or "").strip()
        if not model:
            raise InvalidParams("model is required")
        with scoped_home(profile_home_param(params)):
            value = context_length(model, base_url=str(params.get("base_url") or ""), api_key=str(params.get("api_key") or ""), provider=str(params.get("provider") or ""),
                                   config_context_length=params.get("config_context_length"))
        return {"model": model, "context_length": value}

    @reg.method("models.estimate_tokens", requires_agent=True)
    def estimate(ctx: CallContext, params: dict) -> dict:
        messages = params.get("messages")
        if not isinstance(messages, list):
            raise InvalidParams("messages must be a list")
        return {"tokens": estimate_tokens(messages)}

    @reg.method("models.capabilities")
    def caps(ctx: CallContext, params: dict) -> dict:
        with scoped_home(profile_home_param(params)):
            return {"capabilities": capabilities(str(params.get("provider") or ""), str(params.get("model") or ""))}
