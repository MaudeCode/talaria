"""Exact receipt protocol and shared cooperative-cancellation exits, without a model provider."""
from __future__ import annotations

import contextlib
import json
import sys
import threading
import types

import pytest

from talaria_sidecar.methods import cron, cron_execution


def _gateway(monkeypatch, states, *, disconnect=False):
    calls = []
    receipt = {"session_id": "session-original", "admission_id": "admission-original"}

    class Client:
        async def rpc(self, method, **params):
            calls.append((method, params))
            if disconnect:
                raise OSError("owner disconnected")
            if method == "cron.cancel":
                return {"ok": True}
            status = states.pop(0)
            return {"status": status, **receipt, "result": [False, "output", "", "cancelled"] if status == "terminal" else None}

    @contextlib.asynccontextmanager
    async def connect_gateway(**kwargs):
        yield Client()

    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_client", types.SimpleNamespace(connect_gateway=connect_gateway))
    monkeypatch.setitem(sys.modules, "hermes_cli.gateway_runtime", types.SimpleNamespace(
        discover_gateway_endpoint=lambda home: types.SimpleNamespace(state="ready", endpoint="original-owner")))
    monkeypatch.setitem(sys.modules, "hermes_constants", types.SimpleNamespace(get_hermes_home=lambda: "original-home"))
    return calls, receipt


@pytest.mark.parametrize("states", [["queued", "terminal"], ["started", "started", "terminal"], ["terminal"]])
def test_recover_lost_ack_only_observes_and_cancels_the_original_receipt(monkeypatch, states):
    calls, receipt = _gateway(monkeypatch, list(states))
    cancelled = threading.Event()
    cancelled.set()
    result = cron_execution.recover({"id": "job-original"}, "execution-original", cancelled)
    assert result == (False, "output", "", "cancelled")
    assert calls[0] == ("cron.recover", {"job_id": "job-original", "request_id": "execution-original", "extra_prompt": None})
    assert all(method in {"cron.cancel", "cron.status"} and params == receipt for method, params in calls[1:])
    assert len([method for method, _ in calls if method == "cron.cancel"]) == len(states) - 1


def test_cancel_ack_followed_by_unknown_never_proves_termination(monkeypatch):
    calls, _ = _gateway(monkeypatch, ["started", "unknown"])
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(cron_execution.Unverified, match="unknown"):
        cron_execution.recover({"id": "job-original"}, "execution-original", cancelled)
    assert [method for method, _ in calls] == ["cron.recover", "cron.cancel", "cron.status"]


@pytest.mark.parametrize("disconnect", [False, True])
def test_unknown_or_disconnected_recovery_never_submits(monkeypatch, disconnect):
    calls, _ = _gateway(monkeypatch, ["unknown"], disconnect=disconnect)
    with pytest.raises((cron_execution.Unverified, OSError)):
        cron_execution.recover({"id": "job-original"}, "execution-original", threading.Event())
    assert [method for method, _ in calls] == ["cron.recover"]


def test_missing_receipt_is_definite_non_admission_without_resubmission(monkeypatch):
    calls, _ = _gateway(monkeypatch, ["missing"])
    result = cron_execution.recover({"id": "job-original"}, "execution-original", threading.Event())
    assert result[0] is False and "never admitted" in result[3]
    assert len(calls) == 1


def _cooperative(job, home, result_queue, cancel_event, execution_id, recovering):
    from pathlib import Path
    import time
    while not cancel_event.is_set():
        time.sleep(.01)
    Path(job["barrier"]).write_text(execution_id)
    time.sleep(.1)
    result_queue.put(("ok", (False, "", "", "cancelled")))


def _unresponsive(job, home, result_queue, cancel_event, execution_id, recovering):
    import time
    time.sleep(60)


class Execution:
    execution_id = "execution-original"
    recovering = False

    def __init__(self):
        self.record = {"cancel_reason": None}
        self.job = {}

    def cancel(self, reason):
        self.record["cancel_reason"] = self.record["cancel_reason"] or reason


@pytest.mark.parametrize("trigger", ["cancelled", "timeout", "claim_lost"])
def test_all_stop_exits_wait_for_cooperative_terminal_result(monkeypatch, tmp_path, trigger):
    execution = Execution()
    beats = []
    monkeypatch.setattr(cron, "_child_main", _cooperative)
    monkeypatch.setattr(cron, "_CLAIM_HEARTBEAT_SECONDS", 0)
    monkeypatch.setattr(cron, "_result_timeout", lambda job: 0 if trigger == "timeout" else 60)
    ctx = types.SimpleNamespace(cancelled=trigger == "cancelled")
    barrier = tmp_path / "cancel-observed"
    def heartbeat():
        beats.append(True)
        return trigger != "claim_lost"
    result = cron._run_in_child({"id": "job-original", "barrier": str(barrier)}, tmp_path, ctx, heartbeat, execution)
    assert result == (False, "", "", "cancelled")
    assert barrier.read_text() == execution.execution_id
    assert execution.record["cancel_reason"] == {"timeout": "Manual task timed out"}.get(trigger, trigger)
    if trigger == "claim_lost":
        assert len(beats) == 1, "a lost claim must never be heartbeated again"


def test_a_settlement_deadline_is_unverified_and_retains_the_execution(monkeypatch, tmp_path):
    execution = Execution()
    monkeypatch.setattr(cron, "_child_main", _unresponsive)
    monkeypatch.setattr(cron_execution, "SETTLEMENT_SECONDS", .01)
    with pytest.raises(cron_execution.Unverified, match="terminal receipt"):
        cron._run_in_child({"id": "job-original"}, tmp_path, types.SimpleNamespace(cancelled=True), execution=execution)
    assert execution.record["cancel_reason"] == "cancelled"


def _tail(monkeypatch, tmp_path, *, owns=True, booked=False, interrupt=False):
    calls = []
    current = {"id": "job-original", "canonical_completions": ["execution-original"] if booked else []}
    @contextlib.contextmanager
    def fence(job_id, *, expected_owner):
        assert (job_id, expected_owner) == ("job-original", "owner-original")
        yield owns
    def finish_ledger(execution_id, **kwargs):
        calls.append(("ledger", execution_id))
    jobs = types.SimpleNamespace(use_cron_store=lambda home: contextlib.nullcontext(),
                                 fire_claim_fence=fence, get_job=lambda job_id: current)
    def save(delivery, *args, **kwargs):
        calls.append(("output", delivery.job["execution_id"]))
        if interrupt:
            raise OSError("tail interrupted")
        calls.append(("delivery", delivery.job["execution_id"]))
    def mark(delivery, owner, execution_id, **kwargs):
        calls.append(("bookkeeping", execution_id))
        return True
    scheduler = types.SimpleNamespace(
        _apply_agent_failure_marker=lambda job, success, error, answer: (success, error, False),
        _RunDelivery=lambda job, success, error, **kw: types.SimpleNamespace(job=job, success=success, error=error),
        _FireOwnership=lambda job: None, _save_compose_deliver=save,
    )
    executions = types.SimpleNamespace(get_execution=lambda eid: {"status": "unknown"},
                                       finish_execution=finish_ledger, recover_receipted_execution=finish_ledger)
    monkeypatch.setitem(sys.modules, "cron", types.SimpleNamespace(jobs=jobs, scheduler=scheduler, executions=executions))
    monkeypatch.setitem(sys.modules, "cron.scheduler_authority", types.SimpleNamespace(
        journal_path=lambda jid, eid: tmp_path / "admission.json", _lift_pause=lambda *args: calls.append(("resume", "execution-original"))))
    monkeypatch.setitem(sys.modules, "cron.scheduler_bookkeeping", types.SimpleNamespace(
        fail_empty_response=lambda *args: None, finish_completed_run=mark))
    monkeypatch.setattr(cron_execution, "scoped_home", lambda home: contextlib.nullcontext())
    monkeypatch.setattr(cron, "_delivery_home", lambda *args: contextlib.nullcontext())
    execution = cron_execution.ManualExecution(tmp_path, tmp_path, {"id": "job-original", "fire_claim": {"by": "owner-original"}}, "owner-original")
    execution.execution_id = "execution-original"
    execution.record = {"cancel_reason": "cancelled", "tail_started": False, "pause": {"paused_at": "original", "reason": "original"}}
    execution.file.parent.mkdir(parents=True)
    monkeypatch.setattr(execution, "save", lambda: execution.file.write_text(json.dumps(execution.record)))
    execution.save()
    return execution, calls


def test_terminal_prior_admission_never_stamps_or_delivers_over_a_successor_claim(monkeypatch, tmp_path):
    execution, calls = _tail(monkeypatch, tmp_path, owns=False)
    result = execution.finish((False, "old output", "", "cancelled"))
    assert result["status"] == "failed" and "claim" in result["error"]
    assert calls == [("ledger", "execution-original")]
    assert execution.settled and not execution.file.exists()


def test_a_claim_lost_before_dispatch_never_submits_a_task(monkeypatch, tmp_path):
    execution, calls = _tail(monkeypatch, tmp_path, owns=False)
    execution.file.unlink()
    ledger = sys.modules["cron"].executions
    monkeypatch.setattr(ledger, "create_execution", lambda *args, **kwargs: {"id": "execution-original"}, raising=False)
    monkeypatch.setattr(ledger, "mark_execution_running", lambda eid: None, raising=False)
    execution.prepare()
    assert execution.record["cancel_reason"] == "claim_lost"
    assert execution.record["result"] == [False, "", "", "Fire claim lost before submission"]
    assert execution.finish(execution.record["result"])["status"] == "failed"
    assert calls == [("ledger", "execution-original")]


def test_a_crash_during_the_tail_never_replays_output_delivery_or_bookkeeping(monkeypatch, tmp_path):
    execution, calls = _tail(monkeypatch, tmp_path, interrupt=True)
    with pytest.raises(OSError, match="interrupted"):
        execution.finish((False, "output", "", "cancelled"))
    assert json.loads(execution.file.read_text())["tail_started"] is True
    with pytest.raises(cron_execution.Unverified, match="will not be repeated"):
        execution.finish((False, "output", "", "cancelled"))
    assert calls == [("output", "execution-original")]
    assert execution.file.exists() and not execution.settled


@pytest.mark.parametrize("owns", [True, False])
def test_a_durable_bookkeeping_receipt_retires_recovery_without_repeating_side_effects(monkeypatch, tmp_path, owns):
    execution, calls = _tail(monkeypatch, tmp_path, booked=True, owns=owns)
    execution.record["tail_started"] = True
    with pytest.raises(cron.RpcError) as error:
        execution.finish((False, "output", "", "cancelled"))
    assert error.value.data["condition"] == "cancelled"
    assert calls == [("ledger", "execution-original"), ("resume", "execution-original")]
    assert not execution.file.exists()


def test_a_success_already_terminal_when_cancel_arrives_reports_the_owner_result(monkeypatch, tmp_path):
    execution, _ = _tail(monkeypatch, tmp_path)
    result = execution.finish((True, "output", "answer", None))
    assert result["status"] == "completed" and result["success"] is True


def test_only_one_process_can_reconcile_an_execution_at_a_time(tmp_path):
    first = cron_execution.ManualExecution(tmp_path, tmp_path, {"id": "job-original"}, None)
    second = cron_execution.ManualExecution(tmp_path, tmp_path, {"id": "job-original"}, None)
    with first.acquire(), pytest.raises(cron.RpcError, match="still being reconciled"):
        with second.acquire():
            pytest.fail("two recovery owners acquired the same execution")


def test_recovery_remains_reachable_after_the_job_was_removed(monkeypatch, tmp_path):
    record = cron_execution.path(tmp_path, "job-original")
    record.parent.mkdir(parents=True)
    record.write_text("{}")
    methods, recovered = {}, []
    class Registry:
        def method(self, name, **kwargs):
            return lambda fn: methods.setdefault(name, fn)
    monkeypatch.setattr(cron, "_store", lambda home: contextlib.nullcontext())
    monkeypatch.setattr(cron, "_jobs", lambda: types.SimpleNamespace(get_job=lambda jid: None))
    monkeypatch.setattr(cron, "run_tracked", lambda job, *args: recovered.append(job["id"]) or {"status": "failed"})
    cron.register(Registry())
    result = methods["cron.run"](types.SimpleNamespace(), {"profile_home": str(tmp_path), "job_id": "job-original"})
    assert recovered == ["job-original"] and result["status"] == "failed"


def test_a_crash_after_pausing_recovers_the_exact_pause_before_retiring_the_record(monkeypatch, tmp_path):
    execution, calls = _tail(monkeypatch, tmp_path)
    execution.file.unlink()
    agent = sys.modules["cron"]
    monkeypatch.setattr(agent.executions, "create_execution", lambda *args, **kwargs: {"id": "execution-original"}, raising=False)
    monkeypatch.setattr(agent.executions, "mark_execution_running", lambda eid: None, raising=False)
    current = agent.jobs.get_job("job-original")
    current.update(state="scheduled", enabled=True)
    monkeypatch.setattr(agent.jobs, "is_job_runnable", lambda job: job["state"] == "scheduled" and job["enabled"], raising=False)
    def pause(job_id, *, reason):
        current.update(state="paused", enabled=False, paused_at="pause-instant", paused_reason=reason)
        return current
    monkeypatch.setattr(agent.jobs, "pause_job", pause, raising=False)
    def crash_after_pause():
        if execution.record.get("pause"):
            raise OSError("record write interrupted after schedule pause")
        execution.file.write_text(json.dumps(execution.record))
    monkeypatch.setattr(execution, "save", crash_after_pause)
    with pytest.raises(OSError, match="after schedule pause"):
        execution.prepare()
    assert "pause" not in json.loads(execution.file.read_text())
    recovered = cron_execution.ManualExecution(tmp_path, tmp_path, {"id": "job-original"}, "owner-original")
    monkeypatch.setattr(recovered, "save", lambda: recovered.file.write_text(json.dumps(recovered.record)))
    recovered.prepare()
    assert recovered.record.get("pause") == {"paused_at": "pause-instant", "reason": current["paused_reason"]}
    recovered.finish((False, "output", "", "cancelled"))
    assert ("resume", "execution-original") in calls
