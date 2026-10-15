"""Preflight named inference destinations without resolving clients, credentials or model metadata."""
from __future__ import annotations

from urllib.parse import urlsplit

from .errors import RpcError

_MESSAGE = (
    "Inference route refused: a named provider must use its configured origin. "
    "Repair the provider and route settings, or configure the destination as its own provider "
    "or an anonymous custom route with its own credential. Endpoints must be valid HTTP(S) URLs "
    "with all environment references resolved."
)


def _refuse() -> None:
    # Never include endpoint, parser, config or credential details in the error envelope.
    raise RpcError(_MESSAGE, condition="inference_route_unsafe")


def _origin(value) -> tuple[str, str, int]:
    if not isinstance(value, str) or not value.strip():
        _refuse()
    value = value.strip()
    if any(c.isspace() or ord(c) < 32 for c in value) or any(c in value for c in ("\\", "$", "{", "}")):
        _refuse()
    try:
        url = urlsplit(value)
        host = url.hostname
        if url.scheme not in ("http", "https") or not host or url.username is not None or url.password is not None or "%" in host:
            _refuse()
        port = url.port
        if port == 0 or (url.netloc.endswith(":")):
            _refuse()
        return url.scheme, host.lower(), port or (443 if url.scheme == "https" else 80)
    except ValueError:
        _refuse()


def preflight(params: dict) -> None:
    try:
        _preflight(params)
    except Exception:
        _refuse()


def _preflight(params: dict) -> None:
    """Runs inside the registry's selected profile scope, before any inference-capable handler.

    Extend the existing Agent identity aliases and auxiliary inheritance, rather than a second
    runtime resolver. In particular do not call resolve_runtime_provider: it may probe metadata.
    """
    from agent.secret_scope import get_secret_str
    from hermes_cli.config import get_config_path, load_config_readonly
    from hermes_cli.providers import custom_provider_aliases, get_provider
    from hermes_cli.runtime_provider_custom import _shadowed_by_builtin
    from .methods.config import read_config

    # Validate the file even if the Agent would recover a last-known-good cached config.
    read_config(get_config_path())
    cfg = load_config_readonly()
    if not isinstance(cfg, dict) or getattr(cfg, "read_error", None) is not None:
        _refuse()

    providers = cfg.get("providers") or {}
    legacy = cfg.get("custom_providers") or []
    auxiliary = cfg.get("auxiliary") or {}
    if not isinstance(providers, dict) or not isinstance(legacy, list) or not isinstance(auxiliary, dict):
        _refuse()
    entries = []
    for key, entry in providers.items():
        if not isinstance(entry, dict):
            _refuse()
        if entry.get("enabled") is False:
            continue
        entries.append((custom_provider_aliases(str(entry.get("name") or key), str(key)),
                        entry.get("api") or entry.get("url") or entry.get("base_url")))
    for entry in legacy:
        if not isinstance(entry, dict):
            _refuse()
        entries.append((custom_provider_aliases(str(entry.get("name") or ""), str(entry.get("provider_key") or "")), entry.get("base_url")))

    main = cfg.get("model") or {}
    if isinstance(main, str):
        main = {}
    if not isinstance(main, dict):
        _refuse()
    main_provider = main.get("provider") or get_secret_str("HERMES_INFERENCE_PROVIDER", "")

    def check(route: dict, default_provider=""):
        identities = [route.get(key) for key in ("requested_provider", "model_provider", "requested", "provider") if route.get(key)]
        for identity in identities or [default_provider]:
            provider = str(identity).strip().lower().replace(" ", "-")
            if not provider or provider == "auto" or _shadowed_by_builtin(provider):
                continue
            match = next(((aliases, endpoint) for aliases, endpoint in entries if provider in aliases), None)
            if match is not None:
                configured = _origin(match[1])
                destination = route.get("base_url") or match[1]
                if _origin(destination) != configured:
                    _refuse()
            elif provider != "custom" and (provider.startswith("custom:") or get_provider(provider, allow_network=False) is None):
                _refuse()
        for field in ("fallback_providers", "fallback_model", "fallback_chain"):
            chain = route.get(field)
            if chain is None:
                continue
            if isinstance(chain, dict):
                chain = [chain]
            if not isinstance(chain, list):
                _refuse()
            for item in chain:
                if not isinstance(item, dict):
                    _refuse()
                check(item)

    check(main, main_provider)
    check(cfg)
    for route in auxiliary.values():
        if isinstance(route, dict):
            check(route)
    # Plugin task defaults and inheritance use the Agent's own effective route reader.
    from agent.auxiliary_task_config import _get_auxiliary_task_config
    from hermes_cli.plugins import get_plugin_auxiliary_tasks
    tasks = {key for key, value in auxiliary.items() if isinstance(value, dict)}
    tasks.update(entry["key"] for entry in get_plugin_auxiliary_tasks())
    if params.get("task"):
        tasks.add(str(params["task"]))
    for task in tasks:
        check(_get_auxiliary_task_config(task))
    runtime = params.get("main_runtime")
    if runtime is not None:
        if not isinstance(runtime, dict):
            _refuse()
        check(runtime, main_provider)
    check(params, main_provider)
    for route in params.get("routes") or []:
        if not isinstance(route, dict):
            _refuse()
        check(route, main_provider)
