"""``cron.*``: Hermes scheduled jobs through ``cron.jobs`` and ``cron.scheduler``
(ported from api/routes.py's cron handlers).

Every store operation is pinned to an explicit profile home with
``cron.jobs.use_cron_store``. Manual runs execute in a spawned child process
pinned to the job's execution profile, exactly as the Python backend does, and
stream progress frames to the server.
"""

from __future__ import annotations

import contextlib
import importlib
import logging
import multiprocessing
import queue
import re
import threading
import time
from pathlib import Path

from ..errors import InvalidParams, RpcError
from ..home import profile_home_param, scoped_home
from ..rpc import CallContext

log = logging.getLogger("talaria_sidecar.cron")
_JOB_ID_RE = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}")
_OUTPUT_CONTENT_LIMIT = 8000
_OUTPUT_HEADER_CONTEXT = 200
_PASSTHROUGH_FIELDS = ("script", "no_agent", "context_from", "reasoning_effort", "monitor_script", "monitor_url")
_RUNNING: dict[str, float] = {}
_RUNNING_LOCK = threading.Lock()
_SNAPSHOT_LOCK = threading.Lock()


class CronUnavailable(RpcError):
    def __init__(self, exc: Exception):
        super().__init__(f"cron unavailable: {exc}", condition="cron_unavailable")


def _jobs():
    try:
        from cron import jobs
    except ModuleNotFoundError as exc:
        if exc.name in ("cron", "cron.jobs"):
            raise CronUnavailable(exc) from exc
        raise
    return jobs


def _store(home: Path):
    return _jobs().use_cron_store(home)


def _job_id(params: dict, key: str = "job_id") -> str:
    """A job id that names files under ``cron/output/<id>``: strict shape."""
    job_id = str(params.get(key) or "").strip()
    if not job_id or not _JOB_ID_RE.fullmatch(job_id) or job_id in (".", ".."):
        raise InvalidParams("invalid job_id")
    return job_id


def _job_ref(params: dict, key: str = "job_id") -> str:
    """A job reference resolved by the Agent's store (``pause_job`` etc. also accept names): predecessor passed it verbatim."""
    ref = str(params.get(key) or "").strip()
    if not ref or any(ch in ref for ch in "\x00\r\n"):
        raise InvalidParams("invalid job_id")
    return ref


# ── job payload shaping ───────────────────────────────────────────────────

def _monitor_storage(monitor) -> dict:
    value = str(monitor or "").strip()
    if not value:
        return {"monitor_script": "", "monitor_url": ""}
    if value.lower().startswith(("http://", "https://")):
        return {"monitor_script": "", "monitor_url": value}
    return {"monitor_script": value, "monitor_url": ""}


def _continuity_refs(context_from, continuity: bool) -> list:
    if context_from is None:
        refs = []
    elif isinstance(context_from, str):
        refs = [context_from.strip()] if context_from.strip() else []
    elif isinstance(context_from, (list, tuple)):
        refs = [str(ref).strip() for ref in context_from if str(ref).strip()]
    else:
        raise InvalidParams("context_from must be a job ID string or a list of job ID strings")
    has_self = any(ref.lower() == "self" for ref in refs)
    if continuity and not has_self:
        refs.append("self")
    elif not continuity and has_self:
        refs = [ref for ref in refs if ref.lower() != "self"]
    return refs


def _field_updates(body: dict, current_context_from=None) -> dict:
    updates = {key: body[key] for key in _PASSTHROUGH_FIELDS if key in body}
    if "monitor" in body:
        updates.update(_monitor_storage(body["monitor"]))
    if "continuity" in body:
        refs = updates["context_from"] if "context_from" in updates else current_context_from
        updates["context_from"] = _continuity_refs(refs, bool(body["continuity"]))
    return updates


def job_for_api(job: dict) -> dict:
    payload = dict(job or {})
    payload.setdefault("profile", None)
    payload["toast_notifications"] = payload.get("toast_notifications") is not False
    payload["monitor"] = payload.get("monitor_url") or payload.get("monitor_script") or ""
    payload["continuity"] = any(str(ref).strip().lower() == "self" for ref in (payload.get("context_from") or []))
    return payload


# ── output files ──────────────────────────────────────────────────────────

def _response_marker_index(text: str) -> int:
    candidates = []
    for heading in ("## Response", "# Response"):
        if text.startswith(heading):
            candidates.append(0)
        idx = text.find(f"\n{heading}")
        if idx >= 0:
            candidates.append(idx + 1)
    return min(candidates) if candidates else -1


def _content_window(text: str, limit: int = _OUTPUT_CONTENT_LIMIT) -> str:
    if len(text) <= limit:
        return text
    idx = _response_marker_index(text)
    if idx >= 0:
        header = text[: min(_OUTPUT_HEADER_CONTEXT, idx)].rstrip()
        response = text[idx:].lstrip("\n")
        return (f"{header}\n...\n{response}" if header else response)[:limit]
    return text[-limit:]


def _usage_metadata(text: str) -> dict:
    head = text.split("## Response", 1)[0].split("# Response", 1)[0]
    usage: dict = {}

    def intish(value: str):
        cleaned = re.sub(r"[^0-9]", "", value or "")
        return int(cleaned) if cleaned else None

    def floatish(value: str):
        match = re.search(r"[-+]?\d+(?:\.\d+)?", (value or "").replace(",", ""))
        return float(match.group(0)) if match else None

    for raw in head.splitlines():
        line = raw.strip()
        m = re.match(r"\*\*(?:Model|Model Used):\*\*\s*(.+)$", line, re.I)
        if m:
            usage["model"] = m.group(1).strip()
            continue
        m = re.match(r"\*\*Provider:\*\*\s*(.+)$", line, re.I)
        if m:
            usage["provider"] = m.group(1).strip()
            continue
        m = re.match(r"\*\*(?:Estimated cost|Cost):\*\*\s*(.+)$", line, re.I)
        if m:
            cost = floatish(m.group(1))
            if cost is not None:
                usage["estimated_cost_usd"] = cost
            continue
        m = re.match(r"\*\*(?:Duration|Elapsed):\*\*\s*(.+)$", line, re.I)
        if m:
            seconds = floatish(m.group(1))
            if seconds is not None:
                usage["duration_seconds"] = seconds
            continue
        m = re.match(r"\*\*Tokens:\*\*\s*(.+)$", line, re.I)
        if m:
            value = m.group(1)
            for key, pattern in (("input_tokens", r"([0-9][0-9,]*)\s*(?:input|in)\b"), ("output_tokens", r"([0-9][0-9,]*)\s*(?:output|out)\b")):
                found = re.search(pattern, value, re.I)
                if found:
                    usage[key] = intish(found.group(1))
            total = re.search(r"([0-9][0-9,]*)\s*(?:total\s*)?tokens?\b", value, re.I)
            if total and "total_tokens" not in usage:
                usage["total_tokens"] = intish(total.group(1))
    if "total_tokens" not in usage:
        total = sum(int(usage.get(k) or 0) for k in ("input_tokens", "output_tokens"))
        if total:
            usage["total_tokens"] = total
    return usage


def _snippet(text: str, limit: int = 600) -> str:
    lines = text.split("\n")
    idx = next((i for i, line in enumerate(lines) if line.startswith("## Response") or line.startswith("# Response")), -1)
    body = ("\n".join(lines[idx + 1:]) if idx >= 0 else "\n".join(lines)).strip()
    return body[:limit] or "(empty)"


# ── manual runs ───────────────────────────────────────────────────────────

def _child_main(job, execution_home, result_queue):
    try:
        from cron.scheduler import run_job

        if execution_home is None:
            result = run_job(job)
        else:
            from talaria_sidecar.home import scoped_home as _scoped

            import os

            os.environ["HERMES_HOME"] = str(execution_home)
            with _scoped(Path(execution_home)):
                result = run_job(job)
        result_queue.put(("ok", result))
    except BaseException as exc:  # noqa: BLE001 - surfaced in the parent
        import traceback

        result_queue.put(("error", f"{type(exc).__name__}: {exc}", traceback.format_exc()))


def _result_timeout(job) -> float:
    for key in ("timeout_seconds", "max_runtime_seconds", "timeout"):
        raw = (job or {}).get(key)
        if raw in (None, ""):
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value > 0:
            return max(60.0, value + 30.0)
    return 6 * 60 * 60.0


def _run_in_child(job, execution_home, ctx: CallContext):
    ctx_mp = multiprocessing.get_context("spawn")
    result_queue = ctx_mp.Queue(maxsize=1)
    process = ctx_mp.Process(target=_child_main, args=(job, str(execution_home) if execution_home else None, result_queue))
    process.start()
    deadline = time.monotonic() + _result_timeout(job)
    status, payload = "error", ["cron run subprocess failed before producing a result", ""]
    try:
        while True:
            try:
                status, *payload = result_queue.get(timeout=1.0)
                break
            except queue.Empty:
                if ctx.cancelled:
                    process.terminate()
                    process.join(timeout=5)
                    status, payload = "cancelled", ["cancelled", ""]
                    break
                if time.monotonic() >= deadline:
                    if process.is_alive():
                        process.terminate()
                        process.join(timeout=5)
                        payload = [f"cron run subprocess produced no result within {_result_timeout(job):g}s and was terminated", ""]
                    else:
                        payload = [f"cron run subprocess exited with code {process.exitcode} without producing a result", ""]
                    break
        process.join(timeout=5)
        if process.is_alive():
            process.terminate()
            process.join(timeout=5)
    finally:
        result_queue.close()
        result_queue.join_thread()
    if status == "ok":
        return payload[0]
    if status == "cancelled":
        raise RpcError("cancelled", condition="cancelled")
    if len(payload) > 1 and payload[1]:
        log.error("Manual cron subprocess failed:\n%s", payload[1])
    raise RuntimeError(payload[0])


_SCHEDULER_HOME_LOCK = threading.Lock()


@contextlib.contextmanager
def _delivery_home(scheduler, home: Path):
    """Predecessor ``cron_profile_context_for_home``: delivery and run metadata resolve config from the job's owning
    store home (``cron.scheduler._hermes_home`` and ``get_hermes_home()``), not the sidecar's process home."""
    with _SCHEDULER_HOME_LOCK, scoped_home(home):
        previous = getattr(scheduler, "_hermes_home", None)
        try:
            scheduler._hermes_home = Path(home)
        except Exception:  # noqa: BLE001 - read-only stand-ins in tests
            pass
        try:
            yield
        finally:
            try:
                scheduler._hermes_home = previous
            except Exception:  # noqa: BLE001
                pass


def run_tracked(job: dict, store_home: Path, execution_home: Path | None, ctx: CallContext) -> dict:
    jobs = _jobs()
    scheduler = importlib.import_module("cron.scheduler")
    silent_marker = getattr(scheduler, "SILENT_MARKER", "[SILENT]")
    deliver = getattr(scheduler, "_deliver_result", None)
    job_id = job.get("id", "")
    execution_home = execution_home or store_home
    outcome: dict = {"job_id": job_id, "status": "completed"}
    try:
        success, output, final_response, error = _run_in_child(job, execution_home, ctx)
        with _store(store_home), _delivery_home(scheduler, store_home):
            jobs.save_job_output(job_id, output)
            content = final_response if success else f"⚠️ Cron job '{job.get('name', job_id)}' failed:\n{error}"
            should_deliver = bool(content) and not (success and silent_marker in content.strip().upper())
            delivery_error = None
            if should_deliver and deliver is not None:
                try:
                    delivery_error = deliver(job, content)
                except Exception as exc:  # noqa: BLE001
                    delivery_error = str(exc)
            if success and not final_response:
                success, error = False, "Agent completed but produced empty response (model error, timeout, or misconfiguration)"
            try:
                jobs.mark_job_run(job_id, success, error, delivery_error=delivery_error)
            except TypeError:
                jobs.mark_job_run(job_id, success, error)
        outcome.update(success=bool(success), error=error, delivery_error=delivery_error)
    except RpcError:
        with _store(store_home):
            try:
                jobs.mark_job_run(job_id, False, "cancelled")
            except Exception:  # noqa: BLE001
                pass
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("Manual cron run failed for job %s", job_id)
        with _store(store_home):
            try:
                jobs.mark_job_run(job_id, False, str(exc))
            except Exception:  # noqa: BLE001
                pass
        outcome.update(status="failed", success=False, error=str(exc))
    finally:
        with _RUNNING_LOCK:
            _RUNNING.pop(job_id, None)
    return outcome


# ── methods ───────────────────────────────────────────────────────────────

def register(registry) -> None:
    @registry.method("cron.list")
    def list_(ctx: CallContext, params: dict) -> dict:
        """Jobs of one store, shaped for the API; the server merges profiles."""
        jobs = _jobs()
        with _store(profile_home_param(params)):
            return {"jobs": [job_for_api(job) for job in jobs.list_jobs(include_disabled=True)]}

    @registry.method("cron.get")
    def get(ctx: CallContext, params: dict) -> dict:
        with _store(profile_home_param(params)):
            job = _jobs().get_job(_job_id(params))
        return {"job": job_for_api(job) if job else None}

    @registry.method("cron.create")
    def create(ctx: CallContext, params: dict) -> dict:
        body = params.get("job") or {}
        if not body.get("schedule"):
            raise InvalidParams("Missing required field(s): schedule")
        if not body.get("prompt") and not body.get("script") and not body.get("skills"):
            raise InvalidParams("Missing required field(s): prompt")
        jobs = _jobs()
        home = profile_home_param(params)
        kwargs = _field_updates(body)
        if body.get("repeat") is not None:
            kwargs["repeat"] = body["repeat"]
        post: dict = {}
        if body.get("profile"):
            post["profile"] = str(body["profile"]).strip()
        if body.get("toast_notifications") is False:
            post["toast_notifications"] = False
        if body.get("owner_profile"):
            post["owner_profile"] = str(body["owner_profile"]).strip()
        execution_home = params.get("execution_home")
        if post.get("profile"):
            if not execution_home:
                raise InvalidParams("execution_home is required for a profile job")
            home = Path(execution_home)
        model, provider = (value.strip() or None if isinstance(value, str) else None for value in (body.get("model"), body.get("provider")))
        # The scheduler ignores Talaria's profile field. Pin the execution profile's main model
        # before creating it in that profile's own store. Scheduled workers bind credentials/config
        # to the store home; owner_profile only preserves management from the creating Web profile.
        if post.get("profile") and execution_home and not (model and provider) and not body.get("no_agent"):
            try:
                from cron.jobs import _main_model_pin

                with _SNAPSHOT_LOCK, scoped_home(Path(execution_home)):
                    profile_provider, profile_model = _main_model_pin()
                if not profile_model:
                    raise ValueError("Profile has no main model configured")
                provider = provider or profile_provider
                model = model or profile_model
            except Exception as exc:  # noqa: BLE001
                raise RpcError(f"Cannot safely resolve cron model for profile {post['profile']!r}", condition="cron_snapshot_failed") from exc
        with _store(home), scoped_home(home):
            try:
                job = jobs.create_job(prompt=body.get("prompt") or "", schedule=body["schedule"], name=body.get("name") or None, deliver=body.get("deliver") or "local",
                                      skills=body.get("skills") or [], model=model, provider=provider, **kwargs)
            except Exception as exc:  # noqa: BLE001
                raise InvalidParams(str(exc)) from exc
            if post:
                job = jobs.update_job(job["id"], post) or job
        return {"job": job_for_api(job)}

    @registry.method("cron.update")
    def update(ctx: CallContext, params: dict) -> dict:
        jobs = _jobs()
        job_id = _job_ref(params)
        body = params.get("updates") or {}
        with _store(profile_home_param(params)):
            updates = {}
            for key, value in body.items():
                if key in ("monitor", "continuity", "repeat"):
                    continue
                if key in ("model", "provider"):
                    updates[key] = value if value else None
                elif key == "profile":
                    updates[key] = value  # ``None`` clears the profile back to the server default
                elif value is not None:
                    updates[key] = value
            current_refs = None
            if "continuity" in body and "context_from" not in body:
                current_refs = (jobs.get_job(job_id) or {}).get("context_from")
            updates.update(_field_updates(body, current_refs))
            try:
                job = jobs.update_job(job_id, updates)
            except ValueError as exc:
                raise InvalidParams(str(exc)) from exc
        if not job:
            raise RpcError("Job not found", condition="not_found")
        return {"job": job_for_api(job)}

    @registry.method("cron.delete")
    def delete(ctx: CallContext, params: dict) -> dict:
        job_id = _job_ref(params)
        with _store(profile_home_param(params)):
            ok = _jobs().remove_job(job_id)
        if not ok:
            raise RpcError("Job not found", condition="not_found")
        return {"ok": True, "job_id": job_id}

    @registry.method("cron.pause")
    def pause(ctx: CallContext, params: dict) -> dict:
        with _store(profile_home_param(params)):
            job = _jobs().pause_job(_job_ref(params), reason=params.get("reason"))
        if not job:
            raise RpcError("Job not found", condition="not_found")
        return {"job": dict(job)}

    @registry.method("cron.resume")
    def resume(ctx: CallContext, params: dict) -> dict:
        with _store(profile_home_param(params)):
            try:
                job = _jobs().resume_job(_job_ref(params))
            except ValueError as exc:
                raise RpcError(str(exc), condition="cron_resume_failed") from exc
        if not job:
            raise RpcError("Job not found", condition="not_found")
        return {"job": dict(job)}

    @registry.method("cron.run")
    def run(ctx: CallContext, params: dict) -> dict:
        """Run one job now in a child process; streams ``started`` then returns the outcome."""
        store_home = profile_home_param(params)
        execution_home = Path(params["execution_home"]).expanduser() if params.get("execution_home") else None
        job_id = _job_id(params)
        with _store(store_home):
            job = _jobs().get_job(job_id)
        if not job:
            raise RpcError("Job not found", condition="not_found")
        with _RUNNING_LOCK:
            started = _RUNNING.get(job_id)
            if started is not None:
                return {"job_id": job_id, "status": "already_running", "elapsed": round(time.time() - started, 1)}
            _RUNNING[job_id] = time.time()
        ctx.emit("started", {"job_id": job_id})
        return run_tracked(job, store_home, execution_home, ctx)

    @registry.method("cron.status", requires_agent=False)
    def status(ctx: CallContext, params: dict) -> dict:
        now = time.time()
        with _RUNNING_LOCK:
            running = {jid: round(now - t, 1) for jid, t in _RUNNING.items()}
        job_id = str(params.get("job_id") or "").strip()
        if job_id:
            return {"job_id": job_id, "running": job_id in running, "elapsed": running.get(job_id, 0.0)}
        return {"running": running}

    @registry.method("cron.history")
    def history(ctx: CallContext, params: dict) -> dict:
        job_id = _job_id(params)
        offset = max(0, int(params.get("offset") or 0))
        limit = max(1, min(500, int(params.get("limit") or 50)))
        with _store(profile_home_param(params)):
            out_dir = _jobs().get_cron_output_dir() / job_id
        runs, total = [], 0
        if out_dir.exists():
            files = sorted(out_dir.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)
            total = len(files)
            for f in files[offset: offset + limit]:
                try:
                    st = f.stat()
                    runs.append({"filename": f.name, "size": st.st_size, "modified": st.st_mtime, "usage": _usage_metadata(f.read_text(encoding="utf-8", errors="replace"))})
                except OSError:
                    continue
        return {"job_id": job_id, "runs": runs, "total": total, "offset": offset}

    @registry.method("cron.run_detail")
    def run_detail(ctx: CallContext, params: dict) -> dict:
        job_id = _job_id(params)
        filename = str(params.get("filename") or "")
        if not filename:
            raise InvalidParams("filename required")
        with _store(profile_home_param(params)):
            cron_out = _jobs().get_cron_output_dir()
        path = (cron_out / job_id / filename).resolve()
        if not path.is_relative_to(cron_out.resolve()):
            raise InvalidParams("invalid filename")
        if not path.exists():
            raise RpcError("run not found", condition="not_found")
        content = path.read_text(encoding="utf-8", errors="replace")
        return {"job_id": job_id, "filename": filename, "content": content, "snippet": _snippet(content), "usage": _usage_metadata(content)}

    @registry.method("cron.output")
    def output(ctx: CallContext, params: dict) -> dict:
        job_id = _job_id(params)
        try:
            limit = max(1, min(500, int(params.get("limit") or 5)))
        except (TypeError, ValueError):
            limit = 5
        with _store(profile_home_param(params)):
            out_dir = _jobs().get_cron_output_dir() / job_id
        outputs = []
        if out_dir.exists():
            for f in sorted(out_dir.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)[:limit]:
                try:
                    outputs.append({"filename": f.name, "content": _content_window(f.read_text(encoding="utf-8", errors="replace"))})
                except OSError:
                    continue
        return {"job_id": job_id, "outputs": outputs}

    @registry.method("cron.delivery_options", requires_agent=False)
    def delivery_options(ctx: CallContext, params: dict) -> dict:
        known: frozenset = frozenset()
        for module_name in ("cron.scheduler_delivery", "cron.scheduler"):
            try:
                module = importlib.import_module(module_name)
            except Exception:  # noqa: BLE001
                continue
            candidates = getattr(module, "_KNOWN_DELIVERY_PLATFORMS", None)
            if candidates:
                known = frozenset(candidates)
                break
        platforms = [{"value": "local", "label": "Local (save output only)"}, {"value": "origin", "label": "Origin (reply to creator)"}]
        platforms.extend({"value": name, "label": name.capitalize()} for name in sorted(known))
        return {"platforms": platforms}
