"""Regression coverage for #4756 session-visit model catalog freshness."""

from __future__ import annotations

import io
import json
import os
import time
from pathlib import Path
from urllib.parse import urlparse

REPO = Path(__file__).resolve().parent.parent


def _catalog(label: str) -> dict:
    return {
        "active_provider": "openai",
        "default_model": label,
        "configured_model_badges": {},
        "groups": [
            {
                "provider": "OpenAI",
                "provider_id": "openai",
                "models": [{"id": label, "label": label, "supports_fast_tier": False}],
            }
        ],
        "aliases": {},
    }


def _reset_models_memory_cache(monkeypatch):
    import api.config as cfg

    monkeypatch.setattr(cfg, "_available_models_cache", None, raising=False)
    monkeypatch.setattr(cfg, "_available_models_cache_ts", 0.0, raising=False)
    monkeypatch.setattr(cfg, "_available_models_live_rebuild_ts", 0.0, raising=False)
    monkeypatch.setattr(cfg, "_available_models_cache_source_fingerprint", None, raising=False)
    monkeypatch.setattr(cfg, "_cache_build_in_progress", False, raising=False)


def test_session_visit_fresh_profile_cache_returns_without_live_rebuild(tmp_path, monkeypatch):
    import api.config as cfg

    _reset_models_memory_cache(monkeypatch)
    disk_catalog = _catalog("cached-model")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    now = time.time()
    os.utime(cache_path, (now, now))

    monkeypatch.setattr(cfg, "_SESSION_VISIT_MODELS_FRESHNESS_SECONDS", 300.0, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: disk_catalog)
    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: {"profile": "demo"})

    def _unexpected_live_rebuild(**_kwargs):
        raise AssertionError("fresh session-visit cache must not run a live rebuild")

    monkeypatch.setattr(cfg, "get_available_models", _unexpected_live_rebuild)

    assert cfg.get_available_models_for_session_visit() == disk_catalog


def test_session_visit_ignores_recently_warmed_memory_when_disk_cache_is_stale(tmp_path, monkeypatch):
    import api.config as cfg

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("stale-model")
    rebuilt_catalog = _catalog("rebuilt-model")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    old = time.time() - 600.0
    os.utime(cache_path, (old, old))
    calls = []

    monkeypatch.setattr(cfg, "_SESSION_VISIT_MODELS_FRESHNESS_SECONDS", 300.0, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: stale_catalog)
    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", lambda: stale_catalog)
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: {"profile": "demo"})
    monkeypatch.setattr(cfg, "_available_models_cache", stale_catalog, raising=False)
    monkeypatch.setattr(cfg, "_available_models_cache_ts", time.monotonic(), raising=False)
    monkeypatch.setattr(cfg, "_available_models_cache_source_fingerprint", {"profile": "demo"}, raising=False)

    def _live_rebuild(**kwargs):
        calls.append(kwargs)
        return rebuilt_catalog

    monkeypatch.setattr(cfg, "get_available_models", _live_rebuild)

    assert cfg.get_available_models_for_session_visit() == rebuilt_catalog
    assert calls == [{"force_refresh": True}]


def test_session_visit_stale_profile_cache_revalidates_with_live_rebuild(tmp_path, monkeypatch):
    import api.config as cfg

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("stale-model")
    rebuilt_catalog = _catalog("rebuilt-model")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    old = time.time() - 600.0
    os.utime(cache_path, (old, old))
    calls = []

    monkeypatch.setattr(cfg, "_SESSION_VISIT_MODELS_FRESHNESS_SECONDS", 300.0, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: stale_catalog)
    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", lambda: stale_catalog)

    def _live_rebuild(**kwargs):
        calls.append(kwargs)
        return rebuilt_catalog

    monkeypatch.setattr(cfg, "get_available_models", _live_rebuild)

    assert cfg.get_available_models_for_session_visit() == rebuilt_catalog
    assert calls == [{"force_refresh": True}]


def test_session_visit_overlapping_stale_calls_coalesce_to_single_live_rebuild(tmp_path, monkeypatch):
    import api.config as cfg
    import threading
    from concurrent.futures import ThreadPoolExecutor

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("stale-model")
    rebuilt_catalog = _catalog("rebuilt-model")
    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}", encoding="utf-8")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    old = time.time() - 600.0
    os.utime(cache_path, (old, old))
    fingerprint = {"profile": "demo"}
    stale_load_counts = {}
    stale_load_lock = threading.Lock()
    second_load_gate = threading.Barrier(2)
    rebuild_count = 0
    rebuild_lock = threading.Lock()

    monkeypatch.setattr(cfg, "_SESSION_VISIT_MODELS_FRESHNESS_SECONDS", 300.0, raising=False)
    monkeypatch.setattr(cfg, "_LIVE_REBUILD_BUDGET_SECONDS", 0.0, raising=False)
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(cfg, "_cfg_path", config_path, raising=False)
    monkeypatch.setattr(cfg, "_cfg_mtime", config_path.stat().st_mtime, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: fingerprint)
    monkeypatch.setattr(cfg, "_save_models_cache_to_disk", lambda _cache: None)

    def _load_stale_models_cache_from_disk():
        ident = threading.get_ident()
        with stale_load_lock:
            count = stale_load_counts.get(ident, 0) + 1
            stale_load_counts[ident] = count
        if count == 2:
            second_load_gate.wait(timeout=5)
        return stale_catalog

    def _invoke_models_rebuild(_builder):
        nonlocal rebuild_count
        with rebuild_lock:
            rebuild_count += 1
        return rebuilt_catalog

    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", _load_stale_models_cache_from_disk)
    monkeypatch.setattr(cfg, "_invoke_models_rebuild", _invoke_models_rebuild)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(cfg.get_available_models_for_session_visit) for _ in range(2)]
        results = [future.result(timeout=10) for future in futures]

    assert all(result == rebuilt_catalog for result in results)
    assert rebuild_count == 1


def test_force_refresh_sync_followers_wait_past_legacy_timeout(tmp_path, monkeypatch):
    import api.config as cfg
    import threading

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("stale-model")
    rebuilt_catalog = _catalog("rebuilt-model")
    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}", encoding="utf-8")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    old = time.time() - 600.0
    os.utime(cache_path, (old, old))
    fingerprint = {"profile": "demo"}
    rebuild_count = 0
    timeout_waits = []
    original_wait_for = threading.Condition.wait_for

    monkeypatch.setattr(cfg, "_LIVE_REBUILD_BUDGET_SECONDS", 0.0, raising=False)
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(cfg, "_cfg_path", config_path, raising=False)
    monkeypatch.setattr(cfg, "_cfg_mtime", config_path.stat().st_mtime, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", lambda: stale_catalog)
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: fingerprint)
    monkeypatch.setattr(cfg, "_save_models_cache_to_disk", lambda _cache: None)

    def _wait_for(self, predicate, timeout=None):
        if self is not cfg._cache_build_cv:
            return original_wait_for(self, predicate, timeout)
        timeout_waits.append(timeout)
        if timeout is None:
            published_at = time.monotonic()
            cfg._available_models_cache = rebuilt_catalog
            cfg._available_models_cache_ts = published_at
            cfg._available_models_live_rebuild_ts = published_at
            cfg._available_models_cache_source_fingerprint = fingerprint
            cfg._cache_build_in_progress = False
            return True
        if timeout == 60.0:
            return False
        return original_wait_for(self, predicate, timeout=timeout)

    def _invoke_models_rebuild(_builder):
        nonlocal rebuild_count
        rebuild_count += 1
        return rebuilt_catalog

    monkeypatch.setattr(cfg, "_cache_build_in_progress", True, raising=False)
    monkeypatch.setattr(threading.Condition, "wait_for", _wait_for)
    monkeypatch.setattr(cfg, "_invoke_models_rebuild", _invoke_models_rebuild)

    assert cfg.get_available_models(force_refresh=True) == rebuilt_catalog
    assert rebuild_count == 0
    assert None in timeout_waits
    assert 60.0 not in timeout_waits

def test_force_refresh_sync_followers_retry_after_failed_active_rebuild(tmp_path, monkeypatch):
    import api.config as cfg
    import threading

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("stale-model")
    rebuilt_catalog = _catalog("rebuilt-model")
    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}", encoding="utf-8")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    old = time.time() - 600.0
    os.utime(cache_path, (old, old))
    fingerprint = {"profile": "demo"}
    rebuild_count = 0
    timeout_waits = []
    original_wait_for = threading.Condition.wait_for

    monkeypatch.setattr(cfg, "_LIVE_REBUILD_BUDGET_SECONDS", 0.0, raising=False)
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(cfg, "_cfg_path", config_path, raising=False)
    monkeypatch.setattr(cfg, "_cfg_mtime", config_path.stat().st_mtime, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", lambda: stale_catalog)
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: fingerprint)
    monkeypatch.setattr(cfg, "_save_models_cache_to_disk", lambda _cache: None)

    def _wait_for(self, predicate, timeout=None):
        if self is not cfg._cache_build_cv:
            return original_wait_for(self, predicate, timeout)
        timeout_waits.append(timeout)
        if timeout is None:
            cfg._cache_build_in_progress = False
            return True
        return original_wait_for(self, predicate, timeout=timeout)

    def _invoke_models_rebuild(_builder):
        nonlocal rebuild_count
        rebuild_count += 1
        return rebuilt_catalog

    monkeypatch.setattr(cfg, "_cache_build_in_progress", True, raising=False)
    monkeypatch.setattr(threading.Condition, "wait_for", _wait_for)
    monkeypatch.setattr(cfg, "_invoke_models_rebuild", _invoke_models_rebuild)

    assert cfg.get_available_models(force_refresh=True) == rebuilt_catalog
    assert rebuild_count == 1
    assert None in timeout_waits
    assert cfg._available_models_cache == rebuilt_catalog
    assert cfg._cache_build_in_progress is False


def test_force_refresh_bounded_followers_wait_only_remaining_budget(tmp_path, monkeypatch):
    import api.config as cfg
    import threading

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("stale-model")
    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}", encoding="utf-8")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    old = time.time() - 600.0
    os.utime(cache_path, (old, old))
    fingerprint = {"profile": "demo"}
    timeout_waits = []
    original_wait_for = threading.Condition.wait_for

    monkeypatch.setattr(cfg, "_LIVE_REBUILD_BUDGET_SECONDS", 0.05, raising=False)
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(cfg, "_cfg_path", config_path, raising=False)
    monkeypatch.setattr(cfg, "_cfg_mtime", config_path.stat().st_mtime, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", lambda: stale_catalog)
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: fingerprint)
    monkeypatch.setattr(cfg, "_save_models_cache_to_disk", lambda _cache: None)

    def _wait_for(self, predicate, timeout=None):
        if self is not cfg._cache_build_cv:
            return original_wait_for(self, predicate, timeout)
        timeout_waits.append(timeout)
        time.sleep(min(timeout or 0.0, 0.01))
        return False

    monkeypatch.setattr(cfg, "_cache_build_in_progress", True, raising=False)
    monkeypatch.setattr(threading.Condition, "wait_for", _wait_for)

    started_at = time.monotonic()
    result = cfg.get_available_models(force_refresh=True)
    elapsed = time.monotonic() - started_at

    assert result == stale_catalog
    assert len(timeout_waits) == 1
    assert timeout_waits[0] is not None
    assert 0.0 <= timeout_waits[0] <= 0.05
    assert 60.0 not in timeout_waits
    assert elapsed < 0.1


def test_plain_follower_uses_rebuild_budget_and_cached_fallback(tmp_path, monkeypatch):
    import api.config as cfg
    import threading

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("stale-model")
    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}", encoding="utf-8")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    timeout_waits = []
    original_wait_for = threading.Condition.wait_for

    monkeypatch.setattr(cfg, "_LIVE_REBUILD_BUDGET_SECONDS", 0.05, raising=False)
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(cfg, "_cfg_path", config_path, raising=False)
    monkeypatch.setattr(cfg, "_cfg_mtime", config_path.stat().st_mtime, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", lambda: stale_catalog)
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: {"profile": "demo"})
    monkeypatch.setattr(
        cfg,
        "_invoke_models_rebuild",
        lambda _builder: (_ for _ in ()).throw(
            AssertionError("a follower must not duplicate the stalled rebuild")
        ),
    )

    def _wait_for(self, predicate, timeout=None):
        if self is not cfg._cache_build_cv:
            return original_wait_for(self, predicate, timeout)
        timeout_waits.append(timeout)
        return False

    monkeypatch.setattr(cfg, "_cache_build_in_progress", True, raising=False)
    monkeypatch.setattr(threading.Condition, "wait_for", _wait_for)

    assert cfg.get_available_models() == stale_catalog
    assert len(timeout_waits) == 1
    assert 0.0 <= timeout_waits[0] <= 0.05


def test_plain_caller_joins_rebuild_started_after_flag_sample(tmp_path, monkeypatch):
    import api.config as cfg
    import threading

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("stale-model")
    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}", encoding="utf-8")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    timeout_waits = []
    original_wait_for = threading.Condition.wait_for

    monkeypatch.setattr(cfg, "_LIVE_REBUILD_BUDGET_SECONDS", 0.05, raising=False)
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(cfg, "_cfg_path", config_path, raising=False)
    monkeypatch.setattr(cfg, "_cfg_mtime", config_path.stat().st_mtime, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: None)

    def start_rebuild_after_sample():
        cfg._cache_build_in_progress = True
        return stale_catalog

    monkeypatch.setattr(
        cfg, "_load_stale_models_cache_from_disk", start_rebuild_after_sample
    )
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: {"profile": "demo"})
    monkeypatch.setattr(
        cfg,
        "_invoke_models_rebuild",
        lambda _builder: (_ for _ in ()).throw(
            AssertionError("a late follower must not duplicate the stalled rebuild")
        ),
    )

    def _wait_for(self, predicate, timeout=None):
        if self is not cfg._cache_build_cv:
            return original_wait_for(self, predicate, timeout)
        timeout_waits.append(timeout)
        return False

    monkeypatch.setattr(threading.Condition, "wait_for", _wait_for)

    assert cfg.get_available_models() == stale_catalog
    assert len(timeout_waits) == 1
    assert 0.0 <= timeout_waits[0] <= 0.05


def test_plain_follower_static_fallback_blocks_foreign_process_credentials(
    tmp_path, monkeypatch
):
    import api.config as cfg
    import api.profiles as profiles
    import threading

    _reset_models_memory_cache(monkeypatch)
    base = tmp_path / ".hermes"
    alpha_home = base / "profiles" / "alpha"
    beta_home = base / "profiles" / "beta"
    alpha_home.mkdir(parents=True)
    beta_home.mkdir(parents=True)
    (alpha_home / ".env").write_text(
        "OPENAI_API_KEY=alpha-private-key\n", encoding="utf-8"
    )
    config_path = beta_home / "config.yaml"
    config_path.write_text("{}", encoding="utf-8")
    cache_path = tmp_path / "models_cache.beta.json"
    monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", base)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr(cfg, "_LIVE_REBUILD_BUDGET_SECONDS", 0.01)
    monkeypatch.setattr(cfg, "_cache_build_in_progress", True)
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(cfg, "_cfg_path", config_path)
    monkeypatch.setattr(cfg, "_cfg_mtime", config_path.stat().st_mtime)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", lambda: None)

    holder_ready = threading.Event()
    release_holder = threading.Event()

    def hold_alpha_process_env():
        with profiles.profile_env_for_background_worker(
            "alpha", "test holder"
        ):
            holder_ready.set()
            release_holder.wait(2)

    holder = threading.Thread(target=hold_alpha_process_env)
    holder.start()
    assert holder_ready.wait(2)
    profiles.set_request_profile("beta")
    try:
        catalog = cfg.get_available_models()
    finally:
        profiles.clear_request_profile()
        release_holder.set()
        holder.join(2)

    assert "openai" not in {
        group.get("provider_id") for group in catalog.get("groups", [])
    }
    assert holder.is_alive() is False


def test_session_visit_overlapping_stale_calls_do_not_duplicate_over_budget_rebuild(tmp_path, monkeypatch):
    import api.config as cfg
    import threading
    from concurrent.futures import ThreadPoolExecutor

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("stale-model")
    rebuilt_catalog = _catalog("rebuilt-model")
    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}", encoding="utf-8")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    old = time.time() - 600.0
    os.utime(cache_path, (old, old))
    fingerprint = {"profile": "demo"}
    stale_load_counts = {}
    stale_load_lock = threading.Lock()
    second_load_gate = threading.Barrier(2)
    rebuild_count = 0
    rebuild_lock = threading.Lock()

    monkeypatch.setattr(cfg, "_SESSION_VISIT_MODELS_FRESHNESS_SECONDS", 300.0, raising=False)
    monkeypatch.setattr(cfg, "_LIVE_REBUILD_BUDGET_SECONDS", 0.01, raising=False)
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(cfg, "_cfg_path", config_path, raising=False)
    monkeypatch.setattr(cfg, "_cfg_mtime", config_path.stat().st_mtime, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: fingerprint)
    monkeypatch.setattr(cfg, "_save_models_cache_to_disk", lambda _cache: None)

    def _load_stale_models_cache_from_disk():
        ident = threading.get_ident()
        with stale_load_lock:
            count = stale_load_counts.get(ident, 0) + 1
            stale_load_counts[ident] = count
        if count == 2:
            second_load_gate.wait(timeout=5)
        return stale_catalog

    def _invoke_models_rebuild(_builder):
        nonlocal rebuild_count
        with rebuild_lock:
            rebuild_count += 1
        time.sleep(0.05)
        return rebuilt_catalog

    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", _load_stale_models_cache_from_disk)
    monkeypatch.setattr(cfg, "_invoke_models_rebuild", _invoke_models_rebuild)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(cfg.get_available_models_for_session_visit) for _ in range(2)]
        results = [future.result(timeout=10) for future in futures]

    assert all(result == stale_catalog for result in results)
    assert rebuild_count == 1
    deadline = time.monotonic() + 2.0
    while cfg._available_models_cache != rebuilt_catalog and time.monotonic() < deadline:
        time.sleep(0.01)
    assert cfg._available_models_cache == rebuilt_catalog
    assert cfg._cache_build_in_progress is False


def test_session_visit_force_refresh_ignores_plain_disk_publish_started_after_refresh(tmp_path, monkeypatch):
    import api.config as cfg
    import threading
    from concurrent.futures import ThreadPoolExecutor

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("stale-model")
    rebuilt_catalog = _catalog("rebuilt-model")
    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}", encoding="utf-8")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    old = time.time() - 600.0
    os.utime(cache_path, (old, old))
    fingerprint = {"profile": "demo"}
    stale_load_counts = {}
    stale_load_lock = threading.Lock()
    force_refresh_waiting = threading.Event()
    plain_publish_done = threading.Event()
    rebuild_count = 0
    rebuild_lock = threading.Lock()

    monkeypatch.setattr(cfg, "_SESSION_VISIT_MODELS_FRESHNESS_SECONDS", 300.0, raising=False)
    monkeypatch.setattr(cfg, "_LIVE_REBUILD_BUDGET_SECONDS", 0.0, raising=False)
    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(cfg, "_cfg_path", config_path, raising=False)
    monkeypatch.setattr(cfg, "_cfg_mtime", config_path.stat().st_mtime, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: stale_catalog)
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: fingerprint)
    monkeypatch.setattr(cfg, "_save_models_cache_to_disk", lambda _cache: None)

    def _load_stale_models_cache_from_disk():
        ident = threading.get_ident()
        with stale_load_lock:
            count = stale_load_counts.get(ident, 0) + 1
            stale_load_counts[ident] = count
        if count == 2:
            force_refresh_waiting.set()
            assert plain_publish_done.wait(timeout=5)
        return stale_catalog

    def _invoke_models_rebuild(_builder):
        nonlocal rebuild_count
        with rebuild_lock:
            rebuild_count += 1
        return rebuilt_catalog

    def _plain_disk_hit():
        result = cfg.get_available_models()
        plain_publish_done.set()
        return result

    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", _load_stale_models_cache_from_disk)
    monkeypatch.setattr(cfg, "_invoke_models_rebuild", _invoke_models_rebuild)

    with ThreadPoolExecutor(max_workers=2) as executor:
        refresh_future = executor.submit(cfg.get_available_models_for_session_visit)
        assert force_refresh_waiting.wait(timeout=5)
        plain_result = executor.submit(_plain_disk_hit).result(timeout=10)
        refresh_result = refresh_future.result(timeout=10)

    assert plain_result == stale_catalog
    assert refresh_result == rebuilt_catalog
    assert rebuild_count == 1
    assert cfg._available_models_cache == rebuilt_catalog


def test_session_visit_fresh_disk_hit_does_not_overwrite_newer_memory_cache(tmp_path, monkeypatch):
    import api.config as cfg

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("stale-model")
    rebuilt_catalog = _catalog("rebuilt-model")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    now = time.time()
    os.utime(cache_path, (now, now))
    fingerprint = {"profile": "demo"}

    monkeypatch.setattr(cfg, "_SESSION_VISIT_MODELS_FRESHNESS_SECONDS", 300.0, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: fingerprint)

    def _disk_hit_after_newer_memory_publish():
        cfg._available_models_cache = rebuilt_catalog
        cfg._available_models_cache_ts = time.monotonic()
        cfg._available_models_cache_source_fingerprint = fingerprint
        return stale_catalog

    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", _disk_hit_after_newer_memory_publish)
    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(
        cfg,
        "get_available_models",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("fresh disk hit must not rebuild live models")
        ),
    )

    assert cfg.get_available_models_for_session_visit() == rebuilt_catalog
    assert cfg._available_models_cache == rebuilt_catalog


def test_force_refresh_keeps_build_flag_set_until_disk_save_finishes(tmp_path, monkeypatch):
    import api.config as cfg

    _reset_models_memory_cache(monkeypatch)
    rebuilt_catalog = _catalog("rebuilt-model")
    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}", encoding="utf-8")
    cache_path = tmp_path / "models_cache.profile.json"
    fingerprint = {"profile": "demo"}
    observed = []

    monkeypatch.setattr(cfg, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(cfg, "_cfg_path", config_path, raising=False)
    monkeypatch.setattr(cfg, "_cfg_mtime", config_path.stat().st_mtime, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: fingerprint)
    monkeypatch.setattr(cfg, "_invoke_models_rebuild", lambda _builder: rebuilt_catalog)

    def _save_and_observe(_cache):
        observed.append(cfg._cache_build_in_progress)

    monkeypatch.setattr(cfg, "_save_models_cache_to_disk", _save_and_observe)

    assert cfg.get_available_models(force_refresh=True) == rebuilt_catalog
    assert observed == [True]
    assert cfg._cache_build_in_progress is False


def test_default_disk_hit_does_not_restamp_stale_cache_for_session_visit(tmp_path, monkeypatch):
    import api.config as cfg

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("stale-model")
    rebuilt_catalog = _catalog("rebuilt-model")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    old = time.time() - 600.0
    os.utime(cache_path, (old, old))
    refresh_calls = []

    monkeypatch.setattr(cfg, "_SESSION_VISIT_MODELS_FRESHNESS_SECONDS", 300.0, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: stale_catalog)
    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", lambda: stale_catalog)
    monkeypatch.setattr(cfg, "_models_cache_source_fingerprint", lambda: {"profile": "demo"})
    monkeypatch.setattr(cfg, "_cfg_mtime", 0.0, raising=False)
    monkeypatch.setattr(cfg, "_save_models_cache_to_disk", lambda _cache: (_ for _ in ()).throw(
        AssertionError("plain disk hits must not rewrite the models cache file")
    ))

    assert cfg.get_available_models() == stale_catalog

    def _live_rebuild(**kwargs):
        refresh_calls.append(kwargs)
        return rebuilt_catalog

    monkeypatch.setattr(cfg, "get_available_models", _live_rebuild)

    assert cfg.get_available_models_for_session_visit() == rebuilt_catalog
    assert refresh_calls == [{"force_refresh": True}]


def test_session_visit_live_rebuild_failure_falls_back_to_cached_catalog(tmp_path, monkeypatch):
    import api.config as cfg

    _reset_models_memory_cache(monkeypatch)
    stale_catalog = _catalog("fallback-model")
    cache_path = tmp_path / "models_cache.profile.json"
    cache_path.write_text("{}", encoding="utf-8")
    old = time.time() - 600.0
    os.utime(cache_path, (old, old))

    monkeypatch.setattr(cfg, "_SESSION_VISIT_MODELS_FRESHNESS_SECONDS", 300.0, raising=False)
    monkeypatch.setattr(cfg, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(cfg, "_load_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(cfg, "_load_stale_models_cache_from_disk", lambda: stale_catalog)

    def _failing_live_rebuild(**kwargs):
        assert kwargs == {"force_refresh": True}
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(cfg, "get_available_models", _failing_live_rebuild)

    assert cfg.get_available_models_for_session_visit() == stale_catalog


class _FakeHandler:
    def __init__(self):
        self.status = None
        self.sent_headers = []
        self.body = bytearray()
        self.wfile = self
        self.rfile = io.BytesIO(b"")
        self.headers = {"Content-Length": "0"}
        self.request = None

    def send_response(self, status):
        self.status = status

    def send_header(self, name, value):
        self.sent_headers.append((name, value))

    def end_headers(self):
        pass

    def write(self, data):
        self.body.extend(data)

    def json_body(self):
        return json.loads(bytes(self.body).decode("utf-8"))


def test_models_route_session_visit_freshness_uses_bounded_helper(monkeypatch):
    import api.routes as routes

    expected = _catalog("route-model")
    calls = []

    def _session_visit_catalog():
        calls.append("session_visit")
        return expected

    monkeypatch.setattr(routes, "get_available_models_for_session_visit", _session_visit_catalog)

    handler = _FakeHandler()
    parsed = urlparse("http://example.com/api/models?freshness=session_visit")
    routes.handle_get(handler, parsed)

    assert handler.status == 200
    assert handler.json_body()["default_model"] == "route-model"
    assert calls == ["session_visit"]


def _read_static(name: str) -> str:
    return (REPO / "static" / name).read_text(encoding="utf-8")


def _extract_function_body(src: str, signature: str) -> str:
    idx = src.find(signature)
    if idx == -1:
        raise AssertionError(f"signature {signature!r} not found")
    header_end = src.find("){", idx)
    if header_end == -1:
        raise AssertionError(f"function body start for {signature!r} not found")
    open_idx = header_end + 1
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[idx : i + 1]
    raise AssertionError(f"unbalanced braces in {signature!r}")
