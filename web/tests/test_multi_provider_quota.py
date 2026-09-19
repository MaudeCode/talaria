"""Contract coverage for multi-provider/account quota sources."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

import pytest

import api.providers as providers
import api.routes as routes


def _quota_result(provider: str, label: str, used: int) -> dict:
    return {
        "ok": True,
        "provider": provider,
        "display_name": provider.title(),
        "supported": True,
        "status": "available",
        "label": "Account limits",
        "quota": None,
        "account_limits": {
            "plan": "Pro",
            "windows": [{
                "label": "Session",
                "used_percent": used,
                "remaining_percent": 100 - used,
                "reset_at": "2030-03-17T17:30:00Z",
                "detail": None,
            }],
            "details": [],
            "available": True,
            "unavailable_reason": None,
            "fetched_at": "2030-03-17T12:30:00Z",
        },
        "message": "Quota loaded.",
    }


def test_quota_source_identity_survives_pool_reordering_and_label_changes(monkeypatch):
    entries = [
        {"id": "account-a", "label": "Primary", "access_token": "secret-a"},
        {"id": "account-b", "label": "Backup", "access_token": "secret-b"},
    ]
    monkeypatch.setattr(providers, "_active_provider_id", lambda: "openai-codex")
    monkeypatch.setattr(
        providers,
        "get_providers",
        lambda: {
            "active_provider": "openai-codex",
            "providers": [{
                "id": "openai-codex",
                "display_name": "Codex",
                "has_key": True,
            }],
        },
    )
    monkeypatch.setattr(providers, "_pool_entry_payloads", lambda _provider: list(entries))
    monkeypatch.setattr(
        providers,
        "get_provider_quota",
        lambda provider_id, *, refresh=False, credential_id=None, _include_internal=False: _quota_result(
            provider_id,
            credential_id,
            10 if credential_id == "account-a" else 20,
        ),
    )
    monkeypatch.setattr("api.profiles.get_active_profile_name", lambda: "work")

    first = providers.get_provider_quotas()
    first_ids = {source["account_label"]: source["source_id"] for source in first["sources"]}

    entries[:] = [
        {"id": "account-b", "label": "Backup renamed", "access_token": "rotated-b"},
        {"id": "account-a", "label": "Primary renamed", "access_token": "rotated-a"},
    ]
    second = providers.get_provider_quotas()
    second_ids = {source["account_label"]: source["source_id"] for source in second["sources"]}

    assert first_ids["Primary"] == second_ids["Primary renamed"]
    assert first_ids["Backup"] == second_ids["Backup renamed"]
    serialized = json.dumps(second)
    assert "account-a" not in serialized
    assert "account-b" not in serialized
    assert "secret" not in serialized
    assert "rotated" not in serialized


def test_quota_source_identity_is_scoped_to_server_instance(monkeypatch):
    monkeypatch.setattr(providers, "_quota_server_scope_id", lambda: "server-a")
    server_a = providers._quota_source_id("default", "openai-codex", "account-a")
    monkeypatch.setattr(providers, "_quota_server_scope_id", lambda: "server-b")
    server_b = providers._quota_source_id("default", "openai-codex", "account-a")

    assert server_a != server_b
    assert "server-a" not in server_a
    assert "server-b" not in server_b


def test_quota_source_identity_is_scoped_to_profile_without_exposing_profile(monkeypatch):
    monkeypatch.setattr(providers, "_quota_server_scope_id", lambda: "server-a")

    default_scope = providers._quota_profile_scope_id("default")
    work_scope = providers._quota_profile_scope_id("work")
    default_source = providers._quota_source_id("default", "openai-codex", "account-a")
    work_source = providers._quota_source_id("work", "openai-codex", "account-a")

    assert default_scope != work_scope
    assert default_source != work_source
    assert "default" not in default_scope + default_source
    assert "work" not in work_scope + work_source


def test_quota_server_scope_persists_across_process_cache_reset(monkeypatch, tmp_path):
    import api.config as config

    monkeypatch.setattr(config, "STATE_DIR", tmp_path)
    providers._quota_scope_id_cache = None
    try:
        first = providers._quota_server_scope_id()
        providers._quota_scope_id_cache = None
        second = providers._quota_server_scope_id()
    finally:
        providers._quota_scope_id_cache = None

    assert first == second
    assert len(first) == 32
    assert (tmp_path / ".quota_scope_id").read_text(encoding="utf-8").strip() == first


def test_quota_sources_include_multiple_provider_types_and_duplicate_accounts(monkeypatch):
    monkeypatch.setattr(
        providers,
        "get_providers",
        lambda: {
            "active_provider": "openai-codex",
            "providers": [
                {"id": "openai-codex", "display_name": "Codex", "has_key": True},
                {"id": "openrouter", "display_name": "OpenRouter", "has_key": True},
                {"id": "unused", "display_name": "Unused", "has_key": False},
            ],
        },
    )
    monkeypatch.setattr(
        providers,
        "_pool_entry_payloads",
        lambda provider: (
            [{"id": "codex-one", "label": "Work"}, {"id": "codex-two", "label": "Personal"}]
            if provider == "openai-codex"
            else []
        ),
    )
    monkeypatch.setattr(
        providers,
        "get_provider_quota",
        lambda provider_id, *, refresh=False, credential_id=None, _include_internal=False: _quota_result(
            provider_id,
            credential_id or provider_id,
            25,
        ),
    )
    monkeypatch.setattr("api.profiles.get_active_profile_name", lambda: "default")

    result = providers.get_provider_quotas()

    assert [(row["provider_id"], row["account_label"]) for row in result["sources"]] == [
        ("openai-codex", "Work"),
        ("openai-codex", "Personal"),
        ("openrouter", "OpenRouter"),
    ]
    assert [row["is_active_provider"] for row in result["sources"]] == [True, True, False]


def test_quota_source_set_does_not_follow_active_provider(monkeypatch):
    active_provider = "unconfigured"

    monkeypatch.setattr(
        providers,
        "get_providers",
        lambda: {
            "active_provider": active_provider,
            "providers": [
                {"id": "unconfigured", "display_name": "Unconfigured", "has_key": False},
                {"id": "custom-work", "display_name": "Custom Work", "has_key": False, "is_custom": True},
                {"id": "openrouter", "display_name": "OpenRouter", "has_key": True},
            ],
        },
    )
    monkeypatch.setattr(providers, "_pool_entry_payloads", lambda _provider: [])
    monkeypatch.setattr(
        providers,
        "get_provider_quota",
        lambda provider_id, **_kwargs: _quota_result(provider_id, provider_id, 25),
    )
    monkeypatch.setattr("api.profiles.get_active_profile_name", lambda: "default")

    first = providers.get_provider_quotas()
    first_ids = {source["provider_id"]: source["source_id"] for source in first["sources"]}
    active_provider = "openrouter"
    second = providers.get_provider_quotas()
    second_ids = {source["provider_id"]: source["source_id"] for source in second["sources"]}

    assert first_ids == second_ids
    assert set(first_ids) == {"custom-work", "openrouter"}
    assert [source["is_active_provider"] for source in first["sources"]] == [False, False]
    assert [source["is_active_provider"] for source in second["sources"]] == [False, True]


def test_targeted_quota_refresh_only_probes_selected_source(monkeypatch):
    calls = []
    monkeypatch.setattr(
        providers,
        "get_providers",
        lambda: {
            "active_provider": "openai-codex",
            "providers": [{"id": "openai-codex", "display_name": "Codex", "has_key": True}],
        },
    )
    monkeypatch.setattr(
        providers,
        "_pool_entry_payloads",
        lambda _provider: [
            {"id": "codex-one", "label": "Work"},
            {"id": "codex-two", "label": "Personal"},
        ],
    )

    def quota(provider_id, *, refresh=False, credential_id=None):
        calls.append((provider_id, refresh, credential_id))
        return _quota_result(provider_id, credential_id, 25)

    monkeypatch.setattr(providers, "get_provider_quota", quota)
    monkeypatch.setattr("api.profiles.get_active_profile_name", lambda: "default")
    selected = providers._quota_source_id("default", "openai-codex", "codex-two")

    result = providers.get_provider_quotas(source_id=selected, refresh=True)

    assert calls == [("openai-codex", True, "codex-two")]
    assert [source["account_label"] for source in result["sources"]] == ["Personal"]
    assert result["missing_source"] is False


def test_removed_quota_source_is_reported_without_substitution(monkeypatch):
    monkeypatch.setattr(
        providers,
        "get_providers",
        lambda: {
            "active_provider": "openai-codex",
            "providers": [{"id": "openai-codex", "display_name": "Codex", "has_key": True}],
        },
    )
    monkeypatch.setattr(providers, "_pool_entry_payloads", lambda _provider: [])
    monkeypatch.setattr(
        providers,
        "get_provider_quota",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not substitute another source")),
    )
    monkeypatch.setattr("api.profiles.get_active_profile_name", lambda: "default")

    result = providers.get_provider_quotas(source_id="qsrc_removed", refresh=True)

    assert result["sources"] == []
    assert result["requested_source_id"] == "qsrc_removed"
    assert result["missing_source"] is True


def test_targeted_provider_quota_passes_credential_without_rotating_pool(monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr(providers, "_get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(providers, "_get_provider_api_key", lambda provider, credential_id=None: "safe-key")
    monkeypatch.setattr(
        providers,
        "_agent_fetch_account_usage_for_home",
        lambda provider, home, api_key=None, credential_id=None: seen.append(
            (provider, home, api_key, credential_id)
        ) or SimpleNamespace(
            provider=provider,
            source="usage_api",
            title="Account limits",
            plan="Pro",
            windows=(),
            details=(),
            available=True,
            unavailable_reason=None,
            fetched_at=None,
        ),
    )

    providers.get_provider_quota("openai-codex", refresh=True, credential_id="codex-two")

    assert seen == [("openai-codex", tmp_path, "safe-key", "codex-two")]


def test_full_quota_fetch_batches_codex_pool_once_and_preserves_source_order(monkeypatch):
    calls = []
    monkeypatch.setattr(
        providers,
        "get_providers",
        lambda: {
            "active_provider": "openai-codex",
            "providers": [{"id": "openai-codex", "display_name": "Codex", "has_key": True}],
        },
    )
    monkeypatch.setattr(
        providers,
        "_pool_entry_payloads",
        lambda _provider: [
            {"id": "codex-one", "label": "Work"},
            {"id": "codex-two", "label": "Personal"},
        ],
    )

    def quota(provider_id, *, refresh=False, credential_id=None, _include_internal=False):
        calls.append((provider_id, refresh, credential_id))
        assert _include_internal is True
        result = _quota_result(provider_id, "pool", 10)
        work = {"status": "available", "plan": "Work", "windows": [{"used_percent": 10}]}
        personal = {"status": "available", "plan": "Personal", "windows": [{"used_percent": 20}]}
        result["account_limits"]["pool"] = {
            "credentials": [
                personal,
                work,
            ]
        }
        result["_credential_rows_by_id"] = {
            "codex-one": work,
            "codex-two": personal,
        }
        return result

    monkeypatch.setattr(providers, "get_provider_quota", quota)
    monkeypatch.setattr("api.profiles.get_active_profile_name", lambda: "default")

    result = providers.get_provider_quotas()

    assert calls == [("openai-codex", False, None)]
    assert [(source["account_label"], source["plan"]) for source in result["sources"]] == [
        ("Work", "Work"),
        ("Personal", "Personal"),
    ]


def test_selected_quota_source_preserves_meaningful_empty_credential_fields():
    descriptor = {
        "source_id": "qsrc_exhausted",
        "provider_id": "openai-codex",
        "provider_label": "Codex",
        "account_label": "Exhausted",
        "credential_id": "codex-exhausted",
    }
    selected = {
        "status": "exhausted",
        "plan": None,
        "windows": [],
        "details": [],
        "unavailable_reason": "Quota exhausted.",
        "retry_after": "2030-03-17T18:46:40Z",
        "fetched_at": None,
    }
    quota_status = _quota_result("openai-codex", "aggregate", 10)
    quota_status["_credential_rows_by_id"] = {"codex-exhausted": selected}

    payload = providers._quota_source_payload(
        descriptor,
        quota_status,
        active_provider="openai-codex",
    )

    assert payload["status"] == "exhausted"
    assert payload["plan"] is None
    assert payload["windows"] == []
    assert payload["details"] == []
    assert payload["unavailable_reason"] == "Quota exhausted."


def test_quota_source_payload_preserves_normalized_balances():
    descriptor = {
        "source_id": "qsrc_deepseek",
        "provider_id": "deepseek",
        "provider_label": "DeepSeek",
        "account_label": "DeepSeek",
        "credential_id": None,
    }
    quota_status = _quota_result("deepseek", "DeepSeek", 10)
    quota_status["balances"] = [{"currency": "USD", "total": 12.5}]

    payload = providers._quota_source_payload(descriptor, quota_status, active_provider="custom")

    assert payload["balances"] == [{"currency": "USD", "total": 12.5}]


def test_full_quota_fetch_marks_credential_removed_during_batch(monkeypatch):
    monkeypatch.setattr(
        providers,
        "get_providers",
        lambda: {
            "active_provider": "openai-codex",
            "providers": [{"id": "openai-codex", "display_name": "Codex", "has_key": True}],
        },
    )
    monkeypatch.setattr(
        providers,
        "_pool_entry_payloads",
        lambda _provider: [
            {"id": "codex-one", "label": "Work"},
            {"id": "codex-two", "label": "Removed during refresh"},
        ],
    )

    def quota(provider_id, *, refresh=False, credential_id=None, _include_internal=False):
        assert _include_internal is True
        result = _quota_result(provider_id, "remaining pool", 10)
        work = {"status": "available", "plan": "Work", "windows": [{"used_percent": 10}]}
        result["account_limits"]["pool"] = {"credentials": [work]}
        result["_credential_rows_by_id"] = {"codex-one": work}
        return result

    monkeypatch.setattr(providers, "get_provider_quota", quota)
    monkeypatch.setattr("api.profiles.get_active_profile_name", lambda: "default")

    result = providers.get_provider_quotas(refresh=True)

    assert [(source["account_label"], source["status"], source["plan"]) for source in result["sources"]] == [
        ("Work", "available", "Work"),
        ("Removed during refresh", "removed", None),
    ]
    assert result["sources"][1]["windows"] == []
    assert result["sources"][1]["details"] == []


def test_public_account_usage_serialization_strips_internal_credential_identity():
    snapshot = SimpleNamespace(
        provider="openai-codex",
        source="usage_api_pool",
        title="Account limits",
        plan=None,
        windows=(),
        details=(),
        available=True,
        unavailable_reason=None,
        fetched_at=None,
        pool={
            "credentials": [
                {
                    "_credential_id": "private-account-id",
                    "label": "Work",
                    "status": "available",
                    "windows": [],
                }
            ]
        },
    )

    payload = providers._serialize_account_usage_snapshot(snapshot)

    assert payload["pool"]["credentials"] == [
        {"label": "Work", "status": "available", "windows": []}
    ]
    assert "private-account-id" not in json.dumps(payload)


def test_multi_provider_quota_route_dispatches_query_in_profile_scope(monkeypatch):
    events = []
    payload = {"version": 1, "sources": []}
    handler = SimpleNamespace()

    @contextmanager
    def profile_scope(purpose, logger_override=None):
        events.append(("scope-enter", purpose, logger_override))
        yield
        events.append(("scope-exit", purpose, logger_override))

    def quotas(*, source_id=None, refresh=False):
        events.append(("quotas", source_id, refresh))
        return payload

    def respond(received_handler, received_payload, status=200, extra_headers=None):
        events.append(("json", received_handler, received_payload, status, extra_headers))
        return True

    monkeypatch.setattr("api.profiles.profile_env_for_active_request_readonly", profile_scope)
    monkeypatch.setattr(routes, "get_provider_quotas", quotas)
    monkeypatch.setattr(routes, "j", respond)
    monkeypatch.setattr(routes, "_handle_extension_sidecar_proxy", lambda *_args: False)

    handled = routes.handle_get(
        handler,
        urlparse("/api/provider/quotas?source=qsrc_widget&refresh=yes"),
    )

    assert handled is True
    assert events == [
        ("scope-enter", "/api/provider/quotas", routes.logger),
        ("quotas", "qsrc_widget", True),
        ("json", handler, payload, 200, None),
        ("scope-exit", "/api/provider/quotas", routes.logger),
    ]


def test_default_profile_multi_provider_quota_route_does_not_deadlock(tmp_path):
    script = textwrap.dedent(
        """
        from types import SimpleNamespace
        from urllib.parse import urlparse

        import api.profiles as profiles
        import api.providers as providers
        import api.routes as routes

        profiles.get_active_profile_name = lambda: "default"
        providers.get_providers = lambda: {
            "active_provider": "alpha",
            "providers": [
                {"id": "alpha", "display_name": "Alpha", "has_key": True},
                {"id": "beta", "display_name": "Beta", "has_key": True},
            ],
        }
        providers._quota_source_descriptors = lambda profile, provider: [{
            "source_id": f"source-{provider['id']}",
            "provider_id": provider["id"],
            "provider_label": provider["display_name"],
            "account_label": provider["display_name"],
            "credential_id": None,
        }]
        providers._quota_profile_scope_id = lambda profile: "scope-default"
        providers.get_provider_quota = lambda provider_id, **kwargs: {
            "supported": True,
            "status": "available",
            "account_limits": {},
        }
        routes.get_provider_quotas = providers.get_provider_quotas
        routes._handle_extension_sidecar_proxy = lambda *_args: False
        routes.j = lambda handler, payload, status=200, extra_headers=None: payload

        payload = routes.handle_get(
            SimpleNamespace(), urlparse("/api/provider/quotas")
        )
        assert payload["version"] == 1
        assert payload["profile_id"] == "default"
        assert [source["provider_id"] for source in payload["sources"]] == [
            "alpha", "beta"
        ]
        """
    )
    env = os.environ.copy()
    env["HERMES_HOME"] = str(tmp_path / ".hermes")
    env["HERMES_WEBUI_STATE_DIR"] = str(tmp_path / "webui")
    try:
        subprocess.run(
            [sys.executable, "-c", script],
            cwd=str(Path(__file__).resolve().parent.parent),
            env=env,
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except subprocess.TimeoutExpired:
        pytest.fail("default-profile quota route deadlocked in nested worker scopes")
