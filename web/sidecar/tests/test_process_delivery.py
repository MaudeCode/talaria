"""TAL-459: async delegation deliveries claim and acknowledge the pinned Agent's durable ledger."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess

from conftest import AGENT_DIR, AGENT_PYTHON, SidecarProcess


def _agent(home: pathlib.Path, code: str, *args: str) -> str:
    """Run ``code`` on the pinned Agent's interpreter with ``home`` as its Hermes home."""
    env = {"HOME": str(home.parent), "HERMES_HOME": str(home), "PATH": "/usr/bin:/bin", "HERMES_STATE_DB_GUARD_BYPASS": "1"}
    if os.environ.get("LD_LIBRARY_PATH"):
        env["LD_LIBRARY_PATH"] = os.environ["LD_LIBRARY_PATH"]
    prelude = "import sys, json, time; sys.path.insert(0, sys.argv[1]); from tools import async_delegation as ad\n"
    out = subprocess.run([AGENT_PYTHON, "-c", prelude + code, str(AGENT_DIR), *args], check=True, env=env, capture_output=True, text=True)
    return out.stdout.strip()


def _seed_completed(home: pathlib.Path, delegation_id: str) -> None:
    _agent(home, (
        "ad._persist_dispatch({'delegation_id': sys.argv[2], 'dispatched_at': time.time(), 'session_key': 'web', 'origin_ui_session_id': 'web'})\n"
        "with ad._DB_LOCK, ad._transaction() as conn:\n"
        "    conn.execute(\"UPDATE async_delegations SET state='completed', completed_at=?, event_json=? WHERE delegation_id=?\","
        " (time.time(), json.dumps({'type': 'async_delegation', 'delegation_id': sys.argv[2]}), sys.argv[2]))\n"
    ), delegation_id)


def _delivery_state(home: pathlib.Path, delegation_id: str) -> str:
    return _agent(home, "print(ad.get_durable_delegation(sys.argv[2])['delivery_state'])", delegation_id)


def _event(delegation_id: str) -> dict:
    return {"type": "async_delegation", "delegation_id": delegation_id, "process_id": delegation_id, "consumed": False}


def test_a_completed_delivery_is_never_claimed_again(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    _seed_completed(hermes_home, "deleg_done")
    params = {"profile_home": str(hermes_home), "event": _event("deleg_done")}
    claim = handshaken.result("process.claim_delivery", {**params, "consumer": "webui"})["claim_id"]
    assert claim
    # The held claim keeps a second consumer (a restarted server, the gateway sweep) out.
    assert handshaken.result("process.claim_delivery", {**params, "consumer": "webui"})["claim_id"] is None
    assert handshaken.result("process.complete_delivery", {**params, "claim_id": claim}) == {"ok": True}
    assert _delivery_state(hermes_home, "deleg_done") == "delivered"
    assert handshaken.result("process.claim_delivery", {**params, "consumer": "webui"})["claim_id"] is None


def test_a_released_delivery_stays_pending_and_can_be_claimed_again(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    _seed_completed(hermes_home, "deleg_retry")
    params = {"profile_home": str(hermes_home), "event": _event("deleg_retry")}
    claim = handshaken.result("process.claim_delivery", {**params, "consumer": "webui"})["claim_id"]
    assert handshaken.result("process.release_delivery", {**params, "claim_id": claim}) == {"ok": True}
    assert _delivery_state(hermes_home, "deleg_retry") == "pending"
    assert handshaken.result("process.claim_delivery", {**params, "consumer": "webui"})["claim_id"]


def test_a_deferred_delivery_returns_without_spending_an_attempt(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    _seed_completed(hermes_home, "deleg_busy")
    params = {"profile_home": str(hermes_home), "event": _event("deleg_busy")}
    attempts = lambda: int(_agent(hermes_home, "print(ad.get_durable_delegation(sys.argv[2])['delivery_attempts'])", "deleg_busy"))  # noqa: E731
    # A busy session can bounce the same delivery many times; none of it may count toward the Agent's drop budget.
    for _ in range(10):
        claim = handshaken.result("process.claim_delivery", {**params, "consumer": "webui"})["claim_id"]
        assert claim
        assert handshaken.result("process.defer_delivery", {**params, "claim_id": claim}) == {"ok": True}
    assert attempts() == 0
    assert _delivery_state(hermes_home, "deleg_busy") == "pending"


def test_an_interim_notice_needs_no_acknowledgement(handshaken: SidecarProcess, hermes_home: pathlib.Path) -> None:
    notice = {**_event("deleg_interim"), "task_failure_notice": True}
    assert handshaken.result("process.claim_delivery", {"profile_home": str(hermes_home), "event": notice, "consumer": "webui"}) == {"claim_id": ""}
    assert handshaken.result("process.complete_delivery", {"profile_home": str(hermes_home), "event": notice, "claim_id": ""}) == {"ok": False}
