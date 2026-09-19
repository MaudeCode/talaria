"""Phase 2 (#4662): reload_config() must not re-run yaml.safe_load on the hot path
when config.yaml is unchanged. It now routes its parse through the mtime-keyed
_load_yaml_config_file cache (#4652). Behavior-preserving: the process-global
_cfg_cache is still pinned to the unscoped process-env expansion (#798 TLS), env
expansion still runs per call, and an mtime change still busts the cache.
"""
import os
import time

import pytest
import yaml as _yaml


@pytest.fixture(autouse=True)
def _restore_config_globals():
    """Put the process-global config state back after each test.

    These tests load real config.yaml files into api.config's module globals.
    Leaving a tmp profile's providers in _cfg_cache leaks into any later test
    that reads the catalog without pinning its own config (HWEB-81: it made
    tests/test_issue4756_session_visit_model_refresh.py see an `openai` group
    that its own fixture had removed).
    """
    import api.config as cfg

    saved = (
        dict(cfg._cfg_cache),
        cfg._cfg_mtime,
        cfg._cfg_stat_identity,
        cfg._cfg_path,
        cfg._cfg_fingerprint,
        dict(cfg._yaml_file_cache),
    )
    try:
        yield
    finally:
        cfg._cfg_cache.clear()
        cfg._cfg_cache.update(saved[0])
        cfg._cfg_mtime = saved[1]
        cfg._cfg_stat_identity = saved[2]
        cfg._cfg_path = saved[3]
        cfg._cfg_fingerprint = saved[4]
        with cfg._yaml_file_cache_lock:
            cfg._yaml_file_cache.clear()
            cfg._yaml_file_cache.update(saved[5])


def test_reload_config_uses_mtime_cache(tmp_path, monkeypatch):
    import api.config as cfg

    config_path = tmp_path / "config.yaml"
    config_path.write_text("providers:\n  openai:\n    models: [gpt-5.5]\n", encoding="utf-8")
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)

    parse_calls = {"n": 0}
    real_safe_load = _yaml.safe_load

    def _counting_safe_load(s):
        parse_calls["n"] += 1
        return real_safe_load(s)

    monkeypatch.setattr(_yaml, "safe_load", _counting_safe_load)
    # Clear the shared file cache so the first reload is a genuine miss.
    with cfg._yaml_file_cache_lock:
        cfg._yaml_file_cache.clear()

    cfg.reload_config()
    first = parse_calls["n"]
    cfg.reload_config()          # same file, unchanged mtime -> must hit cache
    second = parse_calls["n"]

    assert first >= 1, "first reload should parse the file at least once"
    assert second == first, f"unchanged config.yaml was reparsed (parse went {first}->{second})"


def test_reload_config_busts_on_mtime_change(tmp_path, monkeypatch):
    import api.config as cfg

    config_path = tmp_path / "config.yaml"
    config_path.write_text("providers: {}\n", encoding="utf-8")
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    with cfg._yaml_file_cache_lock:
        cfg._yaml_file_cache.clear()

    cfg.reload_config()
    assert (cfg.get_config().get("providers") or {}) == {}

    # Edit + bump mtime; the next reload must pick up the change, not the cache.
    time.sleep(0.01)
    config_path.write_text("providers:\n  openai: {}\n", encoding="utf-8")
    os.utime(config_path, None)
    cfg.reload_config()
    assert "openai" in (cfg.get_config().get("providers") or {}), "mtime change not picked up"


def test_reload_config_expands_env_vars(tmp_path, monkeypatch):
    """The pinned process-env expansion must still run: a ${VAR} in config.yaml
    resolves against os.environ after reload_config (the #798 invariant)."""
    import api.config as cfg

    monkeypatch.setenv("HERMES_TEST_RELOAD_TOKEN", "expanded-value-xyz")
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "providers:\n  openai:\n    api_key: ${HERMES_TEST_RELOAD_TOKEN}\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    with cfg._yaml_file_cache_lock:
        cfg._yaml_file_cache.clear()

    cfg.reload_config()
    key = ((cfg.get_config().get("providers") or {}).get("openai") or {}).get("api_key")
    assert key == "expanded-value-xyz", f"env var not expanded after reload: {key!r}"


def test_reload_config_reexpands_env_when_mtime_unchanged(tmp_path, monkeypatch):
    """#798 hardening (Opus gate): the mtime cache must store the RAW, un-expanded
    YAML — not the expanded result — so that a ${VAR} re-expands against the CURRENT
    os.environ on every reload even when config.yaml's mtime is unchanged. If the
    cache stored the expanded value, a profile/env change with an unchanged file
    would serve a stale expansion (cross-profile credential bleed)."""
    import api.config as cfg

    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "providers:\n  openai:\n    api_key: ${HERMES_TEST_REEXPAND_TOKEN}\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    with cfg._yaml_file_cache_lock:
        cfg._yaml_file_cache.clear()

    # First reload under env value A.
    monkeypatch.setenv("HERMES_TEST_REEXPAND_TOKEN", "value-A")
    cfg.reload_config()
    key_a = ((cfg.get_config().get("providers") or {}).get("openai") or {}).get("api_key")
    assert key_a == "value-A", f"first expansion wrong: {key_a!r}"

    # Change ONLY the env var — the file (and its mtime) is untouched, so the YAML
    # parse cache will hit. The expansion must still pick up the new env value.
    monkeypatch.setenv("HERMES_TEST_REEXPAND_TOKEN", "value-B")
    cfg.reload_config()
    key_b = ((cfg.get_config().get("providers") or {}).get("openai") or {}).get("api_key")
    assert key_b == "value-B", (
        f"env change with unchanged mtime did not re-expand (got {key_b!r}); "
        "the mtime cache is storing the EXPANDED value instead of raw YAML "
        "-> cross-profile credential-bleed risk (#798)"
    )


def test_reload_config_does_not_cross_serve_between_profile_paths(tmp_path, monkeypatch):
    """#798 hardening (Opus gate): the YAML parse cache is keyed on the config PATH
    (plus mtime+size), so two different profiles' config.yaml files must never serve
    each other's parsed content — even within the same process. A path-blind cache
    would leak one profile's providers/keys into another."""
    import api.config as cfg

    path_a = tmp_path / "profile_a" / "config.yaml"
    path_b = tmp_path / "profile_b" / "config.yaml"
    path_a.parent.mkdir(parents=True, exist_ok=True)
    path_b.parent.mkdir(parents=True, exist_ok=True)
    path_a.write_text("providers:\n  openai:\n    models: [model-a]\n", encoding="utf-8")
    path_b.write_text("providers:\n  anthropic:\n    models: [model-b]\n", encoding="utf-8")

    with cfg._yaml_file_cache_lock:
        cfg._yaml_file_cache.clear()

    monkeypatch.setattr(cfg, "_get_config_path", lambda: path_a)
    cfg.reload_config()
    providers_a = cfg.get_config().get("providers") or {}
    assert "openai" in providers_a and "anthropic" not in providers_a, (
        f"profile A served the wrong config: {sorted(providers_a)}"
    )

    monkeypatch.setattr(cfg, "_get_config_path", lambda: path_b)
    cfg.reload_config()
    providers_b = cfg.get_config().get("providers") or {}
    assert "anthropic" in providers_b and "openai" not in providers_b, (
        f"profile B was cross-served profile A's config (cache not path-keyed): "
        f"{sorted(providers_b)}"
    )


def test_reload_config_empty_dict_config_does_not_spin(tmp_path, monkeypatch):
    """An empty ``{}`` config must still stamp _cfg_mtime, or get_config()'s
    `current_mtime != _cfg_mtime` stale check fires forever and re-enters
    reload_config() under _cfg_lock on every call. The cache-update is correctly
    skipped for {} (no-op), but the mtime stamp must not be. (Opus gate finding —
    a {} config is reachable on the profile-switch hot path via a freshly
    created/reset profile, and this also fixes the pre-existing empty/None-config
    spin on master.)
    """
    import api.config as cfg

    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}\n", encoding="utf-8")
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    with cfg._yaml_file_cache_lock:
        cfg._yaml_file_cache.clear()

    cfg.reload_config()
    # _cfg_mtime must equal the file's real mtime, not 0.0.
    assert cfg._cfg_mtime == config_path.stat().st_mtime, (
        f"_cfg_mtime not stamped for empty-dict config (got {cfg._cfg_mtime!r}); "
        "get_config() would spin reload_config() forever"
    )

    # And get_config() must NOT re-enter reload_config() on subsequent calls.
    reloads = {"n": 0}
    real_reload = cfg.reload_config

    def _counting_reload():
        reloads["n"] += 1
        return real_reload()

    monkeypatch.setattr(cfg, "reload_config", _counting_reload)
    cfg.get_config()
    cfg.get_config()
    cfg.get_config()
    assert reloads["n"] == 0, f"get_config() re-entered reload_config() {reloads['n']}x on a stable {{}} config (spin)"



def test_reload_config_busts_on_preserved_mtime_replace(tmp_path, monkeypatch):
    """HWEB-81: reload_config() shares the same cache, so a same-size atomic
    replace with a restored mtime must reach it too — while an unchanged file
    still costs zero reparses (the Phase 2 guarantee above)."""
    import api.config as cfg

    config_path = tmp_path / "config.yaml"
    config_path.write_text("providers:\n  openai:\n    models: [model-aaa]\n", encoding="utf-8")
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)

    parse_calls = {"n": 0}
    real_safe_load = _yaml.safe_load

    def _counting_safe_load(s):
        parse_calls["n"] += 1
        return real_safe_load(s)

    monkeypatch.setattr(_yaml, "safe_load", _counting_safe_load)
    with cfg._yaml_file_cache_lock:
        cfg._yaml_file_cache.clear()

    cfg.reload_config()
    assert (cfg.get_config()["providers"]["openai"]["models"]) == ["model-aaa"]
    original = config_path.stat()
    after_first = parse_calls["n"]

    replacement = tmp_path / "config.yaml.new"
    replacement.write_text("providers:\n  openai:\n    models: [model-bbb]\n", encoding="utf-8")
    assert replacement.stat().st_size == original.st_size, "test setup: sizes must match"
    os.replace(replacement, config_path)
    os.utime(config_path, ns=(original.st_atime_ns, original.st_mtime_ns))
    assert config_path.stat().st_mtime_ns == original.st_mtime_ns, "test setup: mtime not restored"

    cfg.reload_config()
    assert (cfg.get_config()["providers"]["openai"]["models"]) == ["model-bbb"], (
        "reload_config served the stale parse after a preserved-mtime replace"
    )
    assert parse_calls["n"] == after_first + 1, "the replacement must cost exactly one reparse"

    cfg.reload_config()
    assert parse_calls["n"] == after_first + 1, "an unchanged config.yaml was reparsed"


def test_get_config_busts_on_preserved_mtime_replace(tmp_path, monkeypatch):
    """HWEB-81 (Codex P1): the parse cache is only reached when the top-level
    guards decide _cfg_cache is stale, and those compared st_mtime alone. Read
    through the normal accessor, not reload_config(), so a same-size replace
    with a restored mtime has to travel the whole path."""
    import api.config as cfg

    config_path = tmp_path / "config.yaml"
    config_path.write_text("providers:\n  openai:\n    models: [model-aaa]\n", encoding="utf-8")
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    with cfg._yaml_file_cache_lock:
        cfg._yaml_file_cache.clear()

    assert cfg.get_config()["providers"]["openai"]["models"] == ["model-aaa"]
    original = config_path.stat()

    replacement = tmp_path / "config.yaml.new"
    replacement.write_text("providers:\n  openai:\n    models: [model-bbb]\n", encoding="utf-8")
    assert replacement.stat().st_size == original.st_size, "test setup: sizes must match"
    os.replace(replacement, config_path)
    os.utime(config_path, ns=(original.st_atime_ns, original.st_mtime_ns))
    assert config_path.stat().st_mtime == original.st_mtime, "test setup: mtime not restored"

    assert cfg.get_config()["providers"]["openai"]["models"] == ["model-bbb"], (
        "get_config() served process-global settings from a file that no longer exists"
    )
    assert cfg.get_config_snapshot()["providers"]["openai"]["models"] == ["model-bbb"]


def test_get_config_does_not_reload_an_unchanged_file(tmp_path, monkeypatch):
    """The identity check must not turn every get_config() into a reload."""
    import api.config as cfg

    config_path = tmp_path / "config.yaml"
    config_path.write_text("providers:\n  openai: {}\n", encoding="utf-8")
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    with cfg._yaml_file_cache_lock:
        cfg._yaml_file_cache.clear()

    cfg.get_config()

    reloads = {"n": 0}
    real_refresh = cfg._refresh_config_cache

    def _counting_refresh(path=None):
        reloads["n"] += 1
        return real_refresh(path)

    monkeypatch.setattr(cfg, "_refresh_config_cache", _counting_refresh)
    for _ in range(5):
        cfg.get_config()
    assert reloads["n"] == 0, f"an unchanged config.yaml triggered {reloads['n']} reload(s)"


def test_a_replace_racing_the_load_is_not_stamped_as_fresh(tmp_path, monkeypatch):
    """HWEB-81 (Codex P2): _refresh_config_cache stats the file a second time to
    stamp its freshness. A replace landing between the parse and that stat used
    to leave generation A in _cfg_cache under generation B's identity, which no
    later read could tell apart. The stamp now comes from the load itself, so
    the next read sees the mismatch and reloads."""
    import api.config as cfg

    config_path = tmp_path / "config.yaml"
    config_path.write_text("providers:\n  openai:\n    models: [model-aaa]\n", encoding="utf-8")
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    with cfg._yaml_file_cache_lock:
        cfg._yaml_file_cache.clear()

    real_load = cfg._load_yaml_config_file_identified
    raced = {"done": False}

    def _load_then_replace(path, **kwargs):
        result = real_load(path, **kwargs)
        if not raced["done"]:
            raced["done"] = True
            replacement = tmp_path / "config.yaml.new"
            replacement.write_text(
                "providers:\n  openai:\n    models: [model-bbb]\n", encoding="utf-8"
            )
            os.replace(replacement, config_path)
        return result

    monkeypatch.setattr(cfg, "_load_yaml_config_file_identified", _load_then_replace)
    cfg.reload_config()
    assert raced["done"], "test setup: the racing replace never ran"
    monkeypatch.setattr(cfg, "_load_yaml_config_file_identified", real_load)

    assert cfg.get_config()["providers"]["openai"]["models"] == ["model-bbb"], (
        "the generation parsed before the replace was stamped as if it were the "
        "generation now on disk"
    )


def test_a_concurrent_reader_cannot_donate_its_identity_to_this_refresh(tmp_path, monkeypatch):
    """HWEB-81 (Codex P1): reading the stamp back out of the shared parse cache
    let another reader's entry describe this refresh. A direct
    _load_yaml_config_file() caller that parses a replacement between this
    refresh's load and its stamp would hand over generation B's identity while
    generation A is published in _cfg_cache -- fresh forever to every guard.
    The identity now comes back from the load itself, so no other reader can
    substitute one."""
    import api.config as cfg

    config_path = tmp_path / "config.yaml"
    config_path.write_text("providers:\n  openai:\n    models: [model-aaa]\n", encoding="utf-8")
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    with cfg._yaml_file_cache_lock:
        cfg._yaml_file_cache.clear()

    real_load = cfg._load_yaml_config_file_identified
    raced = {"done": False}

    def _load_then_let_another_reader_win(path, **kwargs):
        result = real_load(path, **kwargs)
        if not raced["done"]:
            raced["done"] = True
            replacement = tmp_path / "config.yaml.new"
            replacement.write_text(
                "providers:\n  openai:\n    models: [model-bbb]\n", encoding="utf-8"
            )
            os.replace(replacement, config_path)
            # The concurrent direct reader: it parses the replacement and
            # overwrites the shared cache entry with generation B.
            cfg._load_yaml_config_file(config_path)
        return result

    monkeypatch.setattr(
        cfg, "_load_yaml_config_file_identified", _load_then_let_another_reader_win
    )
    cfg.reload_config()
    assert raced["done"], "test setup: the concurrent reader never ran"
    monkeypatch.setattr(cfg, "_load_yaml_config_file_identified", real_load)

    assert cfg._cfg_stat_identity[1] != cfg._config_stat_state(config_path)[1], (
        "the refresh stamped the concurrent reader's generation, not its own"
    )
    assert cfg.get_config()["providers"]["openai"]["models"] == ["model-bbb"], (
        "generation A stayed authoritative under generation B's identity"
    )


def test_a_malformed_replacement_does_not_start_a_reload_storm(tmp_path, monkeypatch):
    """HWEB-81 (Codex P2): a malformed config is not written to the parse cache,
    so stamping from a cache lookup left the PREVIOUS generation's identity on a
    load that had already moved on. Every later get_config() then saw a mismatch
    and reparsed the same unreadable file, deleting the models cache each time."""
    import api.config as cfg

    config_path = tmp_path / "config.yaml"
    config_path.write_text("providers:\n  openai:\n    models: [model-aaa]\n", encoding="utf-8")
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    with cfg._yaml_file_cache_lock:
        cfg._yaml_file_cache.clear()

    cfg.get_config()
    config_path.write_text("providers: [this is: not, valid yaml\n", encoding="utf-8")
    cfg.get_config()

    reloads = {"n": 0}
    real_refresh = cfg._refresh_config_cache

    def _counting_refresh(path=None):
        reloads["n"] += 1
        return real_refresh(path)

    monkeypatch.setattr(cfg, "_refresh_config_cache", _counting_refresh)
    for _ in range(5):
        cfg.get_config()
    assert reloads["n"] == 0, (
        f"a malformed config.yaml triggered {reloads['n']} reload(s) per read "
        "(parse + models-cache-delete storm)"
    )
