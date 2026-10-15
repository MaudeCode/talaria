"""Exact manual-fire recovery. The Agent owns admission, delivery and bookkeeping formats.

Its admission journal lacks the Web caller's cancellation intent and tail ownership.
This additive record retains those two obligations across a lost submitter or sidecar.
"""
from __future__ import annotations

import asyncio
import contextlib
import importlib
import json
import os
import time
from pathlib import Path

from ..dependency_sync import _lock
from ..errors import RpcError
from ..home import scoped_home

SETTLEMENT_SECONDS = 30.0


class Unverified(RpcError):
    def __init__(self, detail):
        self.detail = str(detail)
        super().__init__(f"Task outcome is unverified. {detail}",
                         condition="cron_execution_unverified")


def path(home, job_id):
    return Path(home) / "cron" / "manual_runs" / (job_id + ".json")


def _read_record(home, job_id):
    try:
        record = json.loads(path(home, job_id).read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise Unverified("The retained task record could not be read.") from exc
    job = record.get("job") if isinstance(record, dict) else None
    if not isinstance(job, dict) or job.get("id") != job_id:
        raise Unverified("Recovery identity does not match this task.")
    return record


def pending_job(home, job_id):
    """The frozen job keeps an externally deleted execution reachable through Web's list/get preflight."""
    record = _read_record(home, job_id)
    if record is None:
        return None
    job = record["job"]
    return dict(job, recovery_only=True, state="paused", enabled=False, last_run_at=None, last_status="error",
                last_error="Task outcome is unverified. Use Run now to check it.")


def pending_jobs(home):
    from .cron import _job_id
    result = []
    for file in sorted((Path(home) / "cron" / "manual_runs").glob("*.json")):
        job = pending_job(home, _job_id({"job_id": file.stem}))
        if job is not None:
            result.append(job)
    return result


def supported(job):
    if job.get("no_agent"):
        return False
    try:
        importlib.import_module("cron.scheduler_authority")
    except ModuleNotFoundError as exc:
        if exc.name in {"cron.scheduler_authority", "cron"}:
            return False
        raise
    return True


def recover(job, execution_id, cancel_event):
    """Observe only. A lost submission reply never authorizes another submit."""
    from hermes_cli.gateway_client import connect_gateway

    async def observe():
        endpoint = None
        if not os.environ.get("HERMES_TUI_GATEWAY_URL", "").strip():
            from hermes_cli.gateway_runtime import discover_gateway_endpoint
            from hermes_constants import get_hermes_home
            discovery = await asyncio.to_thread(discover_gateway_endpoint, get_hermes_home())
            if discovery.state != "ready" or discovery.endpoint is None:
                raise Unverified("The owning gateway is unavailable.")
            endpoint = discovery.endpoint
        async with connect_gateway(endpoint=endpoint) as client:
            state = await client.rpc("cron.recover", job_id=job["id"], request_id=execution_id, extra_prompt=None)
            if state["status"] == "missing":
                return False, "", "", "Cron admission missing: the owner never admitted this fire"
            if state["status"] == "unknown":
                raise Unverified("The owner cannot prove this admission's outcome.")
            receipt = {key: state[key] for key in ("session_id", "admission_id")}
            while True:
                if state["status"] == "terminal":
                    job.update(state.get("job_flags") or {})
                    return tuple(state["result"])
                if state["status"] not in {"queued", "started"}:
                    raise Unverified(f"Owner status: {state['status']}")
                if cancel_event.is_set():
                    await client.rpc("cron.cancel", **receipt)
                await asyncio.sleep(.2)
                state = await client.rpc("cron.status", **receipt)
    return asyncio.run(observe())


class ManualExecution:
    def __init__(self, home, execution_home, job, owner):
        self.home = Path(home)
        self.file = path(home, job["id"])
        self.execution_home = Path(execution_home or home)
        self.job, self.owner = dict(job), owner
        self.record = None
        self.recovering = False
        self.settled = False

    def save(self):
        from utils import atomic_json_write
        atomic_json_write(self.file, self.record, mode=0o600, fsync_dir=True)

    @contextlib.contextmanager
    def acquire(self):
        self.file.parent.mkdir(parents=True, exist_ok=True)
        with self.file.with_suffix(".lock").open("a+b") as lease:
            try:
                _lock(lease)
            except OSError as exc:
                raise RpcError("This manual task is still being reconciled", condition="cron_execution_unverified") from exc
            yield

    def prepare(self, *, recovery_only=False):
        from cron import executions, jobs
        self.record = _read_record(self.home, self.job["id"])
        if self.record is not None:
            self.job, self.owner = self.record["job"], self.record["owner"]
            self.execution_home = Path(self.record["execution_home"])
            self.recovering = True
        else:
            if recovery_only:
                raise Unverified("The retained task record is no longer available. Refresh its status.")
            with scoped_home(self.execution_home):
                row = executions.create_execution(self.job["id"], source="web-manual")
                executions.mark_execution_running(row["id"])
            self.record = {"job": self.job, "owner": self.owner, "execution_home": str(self.execution_home),
                           "execution_id": row["id"], "cancel_reason": None, "tail_started": False}
            self.execution_id = row["id"]
            self.save()
        self.execution_id = self.record["execution_id"]
        if self.recovering:
            self.cancel("submitter interrupted")
        # Pause before dispatch: a dead sidecar must not let claim expiry re-fire an accepted task.
        # Only this exact pause is lifted. Existing operator pauses are never changed.
        with jobs.use_cron_store(self.home):
            from .cron import _owner_fence
            with _owner_fence(jobs, self.job["id"], self.owner, protect_unclaimed=True) as owns:
                current = jobs.get_job(self.job["id"])
                if not owns and not self.recovering:
                    self.cancel("claim_lost")
                    self.record["result"] = [False, "", "", "Fire claim lost before submission"]
                    self.save()
                if owns and current and jobs.is_job_runnable(current) and not self.recovering:
                    current = jobs.pause_job(self.job["id"], reason=f"Manual execution pending: {self.execution_id}")
                # The job write may have committed before the submitter died saving its pause receipt.
                if (current and current.get("state") == "paused" and not self.record.get("pause")
                        and current.get("paused_reason") == f"Manual execution pending: {self.execution_id}"):
                    self.record["pause"] = {"paused_at": current["paused_at"], "reason": current["paused_reason"]}
                    self.save()

    def cancel(self, reason):
        if self.record["cancel_reason"] is None:
            self.record["cancel_reason"] = reason
            self.save()

    def finish(self, result):
        from cron import executions, jobs, scheduler
        from cron.scheduler_authority import journal_path
        from .cron import _delivery_home, _owner_fence, _ClaimLost

        success, output, answer, error = result
        with scoped_home(self.execution_home), jobs.use_cron_store(self.home), _owner_fence(jobs, self.job["id"], self.owner, protect_unclaimed=True) as owns:
            current = jobs.get_job(self.job["id"]) or {}
            row = executions.get_execution(self.execution_id)
            marked = self.execution_id in current.get("canonical_completions", [])
            booked = marked or (row and row["status"] in {"completed", "failed"})
            # Our own mark releases the claim before pause cleanup. A successor's claim never qualifies.
            may_finish = bool(current) and (owns or (marked and not current.get("fire_claim")))
            if not booked and self.record["tail_started"]:
                raise Unverified("Bookkeeping was interrupted; its side effects will not be repeated.")
            # Stop the Agent's orphan journal reader from replaying OUR tail after a crash.
            # Our record now owns recovery, including the at-most-once tail barrier.
            self.record["result"] = list(result)
            self.save()
            journal_path(self.job["id"], self.execution_id).unlink(missing_ok=True)
            if not may_finish:
                self._finish_ledger(False, "Fire claim ownership lost before terminal completion.")
            elif booked:
                self._finish_ledger(success, error)
            else:
                self.record["tail_started"] = True
                self.save()
                self.job["execution_id"] = self.execution_id
                with _delivery_home(scheduler, self.home):
                    from cron.scheduler_bookkeeping import fail_empty_response, finish_completed_run
                    success, error, declared = scheduler._apply_agent_failure_marker(self.job, success, error, answer)
                    delivery = scheduler._RunDelivery(self.job, success, error, agent_declared=declared)
                    scheduler._save_compose_deliver(delivery, scheduler._FireOwnership(self.job), answer, output,
                                                 adapters=None, loop=None, verbose=False, execution_token=None)
                    fail_empty_response(delivery, answer)
                    if not finish_completed_run(delivery, self.owner, self.execution_id, recovered=self.recovering):
                        raise Unverified("A prior submitter still owns this execution's bookkeeping.")
                    success, error = delivery.success, delivery.error
            pause = self.record.get("pause")
            if may_finish and pause:
                from cron.scheduler_authority import _lift_pause
                _lift_pause(self.job["id"], pause)
            self.file.unlink()
            self.settled = True
        reason = self.record["cancel_reason"]
        if not may_finish or reason == "claim_lost":
            return {"job_id": self.job["id"], "status": "failed", "success": False, "error": str(_ClaimLost())}
        if reason == "cancelled" and not success:
            raise RpcError("cancelled", condition="cancelled")
        if reason and not success:
            return {"job_id": self.job["id"], "status": "failed", "success": False, "error": reason}
        return {"job_id": self.job["id"], "status": "completed", "success": bool(success), "error": error}

    def _finish_ledger(self, success, error):
        from cron import executions
        finish = executions.recover_receipted_execution if self.recovering else executions.finish_execution
        kwargs = {"job_id": self.job["id"]} if self.recovering else {}
        finish(self.execution_id, success=success, error=error, **kwargs)


def run(job, home, execution_home, ctx, owner, *, recovery_only=False):
    from . import cron
    execution = ManualExecution(home, execution_home, job, owner)
    with execution.acquire():
        with cron._RUNNING_LOCK:
            cron._RUNNING.setdefault(job["id"], time.time())
        try:
            execution.prepare(recovery_only=recovery_only)
            heartbeat = cron._heartbeat(home, execution.job["id"], execution.owner) if execution.owner else None
            if execution.record.get("result") is not None:
                result = execution.record["result"]
            else:
                result = cron._run_in_child(execution.job, execution.execution_home, ctx, heartbeat, execution)
            return execution.finish(result)
        except Exception as exc:
            if execution.settled:
                raise
            if execution.record is not None and hasattr(execution, "execution_id"):
                execution.cancel(execution.record["cancel_reason"] or "submitter interrupted")
                # The Web record, not the Agent's generic orphan replay, now owns cancellation.
                # Give up only our own audit row; this never releases or stamps a fire claim.
                with scoped_home(execution.execution_home):
                    from cron.scheduler_authority import journal_path
                    from cron.executions import give_up_execution
                    journal_path(job["id"], execution.execution_id).unlink(missing_ok=True)
                    give_up_execution(execution.execution_id, reason=str(exc))
            if isinstance(exc, Unverified):
                raise
            raise Unverified(str(exc)) from exc
        finally:
            # The durable record guards an unverified owner; this map guards only an active call.
            with cron._RUNNING_LOCK:
                cron._RUNNING.pop(job["id"], None)
