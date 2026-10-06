"""TAL-548: ``usage.pool`` reads the Agent's credential pool per account, and ``usage.balance`` reads the key-based
balance endpoints with stubbed HTTP, from a pool account's key or the server-resolved one."""

from __future__ import annotations

import dataclasses
import io
import json
import pathlib
import sys
import time
import types
import urllib.error

from conftest import SidecarProcess, requires_agent
from talaria_sidecar import SIDECAR_RPC_VERSION
from talaria_sidecar.methods import usage


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _stub_http(monkeypatch, body=None, *, status: int | None = None) -> list:
    """Answer every request with ``body`` (JSON, or raw bytes), or an HTTP error ``status``; returns the requests made."""
    requests = []

    def urlopen(request, timeout=None):
        requests.append(request)
        if status is not None:
            raise urllib.error.HTTPError(request.full_url, status, "error", {}, None)
        return _Response(body if isinstance(body, bytes) else json.dumps(body).encode())

    monkeypatch.setattr(usage.urllib.request, "urlopen", urlopen)
    return requests


def _read(provider, *, credential_id=None, api_key="sk-configured"):
    return usage.balance(provider, credential_id=credential_id, api_key=api_key)


def test_deepseek_balance_keeps_cny_and_usd_rows(monkeypatch):
    requests = _stub_http(monkeypatch, {"is_available": True, "balance_infos": [
        {"currency": "USD", "total_balance": "12.50", "granted_balance": "2.5", "topped_up_balance": "10"},
        {"currency": "cny", "total_balance": 80, "granted_balance": None, "topped_up_balance": 80},
        {"currency": "EUR", "total_balance": "5"},
        {"currency": "USD", "total_balance": "NaN"},
    ]})
    result = _read("deepseek")
    assert result["status"] == "ok" and result["is_available"] is True
    assert result["balances"] == [{"currency": "USD", "total": 12.5, "granted": 2.5, "topped_up": 10}, {"currency": "CNY", "total": 80, "granted": None, "topped_up": 80}]
    assert requests[0].full_url == "https://api.deepseek.com/user/balance"
    assert requests[0].get_header("Authorization") == "Bearer sk-configured"


def test_deepseek_without_availability_or_balances_is_unavailable(monkeypatch):
    _stub_http(monkeypatch, {"balance_infos": [{"currency": "USD", "total_balance": "1"}]})
    assert _read("deepseek")["status"] == "unavailable"
    _stub_http(monkeypatch, {"is_available": False, "balance_infos": []})
    assert _read("deepseek")["status"] == "unavailable"


def test_opencode_go_reads_all_three_windows(monkeypatch):
    window = lambda percent, status="ok": {"status": status, "percent": percent, "resetsAt": "2026-10-06T05:00:00Z"}  # noqa: E731
    requests = _stub_http(monkeypatch, {"usage": {"rolling": window(40), "weekly": window("10"), "monthly": window(100, "rate-limited")}})
    result = _read("opencode-go")
    assert result["status"] == "ok"
    assert result["windows"] == [
        {"key": "rolling", "used_percent": 40, "reset_at": "2026-10-06T05:00:00Z", "rate_limited": False},
        {"key": "weekly", "used_percent": 10, "reset_at": "2026-10-06T05:00:00Z", "rate_limited": False},
        {"key": "monthly", "used_percent": 100, "reset_at": "2026-10-06T05:00:00Z", "rate_limited": True},
    ]
    assert requests[0].full_url == "https://opencode.ai/zen/go/v1/usage"
    # A missing window, an out-of-range percent, or an unparseable reset rejects the whole response.
    for usage_payload in ({"rolling": window(1), "weekly": window(1)}, {"rolling": window(101), "weekly": window(1), "monthly": window(1)},
                          {"rolling": {**window(1), "resetsAt": "soon"}, "weekly": window(1), "monthly": window(1)}):
        _stub_http(monkeypatch, {"usage": usage_payload})
        assert _read("opencode-go")["status"] == "unavailable"


def test_http_errors_carry_the_status_and_failures_read_as_unavailable(monkeypatch):
    _stub_http(monkeypatch, status=401)
    result = _read("deepseek")
    assert (result["status"], result["http_status"]) == ("http_error", 401)
    _stub_http(monkeypatch, b"not json")
    assert _read("openrouter")["status"] == "unavailable"
    _stub_http(monkeypatch, b"{" + b" " * (256 * 1024) + b"}")
    assert _read("openrouter")["status"] == "unavailable"


def test_no_key_makes_no_request(monkeypatch):
    requests = _stub_http(monkeypatch, {})
    assert _read("deepseek", api_key=None)["status"] == "no_key"
    assert requests == []


def test_a_pool_account_reads_with_its_own_key(monkeypatch):
    entries = [types.SimpleNamespace(id="or-1", label="Work", runtime_api_key="sk-work"), types.SimpleNamespace(id="or-2", label="Home", runtime_api_key="sk-home")]
    monkeypatch.setattr(usage, "_pool", lambda provider: (None, entries))
    requests = _stub_http(monkeypatch, {"data": {"usage": 3, "limit": "100", "limit_remaining": None, "label": " synthetic "}})
    result = _read("openrouter", credential_id="or-2", api_key="sk-work")
    assert result == {**result, "status": "ok", "quota": {"limit_remaining": None, "usage": 3, "limit": 100}, "label": "synthetic"}
    assert requests[-1].get_header("Authorization") == "Bearer sk-home"
    # An account the pool no longer has has no key, whatever the server configured.
    assert _read("openrouter", credential_id="or-gone")["status"] == "no_key"


def test_pool_rows_say_which_account_holds_the_configured_key(monkeypatch):
    entries = [types.SimpleNamespace(id="or-1", label="Work", runtime_api_key="sk-work"), types.SimpleNamespace(id="or-2", label="Home", runtime_api_key="sk-home")]
    monkeypatch.setattr(usage, "_pool", lambda provider: (None, entries))
    rows = usage.pool("openrouter", api_key="sk-home")
    assert [(r["credential_id"], r["matches_api_key"]) for r in rows] == [("or-1", False), ("or-2", True)]
    assert not any(r["matches_api_key"] for r in usage.pool("openrouter"))
    assert "sk-" not in json.dumps(rows)


def test_each_anthropic_pool_account_reads_its_own_limits(monkeypatch):
    """The Agent's Anthropic fetcher reads only the ambient token; a pool account's usage is read with its own."""
    entries = [types.SimpleNamespace(id="work", label="work@example.test", runtime_api_key="sk-ant-oat-work"),
               types.SimpleNamespace(id="home", label="home@example.test", runtime_api_key="sk-ant-oat-home")]
    monkeypatch.setattr(usage, "_pool", lambda provider: (None, entries))
    used = {"Bearer sk-ant-oat-work": 0.25, "Bearer sk-ant-oat-home": 0.9}

    @dataclasses.dataclass(frozen=True)
    class Snapshot:
        provider: str
        source: str
        windows: tuple
        details: tuple
        unavailable_reason: str | None = None

        @property
        def available(self):
            return bool(self.windows) and not self.unavailable_reason

    agent_usage = types.ModuleType("agent.account_usage")
    agent_usage.fetch_account_usage = lambda provider, base_url=None, api_key=None: Snapshot(provider, "ambient", ({"label": "Current session", "used_percent": 1.0},), ())
    agent_usage._is_oauth_token = lambda token: token.startswith("sk-ant-oat")
    agent_usage._is_num = lambda value: isinstance(value, (int, float))
    agent_usage._get_json = lambda url, headers, *, timeout: {"five_hour": {"utilization": used[headers["Authorization"]]}}
    agent_usage._usage_windows = lambda payload, mapping, used_key, reset_key, *, fraction: [
        {"label": label, "used_percent": payload[key][used_key] * 100} for key, label in mapping if key in payload]
    agent_usage._snapshot = lambda provider, source, windows, details, **kw: Snapshot(provider, source, tuple(windows), tuple(details), **kw)
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.account_usage", agent_usage)

    work = usage.account("anthropic", base_url=None, api_key=None, credential_id="work")
    home = usage.account("anthropic", base_url=None, api_key=None, credential_id="home")
    assert [w["used_percent"] for w in work["windows"]] == [25.0]
    assert [w["used_percent"] for w in home["windows"]] == [90.0]
    assert work["available"] is True and work["source"] == "oauth_usage_api"
    # Without a pool account the Agent's own fetcher still answers.
    assert usage.account("anthropic", base_url=None, api_key=None)["source"] == "ambient"


@requires_agent
def test_pool_lists_each_account_with_its_local_state(hermes_home: pathlib.Path):
    now = time.time()
    entry = lambda credential_id, label, **extra: {"id": credential_id, "label": label, "auth_type": "api_key", "priority": 0, "source": "manual", "access_token": f"sk-synthetic-{credential_id}", **extra}  # noqa: E731
    (hermes_home / "auth.json").write_text(json.dumps({"version": 1, "credential_pool": {"zai": [
        entry("zai-work", "Work"),
        entry("zai-home", "  Home\n  laptop ", last_status="exhausted", last_status_at=now, last_error_code=429),
        entry("zai-old", "Old", last_status="dead"),
    ], "copilot": [entry("gh", "gh auth token", source="gh_cli")]}}))
    proc = SidecarProcess(hermes_home)
    try:
        assert proc.result("runtime.handshake", {"rpc_version": SIDECAR_RPC_VERSION})["compatible"]
        rows = proc.result("usage.pool", {"profile_home": str(hermes_home), "provider": "zai"})["entries"]
        providers = proc.result("usage.pool_providers", {"profile_home": str(hermes_home)})["providers"]
    finally:
        proc.close()
    assert [(r["credential_id"], r["label"], r["status"]) for r in rows] == [("zai-work", "Work", "available"), ("zai-home", "Home laptop", "exhausted"), ("zai-old", "Old", "dead")]
    assert rows[1]["retry_after"] and rows[1]["unavailable_reason"].startswith("Credential pool marked this credential exhausted after provider status 429; retry after ")
    assert "sk-synthetic" not in json.dumps(rows)
    # A seeded `gh` CLI token is ambient, not an account the user added.
    assert providers == ["zai"]
