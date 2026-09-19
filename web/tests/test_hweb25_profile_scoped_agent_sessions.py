import io
import json
import os
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import api.models as models
import api.profiles as profiles
import api.routes as routes
import api.streaming as streaming
import pytest


class _Handler:
    def __init__(self):
        self.status = None
        self.headers = {}
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.headers[key] = value

    def end_headers(self):
        pass

    def json_body(self):
        return json.loads(self.wfile.getvalue().decode("utf-8"))


@pytest.mark.parametrize(
    (
        "home_override_installed",
        "skill_modules_dynamic",
        "profile_is_named",
        "secret_scope_installed",
        "expected",
    ),
    [
        (True, True, True, True, False),
        (True, True, False, False, False),
        (True, True, True, False, True),
        (True, False, True, True, True),
        (False, True, True, True, True),
    ],
)
def test_streaming_process_env_fallback_is_limited_to_legacy_capabilities(
    home_override_installed,
    skill_modules_dynamic,
    profile_is_named,
    secret_scope_installed,
    expected,
):
    assert streaming._streaming_requires_process_env_fallback(
        home_override_installed=home_override_installed,
        skill_modules_dynamic=skill_modules_dynamic,
        profile_is_named=profile_is_named,
        secret_scope_installed=secret_scope_installed,
    ) is expected


@pytest.mark.parametrize(
    "terminal_kwargs",
    [
        {"terminal_context_installed": False},
        {"terminal_process_env_required": True},
    ],
)
def test_streaming_process_env_fallback_requires_safe_terminal_context(
    terminal_kwargs,
):
    assert streaming._streaming_requires_process_env_fallback(
        home_override_installed=True,
        skill_modules_dynamic=True,
        profile_is_named=True,
        secret_scope_installed=True,
        **terminal_kwargs,
    ) is True


def test_streaming_accepts_terminal_config_with_context_local_policy():
    assert streaming._streaming_requires_process_env_fallback(
        home_override_installed=True,
        skill_modules_dynamic=True,
        profile_is_named=True,
        secret_scope_installed=True,
        terminal_context_installed=True,
        terminal_process_env_required=True,
        terminal_scope_installed=True,
    ) is False


def _make_state_db(home, prefix):
    home.mkdir(parents=True)
    db = home / "state.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT,
            session_source TEXT,
            title TEXT,
            model TEXT,
            started_at REAL NOT NULL,
            message_count INTEGER DEFAULT 0,
            parent_session_id TEXT,
            ended_at REAL,
            end_reason TEXT
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            session_id TEXT,
            role TEXT,
            content TEXT,
            timestamp REAL
        );
        """
    )
    for index in range(2):
        sid = f"{prefix}-{index}"
        conn.execute(
            "INSERT INTO sessions VALUES (?, 'tui', NULL, ?, 'test-model', ?, 2, NULL, NULL, NULL)",
            (sid, f"{prefix} private {index}", float(index + 1)),
        )
        conn.execute(
            "INSERT INTO messages VALUES (?, ?, 'user', 'private', ?)",
            (f"{sid}-user", sid, float(index + 1)),
        )
        conn.execute(
            "INSERT INTO messages VALUES (?, ?, 'assistant', 'private', ?)",
            (f"{sid}-assistant", sid, float(index + 2)),
        )
    conn.commit()
    conn.close()
    return db


def _isolate_cli_projection(monkeypatch, tmp_path):
    monkeypatch.setattr(models, "get_claude_code_sessions", lambda: [])
    monkeypatch.setattr(models, "get_last_workspace", lambda **_kwargs: tmp_path)
    monkeypatch.setattr(models.Session, "load_metadata_only", lambda _sid: None)
    monkeypatch.setattr(profiles, "_is_root_profile", lambda name: name == "default")
    models.clear_cli_sessions_cache()
    routes._session_list_cache_clear()


@pytest.mark.parametrize("member_home_resolves", [False, True])
def test_talaria_session_list_never_reads_owner_home(
    monkeypatch, tmp_path, member_home_resolves
):
    import api.auth as auth
    import api.auth_oidc as auth_oidc

    owner_home = tmp_path / "owner-default"
    member_home = tmp_path / "profiles" / "member"
    member_home.mkdir(parents=True)
    _make_state_db(owner_home, "owner-session")
    _isolate_cli_projection(monkeypatch, tmp_path)

    monkeypatch.setenv("HERMES_HOME", str(owner_home))
    monkeypatch.setattr(auth, "is_auth_enabled", lambda: True)
    monkeypatch.setattr(auth_oidc, "oidc_session_binding_is_current", lambda _info: True)
    monkeypatch.setattr(
        profiles,
        "get_active_hermes_home",
        lambda: (_ for _ in ()).throw(RuntimeError("profile lookup failed")),
    )
    if member_home_resolves:
        monkeypatch.setattr(
            profiles, "get_hermes_home_for_profile", lambda _profile: member_home
        )
    else:
        monkeypatch.setattr(
            profiles,
            "get_hermes_home_for_profile",
            lambda _profile: (_ for _ in ()).throw(RuntimeError("profile lookup failed")),
        )
    monkeypatch.setattr(routes, "all_sessions", lambda diag=None, **_kwargs: [])
    monkeypatch.setattr(
        routes,
        "load_settings",
        lambda: {
            "show_cli_sessions": False,
            "show_claude_code_sessions": False,
            "show_cron_sessions": False,
            "show_webhook_sessions": False,
            "show_kanban_sessions": False,
            "api_redact_enabled": False,
        },
    )

    load_calls = []
    original_loader = models._load_cli_sessions_uncached

    def recording_loader(home, db_path, profile, *args, **kwargs):
        load_calls.append((home, db_path, profile))
        return original_loader(home, db_path, profile, *args, **kwargs)

    monkeypatch.setattr(models, "_load_cli_sessions_uncached", recording_loader)

    parsed = urlparse(
        "http://example.test/api/sessions"
        "?show_cli_sessions=1&show_claude_code_sessions=1"
        "&show_cron_sessions=1&show_webhook_sessions=1"
    )
    cookie = auth.create_session(
        auth_type="oidc",
        username="member@example.test",
        bound_profile="member",
        oidc_binding={
            "mapping_fingerprint": "mapping-fingerprint",
            "profile_identity": "profile-identity",
        },
    )
    handler = _Handler()
    handler.headers["Cookie"] = f"{auth.COOKIE_NAME}={cookie}"

    try:
        assert auth.check_auth(handler, parsed) is True
        routes.handle_get(handler, parsed)
    finally:
        auth.invalidate_session(cookie)
        profiles.clear_request_profile()

    assert handler.status == 200
    assert handler.json_body()["active_profile"] == "member"
    assert handler.json_body()["sessions"] == []
    if member_home_resolves:
        assert load_calls == [(member_home, member_home / "state.db", "member")]
    else:
        assert load_calls == [], "a failed member lookup must never read the owner database"


def test_stale_session_list_cache_rebuild_pins_captured_profile(monkeypatch):
    captured = []
    rebuilt = threading.Event()

    def fake_get_cli_sessions(
        source_filter=None,
        *,
        all_profiles=False,
        include_claude_code=True,
        profile=None,
    ):
        captured.append(profile)
        rebuilt.set()
        return [
            {
                "session_id": "member-session",
                "profile": "member",
                "title": "Member session",
                "message_count": 1,
            }
        ]

    monkeypatch.setattr(routes, "all_sessions", lambda diag=None, **_kwargs: [])
    monkeypatch.setattr(routes, "get_cli_sessions", fake_get_cli_sessions)
    monkeypatch.setattr(routes, "_enrich_sidebar_lineage_metadata", lambda _rows: None)
    monkeypatch.setattr(routes, "_session_list_cache_source_stamp", lambda _key: ("stable",))
    routes._session_list_cache_clear()

    key = routes._session_list_cache_key(
        active_profile="member",
        all_profiles=False,
        show_cli_sessions=True,
        show_previous_messaging_sessions=False,
        show_cron_sessions=True,
        show_claude_code_sessions=True,
        show_webhook_sessions=True,
        visible_only=True,
        request_visibility_overrides=True,
    )
    stale = {"sessions": [], "active_profile": "member", "all_profiles": False}
    routes._session_list_cache_set(key, stale)
    with routes._SESSIONS_CACHE_LOCK:
        _timestamp, stamp, payload = routes._SESSIONS_CACHE[key]
        routes._SESSIONS_CACHE[key] = (time.monotonic() - 60, stamp, payload)

    def rebuild():
        return routes._build_session_list_cache_payload(
            active_profile="member",
            all_profiles=False,
            show_cli_sessions=True,
            show_previous_messaging_sessions=False,
            show_cron_sessions=True,
            show_claude_code_sessions=True,
            show_webhook_sessions=True,
            visible_only=True,
            request_visibility_overrides=True,
        )

    try:
        returned = routes._get_cached_session_list_payload(key=key, builder=rebuild)
        assert returned == stale
        assert rebuilt.wait(2), "stale cache did not rebuild"
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with routes._SESSIONS_CACHE_LOCK:
                if key not in routes._SESSIONS_CACHE_INFLIGHT:
                    break
            time.sleep(0.01)
        with routes._SESSIONS_CACHE_LOCK:
            assert key not in routes._SESSIONS_CACHE_INFLIGHT
        rebuilt_payload, fresh = routes._session_list_cache_get(key)
        assert fresh is True
        assert [row["session_id"] for row in rebuilt_payload["sessions"]] == [
            "member-session"
        ]
    finally:
        routes._session_list_cache_clear()

    assert captured == ["member"]


def test_get_cli_sessions_rejects_unknown_explicit_profile(monkeypatch):
    monkeypatch.setattr(profiles, "_is_root_profile", lambda name: name == "default")
    monkeypatch.setattr(
        models,
        "_load_cli_sessions_uncached",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("profile failure reached the database reader")
        ),
    )

    assert models.get_cli_sessions(profile=None) == []
    assert models.get_cli_sessions(profile="../owner") == []


def test_detached_cli_projection_scopes_ambient_helpers(monkeypatch, tmp_path):
    member_home = tmp_path / "profiles" / "member"
    member_home.mkdir(parents=True)
    _isolate_cli_projection(monkeypatch, tmp_path)
    monkeypatch.setattr(profiles, "_active_profile", "default")
    monkeypatch.setattr(
        profiles, "get_hermes_home_for_profile", lambda _profile: member_home
    )

    observed_profiles = []

    def fake_loader(*_args, **_kwargs):
        observed_profiles.append(profiles.get_active_profile_name())
        return []

    monkeypatch.setattr(models, "_load_cli_sessions_uncached", fake_loader)

    with ThreadPoolExecutor(max_workers=1) as executor:
        result = executor.submit(
            models.get_cli_sessions,
            profile="member",
            include_claude_code=False,
        ).result()

    assert result == []
    assert observed_profiles == ["member"]


def test_detached_cli_projection_does_not_wait_for_profile_env_lock(
    monkeypatch, tmp_path
):
    member_home = tmp_path / "profiles" / "member"
    member_home.mkdir(parents=True)
    _isolate_cli_projection(monkeypatch, tmp_path)
    monkeypatch.setattr(
        profiles, "get_hermes_home_for_profile", lambda _profile: member_home
    )

    observed_profiles = []
    completed = threading.Event()

    def fake_loader(*_args, **_kwargs):
        observed_profiles.append(profiles.get_active_profile_name())
        return []

    monkeypatch.setattr(models, "_load_cli_sessions_uncached", fake_loader)

    def load():
        try:
            models.get_cli_sessions(profile="member", include_claude_code=False)
        finally:
            completed.set()

    profiles._PROFILE_ENV_SCOPE_LOCK.acquire()
    worker = threading.Thread(target=load)
    worker.start()
    try:
        completed_while_locked = completed.wait(0.1)
    finally:
        profiles._PROFILE_ENV_SCOPE_LOCK.release()
        worker.join(2)

    assert completed_while_locked is True
    assert worker.is_alive() is False
    assert observed_profiles == ["member"]


def test_native_bootstrap_routes_stay_responsive_while_profile_env_is_busy(
    monkeypatch, tmp_path
):
    import api.config as config
    from concurrent.futures import wait

    member_home = tmp_path / "profiles" / "member"
    process_home = tmp_path / "process-home"
    member_home.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(process_home))
    _isolate_cli_projection(monkeypatch, tmp_path)
    monkeypatch.setattr(profiles, "get_active_hermes_home", lambda: member_home)
    monkeypatch.setattr(
        profiles, "get_hermes_home_for_profile", lambda _profile: member_home
    )
    monkeypatch.setattr(models, "_load_cli_sessions_uncached", lambda *_a, **_k: [])
    monkeypatch.setattr(routes, "all_sessions", lambda diag=None, **_kwargs: [])
    monkeypatch.setattr(
        routes,
        "load_settings",
        lambda: {
            "show_cli_sessions": False,
            "show_claude_code_sessions": False,
            "show_cron_sessions": False,
            "show_webhook_sessions": False,
            "show_kanban_sessions": False,
            "api_redact_enabled": False,
        },
    )
    monkeypatch.setattr(
        profiles,
        "list_profiles_api",
        lambda: [{"name": "default"}, {"name": "member"}],
    )
    import contextvars
    import sys
    import types
    from contextlib import contextmanager

    cron_pkg = types.ModuleType("cron")
    cron_pkg.__path__ = []
    cron_jobs = types.ModuleType("cron.jobs")
    active_cron_home = contextvars.ContextVar("active_cron_home", default=None)

    @contextmanager
    def use_cron_store(home):
        token = active_cron_home.set(Path(home))
        try:
            yield
        finally:
            active_cron_home.reset(token)

    def get_cron_output_dir():
        assert active_cron_home.get() == member_home
        return member_home / "cron" / "output"

    def list_jobs(*, include_disabled=False):
        assert include_disabled is True
        assert active_cron_home.get() == member_home
        return [
            {
                "id": "member-job",
                "name": "Member job",
                "last_run_at": "2026-09-03T18:00:00Z",
                "last_status": "success",
            }
        ]

    cron_jobs.use_cron_store = use_cron_store
    cron_jobs.get_cron_output_dir = get_cron_output_dir
    cron_jobs.list_jobs = list_jobs
    monkeypatch.setitem(sys.modules, "cron", cron_pkg)
    monkeypatch.setitem(sys.modules, "cron.jobs", cron_jobs)

    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}", encoding="utf-8")
    cache_path = tmp_path / "models_cache.member.json"
    cache_path.write_text("{}", encoding="utf-8")
    stale_catalog = {
        "active_provider": None,
        "default_model": "",
        "groups": [],
        "aliases": {},
    }
    monkeypatch.setattr(config, "_LIVE_REBUILD_BUDGET_SECONDS", 0.02)
    monkeypatch.setattr(config, "_available_models_cache", None)
    monkeypatch.setattr(config, "_available_models_cache_ts", 0.0)
    monkeypatch.setattr(config, "_available_models_cache_source_fingerprint", None)
    monkeypatch.setattr(config, "_cache_build_in_progress", True)
    monkeypatch.setattr(config, "_get_config_path", lambda: config_path)
    monkeypatch.setattr(config, "_cfg_path", config_path)
    monkeypatch.setattr(config, "_cfg_mtime", config_path.stat().st_mtime)
    monkeypatch.setattr(config, "_get_models_cache_path", lambda: cache_path)
    monkeypatch.setattr(config, "_load_models_cache_from_disk", lambda: None)
    monkeypatch.setattr(
        config, "_load_stale_models_cache_from_disk", lambda: stale_catalog
    )

    holder_ready = threading.Event()
    release_holder = threading.Event()

    def hold_profile_env():
        with profiles._PROFILE_ENV_SCOPE_LOCK:
            holder_ready.set()
            release_holder.wait(2)

    def get(path):
        profiles.set_request_profile("member")
        try:
            handler = _Handler()
            routes.handle_get(handler, urlparse(f"http://example.test{path}"))
            return handler.status, handler.json_body()
        finally:
            profiles.clear_request_profile()

    holder = threading.Thread(target=hold_profile_env)
    holder.start()
    assert holder_ready.wait(2)
    paths = [
        "/api/sessions?show_cli_sessions=1&show_claude_code_sessions=1"
        "&show_cron_sessions=1&show_webhook_sessions=1",
        "/api/models",
        "/api/profiles",
        "/api/crons",
        "/api/crons/output?job_id=test",
        "/api/crons/history?job_id=test",
        "/api/crons/run?job_id=test&filename=missing.md",
        "/api/crons/recent?since=0",
        "/api/crons/recent?since=0",
        "/api/crons/recent?since=0",
        "/api/crons/recent?since=0",
        "/api/crons/status",
        "/api/crons/delivery-options",
        "/health",
    ]
    with ThreadPoolExecutor(max_workers=len(paths)) as executor:
        futures = [executor.submit(get, path) for path in paths]
        finished, unfinished = wait(futures, timeout=0.5)
        release_holder.set()
        responses = [future.result(timeout=2) for future in futures]
    holder.join(2)

    assert unfinished == set()
    assert len(finished) == len(paths)
    assert [status for status, _body in responses] == [
        200, 200, 200, 200, 200, 200, 404, 200, 200, 200, 200, 200, 200, 200
    ]
    assert all(
        response[1]["completions"][0]["job_id"] == "member-job"
        for response in responses[7:11]
    )
    assert os.environ["HERMES_HOME"] == str(process_home)
    assert holder.is_alive() is False


@pytest.mark.parametrize(
    "default_scope_name",
    [
        "profile_env_for_background_worker",
        "profile_env_for_active_request",
        "profile_env_for_active_request_readonly",
    ],
)
def test_default_environment_scope_does_not_wait_for_named_profile_scope(
    monkeypatch, tmp_path, default_scope_name
):
    member_home = tmp_path / "profiles" / "member"
    member_home.mkdir(parents=True)
    monkeypatch.setattr(
        profiles, "get_hermes_home_for_profile", lambda _profile: member_home
    )
    monkeypatch.setattr(profiles, "get_profile_runtime_env", lambda _home: {})
    monkeypatch.setattr(
        profiles, "filter_runtime_env_for_gateway_parity", lambda env: env
    )
    monkeypatch.setattr(profiles, "_profile_secret_env_names", lambda _home: set())
    monkeypatch.setattr(profiles, "get_active_profile_name", lambda: "default")

    named_entered = threading.Event()
    release_named = threading.Event()
    default_entered = threading.Event()

    def named_worker():
        with profiles.profile_env_for_background_worker(
            "member", "named holder"
        ):
            named_entered.set()
            assert release_named.wait(2)

    def default_worker():
        default_scope = getattr(profiles, default_scope_name)
        if default_scope_name == "profile_env_for_background_worker":
            context = default_scope("default", "default waiter")
        else:
            context = default_scope("default waiter")
        with context:
            default_entered.set()

    named = threading.Thread(target=named_worker)
    default = threading.Thread(target=default_worker)
    named.start()
    assert named_entered.wait(2)
    default.start()
    default_progressed_while_named_scope_active = default_entered.wait(0.2)
    release_named.set()
    named.join(2)
    default.join(2)
    assert default_progressed_while_named_scope_active is True
    assert named.is_alive() is False
    assert default.is_alive() is False


def test_default_title_scope_does_not_block_default_chat_scope():
    title_entered = threading.Event()
    release_title = threading.Event()
    chat_entered = threading.Event()

    def title_worker():
        with profiles.profile_env_for_background_worker(
            "default", "background title"
        ):
            title_entered.set()
            assert release_title.wait(2)

    def chat_worker():
        with profiles.profile_env_for_background_worker(
            "default", "chat admission"
        ):
            chat_entered.set()

    title = threading.Thread(target=title_worker)
    chat = threading.Thread(target=chat_worker)
    title.start()
    assert title_entered.wait(2)
    chat.start()
    chat_progressed_while_title_blocked = chat_entered.wait(0.2)
    release_title.set()
    title.join(2)
    chat.join(2)

    assert chat_progressed_while_title_blocked is True
    assert title.is_alive() is False
    assert chat.is_alive() is False


def test_default_worker_pins_root_home_while_cron_mutates_process_env(
    monkeypatch, tmp_path
):
    import api.config as config

    root_home = tmp_path / "root"
    cron_home = tmp_path / "profiles" / "cron"
    root_home.mkdir()
    cron_home.mkdir(parents=True)
    monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", root_home)
    monkeypatch.setitem(profiles._INITIAL_PROCESS_ENV, "OPENAI_API_KEY", "root-startup-key")
    monkeypatch.setenv("HERMES_HOME", str(cron_home))
    monkeypatch.setenv("OPENAI_API_KEY", "named-live-key")

    with profiles.profile_env_for_background_worker("default", "background title"):
        assert config._thread_local_env_value("HERMES_HOME") == str(root_home)
        assert config._thread_local_env_value("OPENAI_API_KEY") == "root-startup-key"

    assert os.environ["HERMES_HOME"] == str(cron_home)


def test_named_profile_secret_overlay_blanks_startup_root_credentials(
    monkeypatch, tmp_path
):
    profile_home = tmp_path / "profiles" / "member"
    profile_home.mkdir(parents=True)
    monkeypatch.setattr(
        profiles, "_profile_secret_env_names", lambda _home: {"OPENAI_API_KEY"}
    )
    monkeypatch.setitem(
        profiles._INITIAL_PROCESS_ENV, "OPENAI_API_KEY", "root-startup-key"
    )

    assert profiles._profile_secret_thread_env("member", profile_home)[
        "OPENAI_API_KEY"
    ] == ""


def test_isolated_profile_owns_its_startup_credentials(monkeypatch, tmp_path):
    profile_home = tmp_path / "profiles" / "member"
    profile_home.mkdir(parents=True)
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_HOME", str(profile_home))
    monkeypatch.setattr(profiles, "_is_isolated_profile_mode", lambda: True)
    monkeypatch.setattr(
        profiles, "_profile_secret_env_names", lambda _home: {"OPENAI_API_KEY"}
    )
    monkeypatch.setitem(
        profiles._INITIAL_PROCESS_ENV, "OPENAI_API_KEY", "deployment-key"
    )

    assert profiles._profile_secret_thread_env("member", profile_home)[
        "OPENAI_API_KEY"
    ] == "deployment-key"


def test_effective_model_override_uses_profile_thread_env(monkeypatch):
    import api.config as config

    monkeypatch.setenv("HERMES_MODEL", "root-model")
    config._set_thread_env(HERMES_MODEL="profile-model")
    try:
        assert config.get_effective_default_model({"model": {}}) == "profile-model"
    finally:
        config._clear_thread_env()


def test_root_profile_projects_startup_model_override(monkeypatch, tmp_path):
    monkeypatch.setattr(
        profiles, "_profile_secret_env_names", lambda _home: set()
    )
    monkeypatch.setitem(
        profiles._INITIAL_PROCESS_ENV, "HERMES_MODEL", "deployment-model"
    )

    assert profiles._profile_secret_thread_env("default", tmp_path)[
        "HERMES_MODEL"
    ] == "deployment-model"


def test_root_profile_projects_filtered_startup_config_environment(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(profiles, "_profile_secret_env_names", lambda _home: set())
    monkeypatch.setitem(
        profiles._INITIAL_PROCESS_ENV, "CUSTOM_BASE_URL", "https://root.example"
    )
    monkeypatch.setitem(profiles._INITIAL_PROCESS_ENV, "HOME", "/private/root")

    env = profiles._profile_secret_thread_env("default", tmp_path)

    assert env["CUSTOM_BASE_URL"] == "https://root.example"
    assert "HOME" not in env


def test_context_length_credentials_use_profile_thread_env(monkeypatch):
    import api.config as config
    import api.routes as routes

    monkeypatch.setenv("PROFILE_CONTEXT_KEY", "root-key")
    config._set_thread_env(PROFILE_CONTEXT_KEY="profile-key")
    try:
        entry = {"name": "Scoped", "key_env": "PROFILE_CONTEXT_KEY"}
        assert routes._custom_provider_api_key_for_context(
            entry, "custom:scoped"
        ) == "profile-key"
        assert routes._context_length_config_api_key_for_provider(
            "custom:scoped",
            {"providers": {"custom:scoped": entry}},
        ) == "profile-key"
    finally:
        config._clear_thread_env()


def test_ordinary_named_profile_removal_keeps_root_startup_key(
    monkeypatch, tmp_path
):
    root_home = tmp_path / "root"
    named_home = root_home / "profiles" / "member"
    named_home.mkdir(parents=True)
    monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", root_home)
    monkeypatch.setattr(profiles, "_INITIAL_HERMES_HOME", str(named_home))
    monkeypatch.setattr(profiles, "_is_isolated_profile_mode", lambda: False)
    monkeypatch.setitem(
        profiles._INITIAL_PROCESS_ENV, "OPENAI_API_KEY", "root-deployment-key"
    )

    profiles.retire_startup_env_keys_for_home(named_home, ("OPENAI_API_KEY",))

    assert profiles._INITIAL_PROCESS_ENV["OPENAI_API_KEY"] == "root-deployment-key"


def test_root_stream_scope_cannot_fall_through_to_live_named_prefill(
    monkeypatch, tmp_path
):
    import api.config as config

    monkeypatch.delenv("HERMES_WEBUI_PREFILL_MESSAGES_SCRIPT", raising=False)
    monkeypatch.delitem(
        profiles._INITIAL_PROCESS_ENV,
        "HERMES_WEBUI_PREFILL_MESSAGES_SCRIPT",
        raising=False,
    )
    env = profiles._profile_secret_thread_env("default", tmp_path)
    monkeypatch.setenv(
        "HERMES_WEBUI_PREFILL_MESSAGES_SCRIPT", "named-profile-script"
    )
    config._set_thread_env(**env)
    config._thread_ctx.block_process_env_fallback = True
    try:
        assert config._thread_local_env_value(
            "HERMES_WEBUI_PREFILL_MESSAGES_SCRIPT"
        ) == ""
    finally:
        config._thread_ctx.block_process_env_fallback = False
        config._clear_thread_env()


def test_codex_model_cache_uses_profile_thread_home(monkeypatch, tmp_path):
    import api.config as config

    root_home = tmp_path / "root-codex"
    profile_home = tmp_path / "profile-codex"
    root_home.mkdir()
    profile_home.mkdir()
    (root_home / "models_cache.json").write_text(
        '{"models":[{"slug":"root-model"}]}', encoding="utf-8"
    )
    (profile_home / "models_cache.json").write_text(
        '{"models":[{"slug":"profile-model"}]}', encoding="utf-8"
    )
    monkeypatch.setenv("CODEX_HOME", str(root_home))
    config._set_thread_env(CODEX_HOME=str(profile_home))
    try:
        assert config._read_visible_codex_cache_model_ids() == ["profile-model"]
        fingerprint = config._models_cache_source_fingerprint()
    finally:
        config._clear_thread_env()

    assert fingerprint["catalog"]["codex_models_cache"]["path"] == str(
        profile_home / "models_cache.json"
    )


def test_default_readonly_request_pins_root_home(monkeypatch, tmp_path):
    import api.config as config

    root_home = tmp_path / "root"
    cron_home = tmp_path / "profiles" / "cron"
    root_home.mkdir()
    cron_home.mkdir(parents=True)
    monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", root_home)
    monkeypatch.setattr(profiles, "get_active_profile_name", lambda: "default")
    monkeypatch.setenv("HERMES_HOME", str(cron_home))

    with profiles.profile_env_for_active_request_readonly("providers"):
        assert config._thread_local_env_value("HERMES_HOME") == str(root_home)


def test_default_detached_worker_pins_root_home(monkeypatch, tmp_path):
    import api.config as config

    root_home = tmp_path / "root"
    cron_home = tmp_path / "profiles" / "cron"
    root_home.mkdir()
    cron_home.mkdir(parents=True)
    monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", root_home)
    monkeypatch.setenv("HERMES_HOME", str(cron_home))

    with profiles.profile_scope_for_detached_worker("", "models rebuild"):
        assert profiles.get_active_profile_name() == "default"
        assert config._thread_local_env_value("HERMES_HOME") == str(root_home)


def test_explicit_profile_cli_caches_do_not_cross_under_concurrency(monkeypatch, tmp_path):
    owner_home = tmp_path / "owner-default"
    member_home = tmp_path / "profiles" / "member"
    _make_state_db(owner_home, "owner-session")
    _make_state_db(member_home, "member-session")
    _isolate_cli_projection(monkeypatch, tmp_path)

    homes = {"default": owner_home, "member": member_home}
    def active_profile():
        profile = getattr(profiles._tls, "profile", None)
        if profile:
            return profile
        raise AssertionError("explicit profile was ignored")

    monkeypatch.setattr(profiles, "get_active_profile_name", active_profile)
    monkeypatch.setattr(profiles, "get_hermes_home_for_profile", homes.__getitem__)

    loads = []
    active_loads = 0
    max_active_loads = 0
    load_lock = threading.Lock()
    original_loader = models._load_cli_sessions_uncached

    def recording_loader(home, db_path, profile, *args, **kwargs):
        nonlocal active_loads, max_active_loads
        with load_lock:
            loads.append((Path(home), Path(db_path), profile))
            active_loads += 1
            max_active_loads = max(max_active_loads, active_loads)
        try:
            time.sleep(0.01)
            return original_loader(home, db_path, profile, *args, **kwargs)
        finally:
            with load_lock:
                active_loads -= 1

    monkeypatch.setattr(models, "_load_cli_sessions_uncached", recording_loader)

    def load(profile):
        return {
            row["session_id"]
            for row in models.get_cli_sessions(
                profile=profile,
                include_claude_code=False,
            )
        }

    requested = ["default", "member"] * 8
    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(load, requested))

    for profile, session_ids in zip(requested, results, strict=True):
        prefix = "member" if profile == "member" else "owner"
        assert session_ids == {f"{prefix}-session-0", f"{prefix}-session-1"}
    assert max_active_loads >= 2

    expected_loads = {
        (owner_home, owner_home / "state.db", "default"),
        (member_home, member_home / "state.db", "member"),
    }
    assert set(loads) == expected_loads

    cached_load_count = len(loads)
    assert load("default") == {"owner-session-0", "owner-session-1"}
    assert load("member") == {"member-session-0", "member-session-1"}
    assert len(loads) == cached_load_count

    monkeypatch.setattr(models, "_CLI_SESSIONS_CACHE_TTL_SECONDS", 0.0)
    models.clear_cli_sessions_cache()
    assert load("default") == {"owner-session-0", "owner-session-1"}
    assert load("member") == {"member-session-0", "member-session-1"}


def test_concurrent_cli_projection_uses_profile_owned_workspace_snapshot(
    monkeypatch, tmp_path
):
    import api.config as config
    import api.workspace as workspace

    homes = {
        "alpha": tmp_path / "profiles" / "alpha",
        "beta": tmp_path / "profiles" / "beta",
    }
    workspaces = {
        name: tmp_path / f"{name}-workspace" for name in homes
    }
    for name, home in homes.items():
        _make_state_db(home, f"{name}-session")
        workspaces[name].mkdir()
        (home / "config.yaml").write_text(
            f"workspace: {workspaces[name]}\n", encoding="utf-8"
        )
    _isolate_cli_projection(monkeypatch, tmp_path)
    monkeypatch.setattr(models, "get_last_workspace", workspace.get_last_workspace)
    monkeypatch.setattr(profiles, "get_hermes_home_for_profile", homes.__getitem__)
    monkeypatch.setattr(workspace, "_GLOBAL_LW_FILE", tmp_path / "missing-global")
    monkeypatch.setattr(models, "_CLI_SESSIONS_CACHE_TTL_SECONDS", 0.0)

    shared_config = {}
    readers = threading.Barrier(2)

    def racing_get_config():
        name = profiles.get_active_profile_name()
        shared_config.clear()
        shared_config["workspace"] = str(workspaces[name])
        readers.wait(2)
        return shared_config

    monkeypatch.setattr(config, "get_config", racing_get_config)

    def load(name):
        return models.get_cli_sessions(profile=name, include_claude_code=False)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = dict(
            zip(homes, executor.map(load, homes), strict=True)
        )

    for name, rows in results.items():
        assert {row["workspace"] for row in rows} == {str(workspaces[name])}
