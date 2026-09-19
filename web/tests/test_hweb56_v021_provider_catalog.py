"""HWEB-56: the six Hermes Agent v0.21.0 providers must reach the WebUI catalog.

`_seed_provider_models_from_core()` deliberately refuses to add vendors that are
not already in the WebUI catalog, so a new agent provider stays invisible until
it is curated into the three static tables by hand.  These tests pin the
canonical slugs (the agent separates slug from marketing name — "Tencent
TokenPlan" is `tencent-tokenplan`, "Actual Computer" is `actual`) and the
API-key env vars, and prove no provider gets registered twice.
"""

from __future__ import annotations

import pytest

import api.config as config
import api.plugin_providers as plugin_providers
import api.providers as providers

# Canonical agent slug → (display name, API-key env var).
NEW_PROVIDERS = {
    "commandcode": ("CommandCode", "COMMANDCODE_API_KEY"),
    "tencent-tokenplan": ("Tencent TokenPlan", "TOKENPLAN_API_KEY"),
    "tencent-tokenhub": ("Tencent TokenHub", "TOKENHUB_API_KEY"),
    "nebius-token-factory": ("Nebius Token Factory", "NEBIUS_API_KEY"),
    "router": ("Ramp Router", "RAMP_ROUTER_API_KEY"),
    "actual": ("Actual Computer", "ACTUAL_API_KEY"),
    "meta-ai": ("Meta Model API", "MODEL_API_KEY"),
}

# Marketing names and agent aliases that must NOT be used as catalog keys.
NON_CANONICAL_KEYS = (
    "tokenplan",
    "tokenhub",
    "tencent",
    "actual-computer",
    "actualcomputer",
    "aci",
    "nebius",
    "tokenfactory",
    "ramp-router",
    "ramp",
    "router.com",
    "meta",
    "muse",
    "muse-spark",
    "commandcode-chat",
)


@pytest.mark.parametrize("slug", sorted(NEW_PROVIDERS))
def test_slug_resolves_in_all_three_catalog_tables(slug):
    display, env_var = NEW_PROVIDERS[slug]
    assert config._PROVIDER_DISPLAY[slug] == display
    assert slug in config._PROVIDER_MODELS
    assert providers._PROVIDER_ENV_VAR[slug] == env_var
    assert providers._provider_env_var_for(slug) == env_var


@pytest.mark.parametrize("bad_key", NON_CANONICAL_KEYS)
def test_marketing_names_and_aliases_are_not_catalog_keys(bad_key):
    """The catalog is keyed by agent-canonical slugs, never by aliases."""
    assert bad_key not in config._PROVIDER_DISPLAY
    assert bad_key not in config._PROVIDER_MODELS
    assert bad_key not in providers._PROVIDER_ENV_VAR


def test_tencent_lanes_are_two_distinct_providers():
    """v0.21.0 ships TokenPlan alongside TokenHub — one is not an alias of the other."""
    assert config._PROVIDER_DISPLAY["tencent-tokenplan"] != config._PROVIDER_DISPLAY["tencent-tokenhub"]
    assert providers._PROVIDER_ENV_VAR["tencent-tokenplan"] != providers._PROVIDER_ENV_VAR["tencent-tokenhub"]


@pytest.mark.parametrize("slug", sorted(NEW_PROVIDERS))
def test_catalog_models_are_well_formed(slug):
    entries = config._PROVIDER_MODELS[slug]
    assert isinstance(entries, list)
    for entry in entries:
        assert isinstance(entry, dict)
        assert str(entry.get("id") or "").strip()
        assert str(entry.get("label") or "").strip()
    if slug not in ("router", "actual"):
        # Only the account/cluster-scoped providers are allowed an empty cold
        # catalog; the rest must offer something before the live probe lands.
        assert entries, f"{slug} needs a static model fallback"


def _isolate_key_lookup(monkeypatch, tmp_path):
    """Point key detection at an empty HERMES_HOME with no pooled credentials."""
    monkeypatch.setattr(providers, "_get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(config, "_has_explicit_pool_credentials", lambda _pid: False)


@pytest.mark.parametrize("slug", sorted(NEW_PROVIDERS))
def test_provider_has_key_follows_the_env_var(monkeypatch, tmp_path, slug):
    _isolate_key_lookup(monkeypatch, tmp_path)
    env_var = NEW_PROVIDERS[slug][1]

    monkeypatch.delenv(env_var, raising=False)
    assert providers._provider_has_key(slug, config_data={}) is False

    monkeypatch.setenv(env_var, "hweb56-test-key")
    assert providers._provider_has_key(slug, config_data={}) is True


def test_meta_model_api_is_registered_exactly_once(monkeypatch):
    """Static entry wins; plugin discovery must not also claim ``meta-ai``.

    ``_webui_static_provider_ids()`` is memoised, so clear it first — otherwise
    a cache warmed before this module's import would answer for the old table.
    """
    monkeypatch.setattr(plugin_providers, "_WEBUI_STATIC_PROVIDER_IDS", None)
    monkeypatch.setattr(
        plugin_providers,
        "_PROFILES_BY_NAME",
        {"meta-ai": object()},
    )

    assert plugin_providers.is_plugin_model_provider("meta-ai") is False
    assert "meta-ai" not in plugin_providers.plugin_model_provider_ids()
    assert plugin_providers.effective_provider_display_name(
        "meta-ai", config._PROVIDER_DISPLAY
    ) == "Meta Model API"


def test_seeding_still_refuses_to_invent_providers(monkeypatch):
    """`_seed_provider_models_from_core` must not add vendors of its own."""
    import sys
    import types

    before = set(config._PROVIDER_MODELS)
    fake = types.ModuleType("hermes_cli.models")
    fake._PROVIDER_MODELS = {"totally-new-vendor": ["some-model"]}
    monkeypatch.setitem(sys.modules, "hermes_cli.models", fake)

    config._seed_provider_models_from_core()

    assert set(config._PROVIDER_MODELS) == before


def test_new_providers_reach_the_model_picker(monkeypatch, tmp_path):
    """End-to-end: an authenticated v0.21.0 provider renders as a picker group.

    Before the catalog entries existed these slugs fell through
    ``_build_available_models_uncached``'s "unrecognized provider" branch and
    were dropped, which is the bug HWEB-56 describes.
    """
    pytest.importorskip("hermes_cli.models")
    import hermes_cli.auth as hermes_auth
    import hermes_cli.models as hermes_models

    monkeypatch.setattr(
        hermes_models,
        "list_available_providers",
        lambda: [{"id": pid, "authenticated": True} for pid in NEW_PROVIDERS],
        raising=False,
    )
    monkeypatch.setattr(
        hermes_auth,
        "get_auth_status",
        lambda pid: {"key_source": "env", "logged_in": False},
        raising=False,
    )
    # No live catalog probe — this asserts the static fallback path.
    monkeypatch.setattr(config, "_read_live_provider_model_ids", lambda _pid: [])
    # Building a catalog reloads the config cache and rebinds `_cfg_path` to the
    # tmp config. Left behind, that makes the next `get_config()` see
    # `path_changed` and force a reload that discards whatever cfg a later test
    # installed in memory. Snapshot the cache identity through monkeypatch so
    # this test cannot leak into another test's routing decisions.
    monkeypatch.setattr(config, "_cfg_path", config._cfg_path, raising=False)
    monkeypatch.setattr(config, "_available_models_cache", config._available_models_cache)
    monkeypatch.setattr(config, "_models_cache_provenance", config._models_cache_provenance)
    monkeypatch.setattr(config, "_advertised_model_ids_memo", config._advertised_model_ids_memo)
    monkeypatch.setattr(config, "_models_cache_path", tmp_path / "models_cache.json")
    monkeypatch.setattr(config, "_get_config_path", lambda: tmp_path / "missing-config.yaml")
    monkeypatch.setattr("api.profiles.get_active_hermes_home", lambda: tmp_path, raising=False)

    old_cfg = dict(config.cfg)
    old_mtime = config._cfg_mtime
    config.cfg.clear()
    config.cfg.update({"model": {}})
    config._cfg_mtime = 0.0
    config.invalidate_models_cache()
    try:
        result = config.get_available_models()
    finally:
        config.cfg.clear()
        config.cfg.update(old_cfg)
        config._cfg_mtime = old_mtime
        config.invalidate_models_cache()

    groups = {group["provider_id"]: group for group in result["groups"]}

    for slug, (display, _env) in NEW_PROVIDERS.items():
        if not config._PROVIDER_MODELS[slug]:
            # router / actual carry no static catalog; with the live probe
            # stubbed out there is nothing to render and the zero-model filter
            # (#1568) hides them. Covered by the models-well-formed test above.
            continue
        assert slug in groups, f"{slug} missing from the picker"
        assert groups[slug]["provider"] == display
        assert groups[slug]["models"]


# Aggregators that serve foreign vendor namespaces under their own key. A bare
# ``vendor/model`` row from one of these falls through
# ``resolve_model_provider``'s OpenRouter default, which either fails outright
# (OpenRouter unconfigured) or bills the wrong account.
NAMESPACED_AGGREGATORS = ("commandcode", "nebius-token-factory", "router", "actual")


@pytest.mark.parametrize("slug", NAMESPACED_AGGREGATORS)
def test_namespaced_rows_route_to_their_own_provider(slug):
    """Every catalog row resolves back to *slug*, active or cross-provider."""
    assert slug in config._PORTAL_PROVIDERS
    own_cfg = {"model": {"provider": slug, "default": "x"}}
    other_cfg = {"model": {"provider": "anthropic", "default": "x"}}

    # router / actual carry no static rows — exercise the id shapes their live
    # account catalogs actually return.
    rows = config._PROVIDER_MODELS[slug] or [
        {"id": "accounts/fireworks/models/kimi-k3", "label": "x"},
        {"id": "Qwen/Qwen2.5-0.5B-Instruct-GGUF", "label": "x"},
        {"id": "deepseek/deepseek-v4-pro", "label": "x"},
    ]
    for entry in rows:
        raw_id = entry["id"]

        # Selected while this provider is active — the id stays bare.
        active_rows = config._apply_provider_prefix([dict(entry)], slug, slug)
        _model, provider, _base = config.resolve_model_provider(
            active_rows[0]["id"], config_data=own_cfg
        )
        assert provider == slug, f"{raw_id} misrouted to {provider!r} while active"

        # Selected from another provider's session — must be qualified.
        cross_rows = config._apply_provider_prefix([dict(entry)], slug, "anthropic")
        cross_id = cross_rows[0]["id"]
        assert cross_id == f"@{slug}:{raw_id}"
        resolved, provider, _base = config.resolve_model_provider(
            cross_id, config_data=other_cfg
        )
        assert provider == slug, f"{raw_id} misrouted to {provider!r} cross-provider"
        assert resolved == raw_id, f"{raw_id} mangled to {resolved!r}"


@pytest.mark.parametrize("slug", NAMESPACED_AGGREGATORS)
def test_namespaced_rows_route_correctly_with_no_active_provider(slug):
    """A fresh install with `model.provider` unset must not leak rows to OpenRouter.

    `_apply_provider_prefix()` short-circuits when nothing is active, which is
    right for an ordinary provider (no sibling to be confused with) but wrong for
    a portal one: `resolve_model_provider()`'s cross-provider branch claims the
    bare `vendor/model` for OpenRouter.
    """
    no_provider_cfg = {"model": {}}
    rows = config._PROVIDER_MODELS[slug] or [
        {"id": "accounts/fireworks/models/kimi-k3", "label": "x"},
        {"id": "Qwen/Qwen2.5-0.5B-Instruct-GGUF", "label": "x"},
    ]
    for entry in rows:
        raw_id = entry["id"]
        picked = config._apply_provider_prefix([dict(entry)], slug, "")[0]["id"]
        resolved, provider, _base = config.resolve_model_provider(
            picked, config_data=no_provider_cfg
        )
        assert provider == slug, f"{raw_id} misrouted to {provider!r} with no active provider"
        assert resolved == raw_id


def test_no_active_provider_leaves_ordinary_providers_untouched():
    """The short-circuit still applies to everything outside _PORTAL_PROVIDERS."""
    for pid, mid in (("openrouter", "deepseek/deepseek-v4-pro"), ("anthropic", "claude-opus-4.7")):
        assert pid not in config._PORTAL_PROVIDERS
        rows = config._apply_provider_prefix([{"id": mid, "label": "x"}], pid, "")
        assert rows[0]["id"] == mid


def test_portal_prefixing_leaves_non_aggregators_alone():
    """Only ``_PORTAL_PROVIDERS`` gained the namespaced-id qualification."""
    rows = config._apply_provider_prefix(
        [{"id": "deepseek/deepseek-v4-pro", "label": "x"}], "openrouter", "anthropic"
    )
    assert rows[0]["id"] == "deepseek/deepseek-v4-pro"


def test_nvidia_namespaced_rows_survive_the_round_trip():
    """The pre-existing portal provider keeps resolving to itself either way."""
    cfg_nvidia = {"model": {"provider": "nvidia", "default": "x"}}
    cfg_other = {"model": {"provider": "anthropic", "default": "x"}}
    for entry in config._PROVIDER_MODELS["nvidia"]:
        raw_id = entry["id"]
        active_id = config._apply_provider_prefix([dict(entry)], "nvidia", "nvidia")[0]["id"]
        assert config.resolve_model_provider(active_id, config_data=cfg_nvidia)[:2] == (raw_id, "nvidia")
        cross_id = config._apply_provider_prefix([dict(entry)], "nvidia", "anthropic")[0]["id"]
        assert config.resolve_model_provider(cross_id, config_data=cfg_other)[:2] == (raw_id, "nvidia")


@pytest.mark.parametrize("slug", ["router", "actual"])
def test_live_only_providers_report_their_catalog_on_the_providers_endpoint(
    monkeypatch, tmp_path, slug
):
    """`/api/providers` must not report 0 models for a live-only provider.

    `get_providers()` initialises from `_PROVIDER_MODELS`, which is empty for
    these two by design. Without the live lookup the Settings card reads "0
    models" while `/api/models` renders the same provider's live catalog.
    """
    import api.profiles as profiles

    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {slug: config._PROVIDER_DISPLAY[slug]})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {slug: []})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: set())
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda _pid: False)
    monkeypatch.setattr(providers, "get_config", lambda: {"model": {}, "providers": {}})
    monkeypatch.setattr(providers, "_provider_has_key", lambda _pid, **_kw: True)
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: True)
    monkeypatch.setattr(
        providers,
        "published_catalog_models",
        lambda _pid: [{"id": "vendor/model-a", "label": "A"}, {"id": "model-b", "label": "B"}],
    )

    entry = next(p for p in providers.get_providers()["providers"] if p["id"] == slug)

    assert entry["models_total"] == 2
    assert {m["id"] for m in entry["models"]} == {"vendor/model-a", "model-b"}


def test_env_var_removal_clears_every_name_that_grants_access():
    """No provider may be detected via a name its key-removal path won't clear.

    `_provider_has_key()` also honours `_PROVIDER_ENV_VAR_ALIASES`, but removal
    writes only the canonical var. Any new provider that gained an alias here
    would show "removed" in Settings while still being configured after reload.
    """
    for slug in NEW_PROVIDERS:
        assert slug not in providers._PROVIDER_ENV_VAR_ALIASES


def _force_env_fallback(monkeypatch):
    """Make `hermes_cli` unimportable so detection takes its env-var fallback."""
    import builtins

    real_import = builtins.__import__

    def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name in ("hermes_cli.models", "hermes_cli.auth"):
            raise ImportError(name)
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", fake_import)


def _fallback_groups(monkeypatch, tmp_path, env):
    import api.profiles as profiles

    _force_env_fallback(monkeypatch)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
        monkeypatch.setitem(profiles._INITIAL_PROCESS_ENV, name, value)
    monkeypatch.setattr(config, "_models_cache_path", tmp_path / "models_cache.json")
    monkeypatch.setattr(config, "_get_config_path", lambda: tmp_path / "missing-config.yaml")
    monkeypatch.setattr(config, "_cfg_path", config._cfg_path, raising=False)
    monkeypatch.setattr(config, "_available_models_cache", config._available_models_cache)
    monkeypatch.setattr(config, "_models_cache_provenance", config._models_cache_provenance)
    monkeypatch.setattr(config, "_advertised_model_ids_memo", config._advertised_model_ids_memo)
    monkeypatch.setattr("api.profiles.get_active_hermes_home", lambda: tmp_path, raising=False)

    old_cfg = dict(config.cfg)
    old_mtime = config._cfg_mtime
    config.cfg.clear()
    config.cfg.update({"model": {}})
    config._cfg_mtime = 0.0
    config.invalidate_models_cache()
    try:
        return {g["provider_id"] for g in config.get_available_models()["groups"]}
    finally:
        config.cfg.clear()
        config.cfg.update(old_cfg)
        config._cfg_mtime = old_mtime
        config.invalidate_models_cache()


# Only the providers that ship a static catalog: router / actual render zero
# models on this path (no live probe) and the zero-model filter drops them.
_FALLBACK_DETECTABLE = [s for s in sorted(NEW_PROVIDERS) if s not in ("router", "actual")]


@pytest.mark.parametrize("slug", _FALLBACK_DETECTABLE)
def test_env_var_detection_reaches_the_no_hermes_cli_fallback(monkeypatch, tmp_path, slug):
    """Settings and the picker must agree even when `hermes_cli` is unavailable.

    This path used to scan a hand-maintained copy of the env-var list, so a
    provider added to `_PROVIDER_ENV_VAR` but not to that copy reported
    "configured" on the Providers card while its picker group was missing.
    """
    env_var = NEW_PROVIDERS[slug][1]
    assert slug in _fallback_groups(monkeypatch, tmp_path, {env_var: "hweb56-test-key"})


def test_fallback_detection_reads_the_canonical_key_table(monkeypatch, tmp_path):
    """A provider in `_PROVIDER_ENV_VAR` is detectable without a bespoke branch."""
    # nvidia was in the table but absent from the old hardcoded list.
    assert "nvidia" in _fallback_groups(monkeypatch, tmp_path, {"NVIDIA_API_KEY": "k"})


def test_fallback_detection_keeps_the_openai_slug_special_case(monkeypatch, tmp_path):
    """`OPENAI_API_KEY` maps to openai-api/openai-codex, never a bare `openai`.

    The agent registry has no bare `openai` provider (#3443), so the table-driven
    pass must not add one just because `_PROVIDER_ENV_VAR` is keyed that way.
    """
    groups = _fallback_groups(monkeypatch, tmp_path, {"OPENAI_API_KEY": "k"})
    assert "openai" not in groups
    assert {"openai-api", "openai-codex"} <= groups


# Agent-supported aliases → canonical slug, mirrored from the plugin profiles'
# `aliases=` tuples and hermes_cli's own table.
PROVIDER_ALIASES = {
    "commandcode-chat": "commandcode",
    "ramp-router": "router",
    "ramp": "router",
    "router.com": "router",
    "actual-computer": "actual",
    "actualcomputer": "actual",
    "aci": "actual",
    "nebius": "nebius-token-factory",
    "nebius-tokenfactory": "nebius-token-factory",
    "nebius-tf": "nebius-token-factory",
    "token-factory": "nebius-token-factory",
    "tokenfactory": "nebius-token-factory",
    "meta": "meta-ai",
    "muse": "meta-ai",
    "muse-spark": "meta-ai",
    "model-api": "meta-ai",
    "msl": "meta-ai",
    "tencent": "tencent-tokenhub",
    "tokenhub": "tencent-tokenhub",
    "tencent-cloud": "tencent-tokenhub",
    "tencentmaas": "tencent-tokenhub",
    "tokenplan": "tencent-tokenplan",
    "tencent-lkeap": "tencent-tokenplan",
}


@pytest.mark.parametrize("alias,canonical", sorted(PROVIDER_ALIASES.items()))
def test_agent_aliases_canonicalise_without_the_agent_importable(alias, canonical):
    """The WebUI's own alias table must stand alone.

    `_PROVIDER_ALIASES` merges hermes_cli's table when importable, but standalone
    deployments have no agent tree — the same deployments the static catalog
    serves. An alias that canonicalises to itself misses `_PORTAL_PROVIDERS`.
    """
    assert config._canonicalise_provider_id(alias) == canonical


@pytest.mark.parametrize("alias,canonical", sorted(PROVIDER_ALIASES.items()))
def test_aliased_active_provider_keeps_its_own_namespaced_rows(alias, canonical):
    """`model.provider: <alias>` must not leak namespaced rows to OpenRouter.

    The picker resolves the group canonically while `resolve_model_provider()`
    keeps the raw alias (`resolve_alias=False`), so a canonical-only membership
    test made the two disagree about the same provider.
    """
    if canonical not in config._PORTAL_PROVIDERS:
        pytest.skip(f"{canonical} serves only bare ids")
    rows = config._PROVIDER_MODELS[canonical] or [
        {"id": "accounts/fireworks/models/kimi-k3", "label": "x"}
    ]
    namespaced = [entry for entry in rows if "/" in entry["id"]]
    assert namespaced, f"{canonical} needs a namespaced row to exercise this"

    cfg = {"model": {"provider": alias, "default": "x"}}
    for entry in namespaced:
        picked = config._apply_provider_prefix([dict(entry)], canonical, canonical)[0]["id"]
        _model, provider, _base = config.resolve_model_provider(picked, config_data=cfg)
        assert provider in (alias, canonical), (
            f"provider={alias} row={entry['id']} leaked to {provider!r}"
        )


def test_commandcode_anthropic_is_not_folded_into_commandcode():
    """It is a separate agent provider profile, not an alias."""
    assert config._canonicalise_provider_id("commandcode-anthropic") != "commandcode"


@pytest.mark.parametrize("alias,canonical", sorted(PROVIDER_ALIASES.items()))
def test_config_stored_keys_are_found_through_provider_aliases(alias, canonical):
    """`model.provider: <alias>` + a config key must read as configured.

    Routing accepts the alias and the runtime can use the key, so a Settings
    card that says "not configured" is the odd one out.
    """
    assert providers._provider_has_key(
        canonical, config_data={"model": {"provider": alias, "api_key": "sk-test"}}
    )
    assert providers._provider_has_key(
        canonical, config_data={"providers": {alias: {"api_key": "sk-test"}}}
    )


@pytest.mark.parametrize(
    "alias,card",
    # Deliberately excludes ("qwen", "alibaba"): `qwen` is a standalone card, so
    # it names only itself. That case belongs to
    # `test_active_provider_alias_match_respects_standalone_cards`, which asserts
    # the opposite — an earlier version of this list asserted the buggy
    # behaviour and had to be corrected.
    [("grok", "x-ai"), ("z-ai", "zai"), ("opencode_go", "opencode-go")],
)
def test_alias_credential_lookup_covers_pre_existing_aliases(alias, card):
    """The same defect predates this PR for the WebUI's long-standing aliases."""
    assert providers._provider_has_key(
        card, config_data={"model": {"provider": alias, "api_key": "sk-test"}}
    )


def test_alias_credential_lookup_does_not_over_match():
    """An unrelated provider must not inherit another's configured key."""
    assert not providers._provider_has_key(
        "deepseek", config_data={"model": {"provider": "ramp", "api_key": "sk-test"}}
    )
    assert not providers._provider_has_key(
        "zai", config_data={"providers": {"ramp": {"api_key": "sk-test"}}}
    )


def test_providers_card_reports_the_published_picker_catalog(monkeypatch, tmp_path):
    """Settings must show what the picker published, not a stale static snapshot."""
    import api.profiles as profiles

    published = [{"id": "live-only-model", "label": "Live Only Model"}]
    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {"commandcode": "CommandCode"})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {"commandcode": [{"id": "stale", "label": "Stale"}]})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: set())
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda _pid: False)
    monkeypatch.setattr(providers, "get_config", lambda: {"model": {}, "providers": {}})
    monkeypatch.setattr(providers, "_provider_has_key", lambda _pid, **_kw: True)
    monkeypatch.setattr(providers, "published_catalog_models", lambda pid: published if pid == "commandcode" else None)

    entry = next(p for p in providers.get_providers()["providers"] if p["id"] == "commandcode")

    assert [m["id"] for m in entry["models"]] == ["live-only-model"]
    assert entry["models_total"] == 1


def test_providers_card_falls_back_to_static_when_the_catalog_is_cold():
    """A cold catalog must render the curated list, never an empty card."""
    assert config.published_catalog_models("commandcode") is None or isinstance(
        config.published_catalog_models("commandcode"), list
    )
    assert config.published_catalog_models("definitely-not-a-provider") is None


def test_published_catalog_models_never_probes(monkeypatch):
    """It reads the snapshot only — no network, no rebuild on a request path."""
    def _boom(*_a, **_k):
        raise AssertionError("published_catalog_models must not probe")

    monkeypatch.setattr(config, "_read_live_provider_model_ids", _boom)
    monkeypatch.setattr(config, "get_available_models", _boom)
    config.published_catalog_models("commandcode")


def test_published_catalog_rejects_a_foreign_profile_snapshot(monkeypatch):
    """Profiles are islands — the catalog cache is not.

    `_available_models_cache` is a process global, so a concurrently-active
    profile can have published the snapshot. Serving it would put one profile's
    account-specific model names on another's Settings cards.
    """
    snapshot = {"groups": [{"provider_id": "commandcode", "models": [{"id": "leaked", "label": "Leaked"}]}]}
    monkeypatch.setattr(config, "_models_cache_provenance", (snapshot, {"config_yaml": "/profile-a/config.yaml"}))
    monkeypatch.setattr(config, "_models_cache_source_fingerprint", lambda: {"config_yaml": "/profile-b/config.yaml"})
    assert config.published_catalog_models("commandcode") is None

    monkeypatch.setattr(config, "_models_cache_source_fingerprint", lambda: {"config_yaml": "/profile-a/config.yaml"})
    assert [m["id"] for m in config.published_catalog_models("commandcode")] == ["leaked"]


def test_published_catalog_rejects_an_unavailable_fingerprint(monkeypatch):
    """No trustworthy provenance must fail closed, not fall through."""
    snapshot = {"groups": [{"provider_id": "commandcode", "models": [{"id": "x", "label": "X"}]}]}
    monkeypatch.setattr(config, "_models_cache_provenance", (snapshot, {"config_yaml": "/a"}))

    def _boom():
        raise RuntimeError("fingerprint unavailable")

    monkeypatch.setattr(config, "_models_cache_source_fingerprint", _boom)
    assert config.published_catalog_models("commandcode") is None


def test_aliased_providers_block_does_not_render_a_second_card(monkeypatch, tmp_path):
    """`providers.ramp` configures the `router` card — it is not its own card."""
    import api.profiles as profiles

    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {"router": "Ramp Router"})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {"router": []})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: set())
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda _pid: False)
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: True)
    monkeypatch.setattr(providers, "published_catalog_models", lambda _pid: None)
    monkeypatch.setattr(
        providers, "get_config", lambda: {"model": {}, "providers": {"ramp": {"api_key": "sk-test"}}}
    )

    ids = [p["id"] for p in providers.get_providers()["providers"]]

    assert "ramp" not in ids, f"aliased block rendered its own card: {ids}"
    assert ids.count("router") == 1


def test_unknown_providers_block_still_gets_its_own_card(monkeypatch, tmp_path):
    """Folding aliases must not swallow user-defined providers."""
    import api.profiles as profiles

    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {"router": "Ramp Router"})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {"router": []})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: set())
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda _pid: False)
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: True)
    monkeypatch.setattr(providers, "published_catalog_models", lambda _pid: None)
    monkeypatch.setattr(
        providers,
        "get_config",
        lambda: {"model": {}, "providers": {"my-own-relay": {"api_key": "sk", "base_url": "http://x/v1"}}},
    )

    ids = [p["id"] for p in providers.get_providers()["providers"]]
    assert "my-own-relay" in ids


def _write_config(tmp_path, data):
    import yaml

    path = tmp_path / "config.yaml"
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    return path


@pytest.mark.parametrize("alias,card", [("ramp", "router"), ("actual-computer", "actual")])
def test_removing_a_key_clears_the_aliased_config_block(monkeypatch, tmp_path, alias, card):
    """Remove must clear what `_provider_has_key()` accepts, or it lies.

    Detection honours `providers.<alias>` and `model.provider: <alias>`, so a
    removal that only matches the literal card id returns ok while leaving the
    credential live — the provider is still configured after a reload.
    """
    import yaml
    import api.config as cfgmod

    path = _write_config(
        tmp_path,
        {"model": {"provider": alias, "api_key": "sk-model"}, "providers": {alias: {"api_key": "sk-block"}}},
    )
    monkeypatch.setattr(cfgmod, "_get_config_path", lambda: path)

    providers._clean_provider_key_from_config(card)

    written = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert "api_key" not in (written.get("providers") or {}).get(alias, {})
    assert "api_key" not in (written.get("model") or {})


def test_removing_a_key_leaves_other_providers_alone(monkeypatch, tmp_path):
    """Alias-aware removal must not reach into an unrelated provider's block."""
    import yaml
    import api.config as cfgmod

    path = _write_config(tmp_path, {"providers": {"ramp": {"api_key": "sk-router"}, "deepseek": {"api_key": "sk-ds"}}})
    monkeypatch.setattr(cfgmod, "_get_config_path", lambda: path)

    providers._clean_provider_key_from_config("router")

    written = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert "api_key" not in written["providers"]["ramp"]
    assert written["providers"]["deepseek"]["api_key"] == "sk-ds"


def test_aliased_models_block_reaches_the_canonical_card(monkeypatch, tmp_path):
    """`providers.ramp.models` must land on the router card it now folds into."""
    import api.profiles as profiles

    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {"router": "Ramp Router"})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {"router": []})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: set())
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda _pid: False)
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: True)
    monkeypatch.setattr(providers, "published_catalog_models", lambda _pid: None)
    monkeypatch.setattr(
        providers,
        "get_config",
        lambda: {"model": {}, "providers": {"ramp": {"api_key": "sk", "models": ["acct/model-a"]}}},
    )

    entry = next(p for p in providers.get_providers()["providers"] if p["id"] == "router")
    assert "acct/model-a" in {m["id"] for m in entry["models"]}


def test_cold_cards_warm_the_catalog_once(monkeypatch, tmp_path):
    """A cold catalog is warmed through the picker, not probed per provider."""
    import api.profiles as profiles

    calls = []
    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {"commandcode": "CommandCode", "router": "Ramp Router"})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {"commandcode": [{"id": "s", "label": "S"}], "router": []})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: set())
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda _pid: False)
    monkeypatch.setattr(providers, "get_config", lambda: {"model": {}, "providers": {}})
    monkeypatch.setattr(providers, "_provider_has_key", lambda _pid, **_kw: True)
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: False)
    monkeypatch.setattr(providers, "_warm_published_catalog", lambda: calls.append("warm"))
    monkeypatch.setattr(providers, "published_catalog_models", lambda _pid: None)

    providers.get_providers()

    assert calls == ["warm"], f"expected exactly one shared warm, got {calls}"


def test_warm_is_skipped_when_the_catalog_is_already_published(monkeypatch, tmp_path):
    """A warm catalog must not trigger a rebuild on every Settings read."""
    import api.profiles as profiles

    calls = []
    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {"commandcode": "CommandCode"})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {"commandcode": [{"id": "s", "label": "S"}]})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: set())
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda _pid: False)
    monkeypatch.setattr(providers, "get_config", lambda: {"model": {}, "providers": {}})
    monkeypatch.setattr(providers, "_provider_has_key", lambda _pid, **_kw: True)
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: True)
    monkeypatch.setattr(providers, "_warm_published_catalog", lambda: calls.append("warm"))
    monkeypatch.setattr(providers, "published_catalog_models", lambda _pid: [{"id": "live", "label": "Live"}])

    entry = next(p for p in providers.get_providers()["providers"] if p["id"] == "commandcode")

    assert calls == []
    assert [m["id"] for m in entry["models"]] == ["live"]


def test_providers_endpoint_owns_no_probe_pool():
    """The card path must not run its own provider probes on a worker thread.

    A pool here would inherit neither the request's profile thread-local nor its
    environment, so probes would resolve the default profile and could render
    one profile's account catalog on another's cards.
    """
    assert not hasattr(providers, "_probe_live_models_within")
    assert not hasattr(providers, "_cold_catalog_probe_executor")


def test_published_catalog_is_available_matches_the_fingerprint(monkeypatch):
    snapshot = {"groups": []}
    monkeypatch.setattr(config, "_models_cache_provenance", (snapshot, {"config_yaml": "/a"}))
    monkeypatch.setattr(config, "_models_cache_source_fingerprint", lambda: {"config_yaml": "/a"})
    assert config.published_catalog_is_available() is True

    monkeypatch.setattr(config, "_models_cache_source_fingerprint", lambda: {"config_yaml": "/b"})
    assert config.published_catalog_is_available() is False

    monkeypatch.setattr(config, "_models_cache_provenance", None)
    assert config.published_catalog_is_available() is False


@pytest.mark.parametrize(
    "block,card,expected",
    [
        # `qwen` and `alibaba` share an identity but are BOTH real cards (qwen is
        # the OpenRouter model-id prefix), so one key must not configure both.
        ("qwen", "qwen", True),
        ("qwen", "alibaba", False),
        ("alibaba", "alibaba", True),
        ("alibaba", "qwen", False),
        ("google", "google", True),
        ("google", "gemini", False),
        # `ramp` is not a card of its own, so it still feeds the router card.
        ("ramp", "router", True),
        ("actual-computer", "actual", True),
    ],
)
def test_alias_block_only_claims_a_card_when_it_is_not_one_itself(block, card, expected):
    """An alias block feeds the canonical card only when the alias isn't a card.

    Folding on identity alone marked two cards configured from a single
    `providers.qwen.api_key`.
    """
    assert (
        providers._provider_has_key(card, config_data={"providers": {block: {"api_key": "sk"}}})
        is expected
    )


def test_unauthenticated_plugin_card_still_lists_its_fallback_models(monkeypatch, tmp_path):
    """An installed plugin must not read "0 models" before it is authenticated.

    The picker publishes no group for an unauthenticated plugin and a plugin has
    no `_PROVIDER_MODELS` entry, so its profile's curated `fallback_models` is
    the only cold source — read directly, with no probe.
    """
    import api.profiles as profiles

    class _Profile:
        fallback_models = ("vendor/model-a", "vendor/model-b")

    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: {"yandex"})
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda pid: pid == "yandex")
    monkeypatch.setattr(providers, "plugin_model_provider_profiles", lambda: {"yandex": _Profile()})
    monkeypatch.setattr(providers, "get_config", lambda: {"model": {}, "providers": {}})
    monkeypatch.setattr(providers, "_provider_has_key", lambda _pid, **_kw: False)
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: True)
    monkeypatch.setattr(providers, "published_catalog_models", lambda _pid: None)

    entry = next(p for p in providers.get_providers()["providers"] if p["id"] == "yandex")

    assert {m["id"] for m in entry["models"]} == {"vendor/model-a", "vendor/model-b"}
    assert entry["models_total"] == 2


def test_published_catalog_still_wins_over_the_plugin_fallback(monkeypatch, tmp_path):
    """Once the picker publishes a group, it is authoritative over fallback_models."""
    import api.profiles as profiles

    class _Profile:
        fallback_models = ("stale/fallback",)

    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: {"yandex"})
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda pid: pid == "yandex")
    monkeypatch.setattr(providers, "plugin_model_provider_profiles", lambda: {"yandex": _Profile()})
    monkeypatch.setattr(providers, "get_config", lambda: {"model": {}, "providers": {}})
    monkeypatch.setattr(providers, "_provider_has_key", lambda _pid, **_kw: True)
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: True)
    monkeypatch.setattr(providers, "published_catalog_models", lambda _pid: [{"id": "live/real", "label": "L"}])

    entry = next(p for p in providers.get_providers()["providers"] if p["id"] == "yandex")
    assert [m["id"] for m in entry["models"]] == ["live/real"]


def test_providers_cache_key_tracks_the_catalog_generation(monkeypatch, tmp_path):
    """A new catalog must retire the cards cached from the old one.

    The warm can overrun its rebuild budget and return the static fallback while
    `models-catalog-rebuild` publishes later. Without the generation in the key,
    Settings pins that fallback for the full 30s TTL.
    """
    monkeypatch.setattr(providers, "_get_hermes_home", lambda: tmp_path)
    cfg = {"model": {}, "providers": {}}

    monkeypatch.setattr(config, "_available_models_cache", {"groups": []})
    config._sync_models_cache_provenance()
    first = providers._providers_cache_key(cfg)

    config._sync_models_cache_provenance()  # a later publish
    second = providers._providers_cache_key(cfg)

    assert first != second, "cache key ignored the new catalog generation"


def test_catalog_generation_is_a_counter_not_an_object_id(monkeypatch):
    """Reusing a freed id() would collide silently; the generation must not."""
    monkeypatch.setattr(config, "_available_models_cache", {"groups": []})
    config._sync_models_cache_provenance()
    a = config.published_catalog_generation()
    config._sync_models_cache_provenance()
    b = config.published_catalog_generation()

    assert isinstance(a, int) and isinstance(b, int)
    assert b > a

    monkeypatch.setattr(config, "_models_cache_provenance", None)
    assert config.published_catalog_generation() is None


def test_configured_models_are_not_double_counted(monkeypatch, tmp_path):
    """`providers.<id>.models` is already in the published catalog it built."""
    import api.profiles as profiles

    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {"router": "Ramp Router"})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {"router": []})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: set())
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda _pid: False)
    monkeypatch.setattr(providers, "_provider_has_key", lambda _pid, **_kw: True)
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: True)
    # A published row is routing-qualified whenever its provider is not the
    # active one. Mocking the bare id here is what let the first version of this
    # dedupe ship broken, so pin the qualified form.
    monkeypatch.setattr(
        providers,
        "published_catalog_models",
        lambda _pid: [{"id": "@router:acct/only", "label": "Only"}],
    )
    monkeypatch.setattr(
        providers,
        "get_config",
        lambda: {"model": {}, "providers": {"router": {"models": ["acct/only"]}}},
    )

    entry = next(p for p in providers.get_providers()["providers"] if p["id"] == "router")

    assert [m["id"] for m in entry["models"]] == ["@router:acct/only"]
    assert entry["models_total"] == 1, "configured allowlist was counted twice"


def test_configured_models_absent_from_the_catalog_are_still_added(monkeypatch, tmp_path):
    """Deduplication must not drop a configured model the catalog lacks."""
    import api.profiles as profiles

    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {"router": "Ramp Router"})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {"router": []})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: set())
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda _pid: False)
    monkeypatch.setattr(providers, "_provider_has_key", lambda _pid, **_kw: True)
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: True)
    monkeypatch.setattr(
        providers, "published_catalog_models", lambda _pid: [{"id": "acct/a", "label": "A"}]
    )
    monkeypatch.setattr(
        providers,
        "get_config",
        lambda: {"model": {}, "providers": {"router": {"models": ["acct/a", "acct/b"]}}},
    )

    entry = next(p for p in providers.get_providers()["providers"] if p["id"] == "router")
    assert {m["id"] for m in entry["models"]} == {"acct/a", "acct/b"}


def test_test_server_scrubs_every_recognised_provider_key():
    """The isolated test server must not inherit any key the WebUI acts on.

    `tests/conftest.py` kept a hand-written list; anything the WebUI recognises
    but the list omits lets a real exported credential enable a provider inside
    the fixture and makes results depend on the host.
    """
    import re

    source = (config.REPO_ROOT / "tests" / "conftest.py").read_text(encoding="utf-8")
    assert "_PROVIDER_ENV_VAR" in source, "scrub list is no longer derived from the mapping"

    literal = set(re.findall(r"'([A-Z][A-Z0-9_]*)'", source.split("_CRED_ENV_PREFIXES = (")[1].split(")")[0]))
    derived = {v for v in providers._PROVIDER_ENV_VAR.values() if v}
    for aliases in providers._PROVIDER_ENV_VAR_ALIASES.values():
        derived.update(a for a in (aliases or ()) if a)

    for env_var in {v for _s, (_d, v) in NEW_PROVIDERS.items()}:
        assert env_var in (literal | derived), f"{env_var} would leak into the test server"


@pytest.mark.parametrize(
    "active,card,expected",
    [
        # Cards that merely SHARE an identity must not answer for each other.
        ("google", "google", True),
        ("google", "gemini", False),
        ("gemini", "gemini", True),
        ("gemini", "google", False),
        ("qwen", "alibaba", False),
        ("alibaba", "qwen", False),
        # Genuine aliases still resolve.
        ("ramp", "router", True),
        ("actual-computer", "actual", True),
        ("z-ai", "zai", True),
    ],
)
def test_active_provider_alias_match_respects_standalone_cards(active, card, expected):
    """`model.provider` naming a real card must not answer for its identity twin."""
    assert (
        providers._provider_has_key(card, config_data={"model": {"provider": active, "api_key": "sk"}})
        is expected
    )


def test_removing_one_card_key_cannot_delete_another_cards_active_key(monkeypatch, tmp_path):
    """Remove on Gemini must not destroy the active Google credential.

    `model.provider: google` + `model.api_key` is Google's key. An identity-only
    match let the Gemini card claim it, and removal then deleted it outright —
    silent destruction of a credential the user never asked to remove.
    """
    import yaml
    import api.config as cfgmod

    path = _write_config(tmp_path, {"model": {"provider": "google", "api_key": "sk-google-active"}})
    monkeypatch.setattr(cfgmod, "_get_config_path", lambda: path)

    providers._clean_provider_key_from_config("gemini")

    written = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert written["model"]["api_key"] == "sk-google-active"

    # ...but removing Google's own key must still work.
    providers._clean_provider_key_from_config("google")
    assert "api_key" not in yaml.safe_load(path.read_text(encoding="utf-8"))["model"]


@pytest.mark.parametrize(
    "raw,expected",
    [("@router:acct/only", "acct/only"), ("acct/only", "acct/only"), ("@nous:a/b", "a/b"), ("", "")],
)
def test_unqualified_model_id_strips_only_the_routing_hint(raw, expected):
    assert providers._unqualified_model_id(raw) == expected


@pytest.mark.parametrize("slug", sorted(NEW_PROVIDERS))
def test_new_profile_writes_the_provider_specific_key(slug):
    """Profile creation must not fall back to the generic HERMES_API_KEY.

    `api/profiles.py` keeps its own provider→env-var map. A provider missing
    from it stored the credential as `HERMES_API_KEY`, which the agent does not
    read as a substitute — the profile was created and then could not
    authenticate.
    """
    import api.profiles as profiles

    assert profiles._resolve_env_var_for_provider(slug) == NEW_PROVIDERS[slug][1]


@pytest.mark.parametrize("alias,canonical", sorted(PROVIDER_ALIASES.items()))
def test_new_profile_resolves_provider_aliases_too(alias, canonical):
    """A profile created under an alias must still write the canonical key."""
    import api.profiles as profiles

    expected = providers._PROVIDER_ENV_VAR.get(canonical)
    if not expected:
        pytest.skip(f"{canonical} has no API-key env var")
    assert profiles._resolve_env_var_for_provider(alias) == expected


def test_profiles_own_spellings_still_win():
    """The module's literal map is consulted first for slugs it owns."""
    import api.profiles as profiles

    assert profiles._resolve_env_var_for_provider("github-copilot") == "COPILOT_GITHUB_TOKEN"
    assert profiles._resolve_env_var_for_provider("dashscope") == "DASHSCOPE_API_KEY"
    assert profiles._resolve_env_var_for_provider("totally-unknown") is None


def test_published_catalog_respects_the_picker_overflow_cap(monkeypatch):
    """Overflow rows must not be rendered as visible card tags.

    `_split_picker_overflow_models()` withholds them on purpose; recombining
    both buckets floods the Settings response and DOM for a large catalog.
    """
    snapshot = {
        "groups": [
            {
                "provider_id": "openrouter",
                "models": [{"id": f"v/m{i}", "label": f"M{i}"} for i in range(25)],
                "extra_models": [{"id": f"v/x{i}", "label": f"X{i}"} for i in range(300)],
            }
        ]
    }
    monkeypatch.setattr(config, "_models_cache_provenance", (snapshot, {"config_yaml": "/a"}))
    monkeypatch.setattr(config, "_models_cache_source_fingerprint", lambda: {"config_yaml": "/a"})

    visible = config.published_catalog_models("openrouter")
    assert len(visible) == 25, "overflow rows leaked into the visible card models"
    assert all(m["id"].startswith("v/m") for m in visible)

    # ...but the count still reflects the whole catalog for the "+N more" hint.
    assert config.published_catalog_model_total("openrouter") == 325


def test_provider_card_reports_capped_rows_with_full_total(monkeypatch, tmp_path):
    import api.profiles as profiles

    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {"openrouter": "OpenRouter"})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {"openrouter": []})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: set())
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda _pid: False)
    monkeypatch.setattr(providers, "_provider_has_key", lambda _pid, **_kw: True)
    monkeypatch.setattr(providers, "get_config", lambda: {"model": {}, "providers": {}})
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: True)
    monkeypatch.setattr(
        providers, "published_catalog_models", lambda _pid: [{"id": "v/a", "label": "A"}]
    )
    monkeypatch.setattr(providers, "published_catalog_model_total", lambda _pid: 300)

    entry = next(p for p in providers.get_providers()["providers"] if p["id"] == "openrouter")

    assert len(entry["models"]) == 1
    assert entry["models_total"] == 300


def test_configured_models_in_the_overflow_bucket_are_not_re_added(monkeypatch, tmp_path):
    """A configured model the picker parked in `extra_models` is still "seen".

    `published_catalog_models()` returns only the visible rows, so deduping
    against them alone let an allowlist larger than the cap append every hidden
    entry back — re-flooding the card the cap exists to protect. This is the
    case the first overflow test missed by using an allowlist that fitted
    entirely in the visible bucket.
    """
    import api.profiles as profiles

    visible = [{"id": f"acct/m{i}", "label": f"M{i}"} for i in range(25)]
    hidden_ids = [f"acct/x{i}" for i in range(40)]

    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {"router": "Ramp Router"})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {"router": []})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: set())
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda _pid: False)
    monkeypatch.setattr(providers, "_provider_has_key", lambda _pid, **_kw: True)
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: True)
    monkeypatch.setattr(providers, "published_catalog_models", lambda _pid: list(visible))
    monkeypatch.setattr(providers, "published_catalog_model_total", lambda _pid: 65)
    monkeypatch.setattr(
        providers,
        "_endpoint_advertised_model_ids",
        lambda _pid: frozenset([m["id"] for m in visible] + hidden_ids),
    )
    monkeypatch.setattr(
        providers,
        "get_config",
        lambda: {
            "model": {},
            "providers": {"router": {"models": [m["id"] for m in visible] + hidden_ids}},
        },
    )

    entry = next(p for p in providers.get_providers()["providers"] if p["id"] == "router")

    assert len(entry["models"]) == 25, "overflow entries were appended back as visible rows"
    assert entry["models_total"] == 65


def test_configured_model_outside_the_catalog_still_survives_the_wider_dedupe(monkeypatch, tmp_path):
    """Widening the seen-set must not start swallowing genuinely new entries."""
    import api.profiles as profiles

    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_PROVIDER_DISPLAY", {"router": "Ramp Router"})
    monkeypatch.setattr(providers, "_PROVIDER_MODELS", {"router": []})
    monkeypatch.setattr(providers, "_OAUTH_PROVIDERS", frozenset())
    monkeypatch.setattr(providers, "plugin_model_provider_ids", lambda: set())
    monkeypatch.setattr(providers, "is_plugin_model_provider", lambda _pid: False)
    monkeypatch.setattr(providers, "_provider_has_key", lambda _pid, **_kw: True)
    monkeypatch.setattr(providers, "published_catalog_is_available", lambda: True)
    monkeypatch.setattr(
        providers, "published_catalog_models", lambda _pid: [{"id": "acct/a", "label": "A"}]
    )
    monkeypatch.setattr(providers, "published_catalog_model_total", lambda _pid: 1)
    monkeypatch.setattr(providers, "_endpoint_advertised_model_ids", lambda _pid: frozenset({"acct/a"}))
    monkeypatch.setattr(
        providers,
        "get_config",
        lambda: {"model": {}, "providers": {"router": {"models": ["acct/a", "acct/brand-new"]}}},
    )

    entry = next(p for p in providers.get_providers()["providers"] if p["id"] == "router")
    assert {m["id"] for m in entry["models"]} == {"acct/a", "acct/brand-new"}
