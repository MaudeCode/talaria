"""TAL-2681: ``usage.reset_credits`` lists a Codex account's banked usage-limit resets and ``usage.redeem_reset_credit``
spends exactly the chosen one, against a stand-in Codex backend and a stand-in ``agent.account_usage``. No real grant is read or spent."""

from __future__ import annotations

import copy
import io
import json
import pathlib
import socket
import sys
import types
import urllib.error

import pytest
from talaria_sidecar.methods import usage

# The `usage.reset_credits` answer the server's reset-credit tests replay as the sidecar's.
LIST_FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "codex_reset_credits.json"
LIST_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
CONSUME_URL = LIST_URL + "/consume"


def _grant(credit_id: str, title: str, expires_at: str, **extra) -> dict:
    return {"id": credit_id, "reset_type": "codex_rate_limits", "status": "available", "granted_at": "2026-11-01T00:00:00Z", "expires_at": expires_at,
            "redeem_started_at": None, "redeemed_at": None, "profile_image_url": "https://example.invalid/a.png", "profile_user_id": "@friend", "title": title, "description": "Ready to redeem", **extra}


PROVIDER_LIST = {
    "credits": [
        _grant("rc_full_a", "Full reset (Weekly + 5 hr)", "2099-01-10T00:00:00Z"),
        _grant("rc_full_b", "Full reset (Weekly + 5 hr)", "2099-02-10T00:00:00Z"),
        _grant("rc_weekly", "Weekly reset", "2099-03-10T00:00:00Z"),
        _grant("rc_session", "5 hr reset", None),
        _grant("rc_used", "Full reset (Weekly + 5 hr)", "2099-04-10T00:00:00Z", status="redeemed", redeemed_at="2026-11-20T10:00:00Z"),
        _grant("rc_expired", "Weekly reset", "2020-01-01T00:00:00Z"),
    ],
    "available_count": 4,
    "total_earned_count": 6,
}


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Backend:
    """The Codex reset-credit endpoints: the list, and a consume that marks the chosen grant redeemed unless told to fail.
    Like the provider, a spent grant answers its own attempt id ``already_redeemed`` and refuses any other."""

    def __init__(self, monkeypatch):
        self.credits = copy.deepcopy(PROVIDER_LIST)
        self.requests: list[tuple[str, str, str, dict | None]] = []
        self.consume_error: Exception | None = None
        self.spend_then_fail = False
        self.lists_fail_after_consume = False
        self.spent_by: dict[str, str] = {}
        monkeypatch.setattr(usage, "_open_balance", self.open)

    def open(self, request, timeout=None):
        body = json.loads(request.data) if request.data else None
        self.requests.append((request.get_method(), request.full_url, request.get_header("Authorization"), body))
        if request.full_url == LIST_URL and request.get_method() == "GET":
            if self.lists_fail_after_consume and self.consumes:
                raise socket.timeout("timed out")
            return _Response(json.dumps(self.credits).encode())
        assert request.full_url == CONSUME_URL and request.get_method() == "POST", request.full_url
        grant = next(c for c in self.credits["credits"] if c["id"] == body["credit_id"])
        if grant["status"] == "redeemed":
            if self.spent_by.get(grant["id"]) != body["redeem_request_id"]:
                raise urllib.error.HTTPError(CONSUME_URL, 409, "conflict", {}, io.BytesIO(b"{}"))
            return _Response(json.dumps({"code": "already_redeemed", "windows_reset": 0}).encode())
        if self.consume_error is not None and not self.spend_then_fail:
            raise self.consume_error
        self.spent_by[grant["id"]] = body["redeem_request_id"]
        grant.update(status="redeemed", redeemed_at="2026-11-22T12:00:00Z")
        self.credits["available_count"] -= 1
        if self.consume_error is not None:
            raise self.consume_error
        return _Response(json.dumps({"code": "reset", "credit": {"id": body["credit_id"]}, "windows_reset": 2}).encode())

    @property
    def consumes(self) -> list[dict]:
        return [body for method, _url, _auth, body in self.requests if method == "POST"]


@pytest.fixture
def agent(monkeypatch):
    """A stand-in for the Agent's Codex helpers: the signed-in account's token unless a pool account's key is passed."""
    cleared: list[str | None] = []
    module = types.ModuleType("agent.account_usage")
    module._resolve_codex_usage_credentials = lambda base_url, api_key: (api_key or "tok-signed-in", base_url or "https://chatgpt.com/backend-api/codex", None)
    module._codex_backend_urls = lambda base_url: (LIST_URL.replace("rate-limit-reset-credits", "usage"), LIST_URL, CONSUME_URL)
    module._codex_headers = lambda token, account_id: {"Authorization": f"Bearer {token}"}
    auth = types.ModuleType("hermes_cli.auth")
    auth.clear_codex_pool_quota_cooldowns = lambda access_token=None: cleared.append(access_token) or 1
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.account_usage", module)
    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.auth", auth)
    accounts = [types.SimpleNamespace(id="work", runtime_api_key="tok-work", runtime_base_url="https://chatgpt.com/backend-api/codex"),
                types.SimpleNamespace(id="home", runtime_api_key="tok-home", runtime_base_url=None)]
    monkeypatch.setattr(usage, "_pool", lambda provider: (None, accounts if provider == "openai-codex" else []))
    return cleared


def test_the_list_keeps_every_grant_distinct_and_only_reads_with_the_accounts_own_key(agent, monkeypatch):
    backend = Backend(monkeypatch)
    listed = usage.reset_credits("work")
    assert listed == json.loads(LIST_FIXTURE.read_text())
    # Two identical full resets stay two grants, each with its own id and expiry; the friend's profile never leaves.
    assert [(c["id"], c["title"], c["expires_at"]) for c in listed["credits"][:2]] == [("rc_full_a", "Full reset (Weekly + 5 hr)", "2099-01-10T00:00:00Z"), ("rc_full_b", "Full reset (Weekly + 5 hr)", "2099-02-10T00:00:00Z")]
    assert backend.requests == [("GET", LIST_URL, "Bearer tok-work", None)]


def test_redeem_spends_exactly_the_chosen_grant_of_that_account(agent, monkeypatch):
    backend = Backend(monkeypatch)
    result = usage.redeem_reset_credit("home", "rc_full_b", "attempt-1")
    assert backend.consumes == [{"redeem_request_id": "attempt-1", "credit_id": "rc_full_b"}]
    assert {auth for _m, _u, auth, _b in backend.requests} == {"Bearer tok-home"}
    assert (result["outcome"], result["windows_reset"]) == ("reset", 2)
    assert {c["id"]: c["status"] for c in result["credits"]["credits"]}["rc_full_b"] == "redeemed"
    assert {c["id"]: c["status"] for c in result["credits"]["credits"]}["rc_full_a"] == "available"
    assert agent == ["tok-home"]


@pytest.mark.parametrize(("credit_id", "outcome"), [("rc_other_account", "not_found"), ("rc_expired", "not_available")])
def test_a_grant_this_account_cannot_spend_is_never_sent(agent, monkeypatch, credit_id, outcome):
    backend = Backend(monkeypatch)
    result = usage.redeem_reset_credit("work", credit_id, "attempt-1")
    assert (result["outcome"], backend.consumes, agent) == (outcome, [], [])
    assert result["credits"]["available_count"] == 4


def test_a_spent_grant_is_only_replayed_by_its_own_attempt(agent, monkeypatch):
    # The answer and the reread are both lost: the outcome is unknown and the cooldown stays until the attempt is confirmed.
    backend = Backend(monkeypatch)
    backend.consume_error, backend.spend_then_fail, backend.lists_fail_after_consume = socket.timeout("timed out"), True, True
    assert (usage.redeem_reset_credit("work", "rc_full_a", "attempt-1")["outcome"], agent) == ("unknown", [])
    # Replaying that attempt confirms it without spending anything more, and lifts the cooldown.
    backend.consume_error, backend.lists_fail_after_consume = None, False
    assert usage.redeem_reset_credit("work", "rc_full_a", "attempt-1")["outcome"] == "already_redeemed"
    assert agent == ["tok-work"]
    # Another attempt on a spent grant is refused and spends nothing.
    result = usage.redeem_reset_credit("work", "rc_used", "attempt-2")
    assert (result["outcome"], result["http_status"], agent) == ("refused", 409, ["tok-work"])
    assert result["credits"]["available_count"] == 3
    assert [b["credit_id"] for b in backend.consumes] == ["rc_full_a", "rc_full_a", "rc_used"]


@pytest.mark.parametrize("lost", [lambda: socket.timeout("timed out"), lambda: urllib.error.HTTPError(CONSUME_URL, 502, "bad gateway", {}, io.BytesIO(b""))], ids=["timeout", "502"])
def test_a_lost_answer_is_reconciled_from_the_reread_list_and_never_retried(agent, monkeypatch, lost):
    backend = Backend(monkeypatch)
    backend.consume_error, backend.spend_then_fail = lost(), True
    assert usage.redeem_reset_credit("work", "rc_full_a", "attempt-1")["outcome"] == "reset"
    assert agent == ["tok-work"]

    backend = Backend(monkeypatch)
    backend.consume_error = lost()
    result = usage.redeem_reset_credit("work", "rc_full_a", "attempt-2")
    assert result["outcome"] == "unknown"
    assert len(backend.consumes) == 1
    assert {c["id"]: c["status"] for c in result["credits"]["credits"]}["rc_full_a"] == "available"


def test_a_refusal_and_a_missing_account_spend_nothing(agent, monkeypatch):
    backend = Backend(monkeypatch)
    backend.consume_error = urllib.error.HTTPError(CONSUME_URL, 409, "conflict", {}, io.BytesIO(b"{}"))
    result = usage.redeem_reset_credit("work", "rc_full_a", "attempt-1")
    assert (result["outcome"], result["http_status"], agent) == ("refused", 409, [])
    assert result["credits"]["available_count"] == 4

    backend = Backend(monkeypatch)
    assert usage.redeem_reset_credit("gone", "rc_full_a", "attempt-1")["outcome"] == "no_credentials"
    assert usage.reset_credits("gone")["status"] == "no_credentials"
    assert backend.requests == []
