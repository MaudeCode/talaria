"""TAL-548: ``usage.pool`` reads the Agent's credential pool per account, and ``usage.balance`` reads the key-based
balance endpoints with stubbed HTTP, from a pool account's key or the server-resolved one."""

from __future__ import annotations

import dataclasses
import io
import json
import pathlib
import subprocess
import sys
import time
import types
import urllib.error

import pytest
from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess, isolated_env, requires_agent
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
    """An Agent whose fetcher has no ``read_only`` reads only the ambient Anthropic token; a pool account's usage is read
    with its own."""
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


# Runs on the Agent interpreter: the pinned Agent's real fetchers over a stubbed HTTP transport, a pool whose refresh
# path records instead of rotating, and stand-in pool entries.
READ_ONLY_PROBE = """
import json, sys, types
sys.path.append(sys.argv[1])
import httpx
from agent import account_usage_cache, credential_pool
from talaria_sidecar.methods import usage

requests, refreshes, mirrored = [], [], []

def answer(request):
    requests.append((request.url.host, request.headers["Authorization"]))
    if request.url.host == "chatgpt.com":
        return httpx.Response(401, json={"detail": "unauthorized"})
    return httpx.Response(200, json={"five_hour": {"utilization": 0.25}})

real_client = httpx.Client.__init__
httpx.Client.__init__ = lambda self, *args, **kwargs: real_client(self, *args, **{**kwargs, "transport": httpx.MockTransport(answer)})

class Pool:
    def try_refresh_matching(self, api_key_hint=None):
        refreshes.append(api_key_hint)
        return None

credential_pool.load_pool = lambda provider: Pool()
entries = {"openai-codex": types.SimpleNamespace(id="benched", label="Benched", runtime_api_key="codex-benched", base_url="https://chatgpt.com/backend-api/codex"),
           "anthropic": types.SimpleNamespace(id="work", label="Work", runtime_api_key="sk-ant-oat01-work")}
usage._pool = lambda provider: (None, [entries[provider]])
mirror = usage._anthropic_usage
usage._anthropic_usage = lambda token: mirrored.append(token) or mirror(token)

codex = usage.account("openai-codex", base_url=None, api_key=None, credential_id="benched")
anthropic = usage.account("anthropic", base_url=None, api_key=None, credential_id="work")
slot = account_usage_cache.cached_account_usage("anthropic", identity_id=account_usage_cache._identity_id_for("anthropic", entries["anthropic"]))
print(json.dumps({"codex": codex, "anthropic": anthropic, "requests": requests, "refreshes": refreshes, "mirrored": mirrored,
                  "account_slot": slot is not None, "provider_slot": account_usage_cache.cached_account_usage("anthropic") is not None}))
"""


@pytest.mark.skipif(AGENT_DIR is None or "read_only: bool = False" not in (AGENT_DIR / "agent/account_usage.py").read_text(), reason="read-only usage reads require Agent v0.21.6")
@requires_agent
def test_a_pool_account_usage_read_never_refreshes_its_credential(tmp_path):
    """TAL-824: a pool account's usage read is read-only. A Codex 401 is reported, never repaired by refreshing or rotating
    the credential, and the Anthropic read goes through the Agent's fetcher with the account's own key."""
    root = tmp_path / ".hermes"
    root.mkdir()
    run = subprocess.run([AGENT_PYTHON, "-c", READ_ONLY_PROBE, str(AGENT_DIR)], env=isolated_env(root), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    seen = json.loads(run.stdout.strip().splitlines()[-1])
    assert seen["refreshes"] == [], seen
    assert seen["codex"] is None, seen
    assert seen["requests"] == [["chatgpt.com", "Bearer codex-benched"], ["api.anthropic.com", "Bearer sk-ant-oat01-work"]], seen
    assert seen["mirrored"] == [], seen
    assert seen["anthropic"]["available"] is True and [w["used_percent"] for w in seen["anthropic"]["windows"]] == [25.0], seen
    # The read lands in that account's usage slot, never the provider-wide gauge.
    assert (seen["account_slot"], seen["provider_slot"]) == (True, False), seen


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


@pytest.mark.parametrize("agent_resolver", [True, False])
@pytest.mark.parametrize("resolved", ["sk-synthetic-scoped", "op://v/i/f", ""])
def test_balance_and_pool_resolve_keys_inside_profile_scope(tmp_path, monkeypatch, agent_resolver, resolved):
    from contextlib import contextmanager
    from talaria_sidecar.methods import Registry

    active = False
    looked_up = []

    @contextmanager
    def scope(home):
        nonlocal active
        assert home == tmp_path
        active = True
        monkeypatch.setenv("OPENROUTER_API_KEY", resolved)
        try:
            yield
        finally:
            active = False

    config = types.ModuleType("hermes_cli.config")

    def get_env(name):
        assert active, "credential lookup escaped the profile's scope"
        looked_up.append(name)
        return resolved if name == "OPENROUTER_API_KEY" else "op://v/missing/f"

    if agent_resolver:
        config.get_env_value_prefer_dotenv = get_env
    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.config", config)
    monkeypatch.setattr(usage, "scoped_home", scope)
    monkeypatch.setattr(usage, "_pool", lambda provider: (None, [types.SimpleNamespace(id="work", runtime_api_key="sk-synthetic-scoped")]))
    requests = _stub_http(monkeypatch, {"data": {"usage": 3, "limit": 100}})
    registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
    usage.register(registry)
    params = {"profile_home": str(tmp_path), "provider": "openrouter", "env_vars": ["MISSING_KEY", "OPENROUTER_API_KEY"]}
    result = registry.methods["usage.balance"](None, params)
    rows = registry.methods["usage.pool"](None, params)["entries"]
    usable = resolved.startswith("sk-")
    assert result["status"] == ("ok" if usable else "no_key")
    assert rows[0]["matches_api_key"] is usable
    assert [r.get_header("Authorization") for r in requests] == (["Bearer sk-synthetic-scoped"] if usable else [])
    if agent_resolver:
        assert looked_up == ["MISSING_KEY", "OPENROUTER_API_KEY"] * 2
    assert not active


def test_unresolved_explicit_keys_are_never_sent_to_provider(monkeypatch):
    requests = _stub_http(monkeypatch, {})
    assert _read("openrouter", api_key="op://v/i/f")["status"] == "no_key"
    monkeypatch.setattr(usage, "_pool", lambda provider: (None, [types.SimpleNamespace(id="work", runtime_api_key="op://v/i/f")]))
    assert _read("openrouter", credential_id="work")["status"] == "no_key"
    assert requests == []


@requires_agent
def test_usage_credentials_follow_real_agent_profile_secret_sources(tmp_path):
    from test_home import _VAULT_PLUGIN

    root = tmp_path / '.hermes'
    for profile, key in [('work', 'sk-work-vault'), ('home', 'sk-home-vault')]:
        named = root / 'profiles' / profile
        plugin = named / 'plugins' / 'test-vault'
        plugin.mkdir(parents=True)
        (plugin / 'plugin.yaml').write_text('name: test-vault\ndescription: synthetic vault\n')
        (plugin / '__init__.py').write_text(_VAULT_PLUGIN.replace('TESTVAULT_API_KEY', 'OPENROUTER_API_KEY').replace('stub-vault-key', key))
        (named / 'config.yaml').write_text('secrets:\n  sources: [testvault]\n  testvault:\n    enabled: true\n    override_existing: true\nplugins:\n  enabled: [test-vault]\n')
        (named / '.env').write_text('OPENROUTER_API_KEY=op://v/i/f\n' if profile == 'work' else '')
    missing = root / 'profiles' / 'missing'
    missing.mkdir()
    (missing / '.env').write_text('OPENROUTER_API_KEY=op://v/missing/f\n')
    code = '''
import io, json, os, sys, types
from pathlib import Path
sys.path.append(sys.argv[1])
from talaria_sidecar.methods import Registry, usage
requests = []
class Response(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *exc): return False
def urlopen(request, **kwargs):
    requests.append(request.get_header('Authorization'))
    return Response(b'{"data":{"usage":3,"limit":100}}')
usage.urllib.request.urlopen = urlopen
usage._pool = lambda provider: (None, [types.SimpleNamespace(id='work', runtime_api_key='sk-work-vault'), types.SimpleNamespace(id='home', runtime_api_key='sk-home-vault')])
registry = Registry(runtime=types.SimpleNamespace(load=lambda: None, ensure_current=lambda: None))
usage.register(registry)
seen = []
for profile in ['work', 'home', 'missing', 'work']:
    params = {'profile_home': str(Path(os.environ['HERMES_HOME']) / 'profiles' / profile), 'provider': 'openrouter', 'env_vars': ['OPENROUTER_API_KEY']}
    balance = registry.methods['usage.balance'](None, params)
    rows = registry.methods['usage.pool'](None, params)['entries']
    absent = registry.methods['usage.balance'](None, {**params, 'credential_id': 'removed'})
    seen.append([balance['status'], [r['credential_id'] for r in rows if r['matches_api_key']], absent['status']])
print(json.dumps({'seen': seen, 'requests': requests}))
'''
    run = subprocess.run([AGENT_PYTHON, '-c', code, str(AGENT_DIR)], env=isolated_env(root, OPENROUTER_API_KEY='sk-root-must-not-leak'), capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stderr[-4000:]
    result = json.loads(run.stdout.strip().splitlines()[-1])
    assert result['seen'] == [['ok', ['work'], 'no_key'], ['ok', ['home'], 'no_key'], ['no_key', [], 'no_key'], ['ok', ['work'], 'no_key']], (result, run.stderr[-6000:])
    assert result['requests'] == ['Bearer sk-work-vault', 'Bearer sk-home-vault', 'Bearer sk-work-vault']
