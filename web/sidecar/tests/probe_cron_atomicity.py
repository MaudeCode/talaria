"""TAL-1623: real cron.create and cron.resume against the installed Agent store, held at event barriers.

``create``: Create is held between its two Agent writes while cron.list, cron.get and the run lookup read the store.
No reader may observe the job without the requested ownership/profile/notification fields, and a refused second
write leaves no job. ``resume``: Resume is held after it derived ``next_run_at`` while an external Agent writer edits
the schedule; the saved schedule and ``next_run_at`` must describe the same job state. Every exit releases the store
transaction. Disposable homes only; no job executes."""

from __future__ import annotations

import contextlib
from datetime import datetime, timedelta, timezone
import fcntl
import os
from pathlib import Path
import sys
import threading
import time

sys.path.insert(0, sys.argv[1])
from cron import jobs  # noqa: E402
from talaria_sidecar.errors import RpcError  # noqa: E402
from talaria_sidecar.methods import cron  # noqa: E402

HOLD_S = 10.0
ROOT = Path(os.environ["HERMES_HOME"])
METHODS: dict = {}


class _Registry:
    def method(self, name, **_kwargs):
        def register(fn):
            METHODS[name] = fn
            return fn
        return register


class _Ctx:
    cancelled = False

    def emit(self, event, data) -> None:
        pass


cron.register(_Registry())


class _WatchedLock:
    """The Agent's in-process jobs RLock, reporting which threads had to wait for it."""

    def __init__(self, inner):
        self.inner, self.waiting = inner, {}

    def acquire(self, blocking=True, timeout=-1):
        if self.inner.acquire(False):
            return True
        if (event := self.waiting.get(threading.get_ident())) is not None:
            event.set()
        return self.inner.acquire(blocking, timeout)

    def release(self):
        self.inner.release()

    __enter__ = acquire

    def __exit__(self, *exc):
        self.release()


LOCK = jobs._jobs_file_lock = _WatchedLock(jobs._jobs_file_lock)


class _Reader(threading.Thread):
    """One concurrent reader: it either finishes or reports that it waits on the store transaction."""

    def __init__(self, fn):
        super().__init__(daemon=True)
        self.fn, self.done, self.blocked, self.result, self.error = fn, threading.Event(), threading.Event(), None, None

    def run(self):
        LOCK.waiting[threading.get_ident()] = self.blocked
        try:
            self.result = self.fn()
        except BaseException as exc:  # noqa: BLE001 - reported by the probe
            self.error = exc
        finally:
            self.done.set()

    def settled(self):
        deadline = time.monotonic() + HOLD_S
        while time.monotonic() < deadline:
            if self.done.is_set() or self.blocked.is_set():
                return
            time.sleep(0.005)
        raise AssertionError("reader neither finished nor waited for the store transaction")


def _assert_released(home: Path) -> None:
    assert getattr(jobs._jobs_lock_state, "depth", 0) == 0, "the calling thread still holds the store transaction"
    acquired = []
    other = threading.Thread(target=lambda: acquired.append(LOCK.inner.acquire(timeout=2) and (LOCK.inner.release() or True)))
    other.start()
    other.join(5)
    assert acquired == [True], "the in-process jobs lock was not released"
    with jobs.use_cron_store(home):
        lock_file = jobs._jobs_lock_file()
    if lock_file.exists():
        with open(lock_file, "a+", encoding="utf-8") as fd:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # raises while another descriptor holds the store flock
            fcntl.flock(fd, fcntl.LOCK_UN)


def _stored(home: Path) -> list[dict]:
    with jobs.use_cron_store(home):
        return jobs.load_jobs()


# ── create ──────────────────────────────────────────────────────────────────

def _create_case(label: str, *, named: bool, post: dict, failure: str | None = None) -> None:
    case = ROOT / "create" / label
    store = case / "profiles" / "beta" if named else case / "home"
    store.mkdir(parents=True)
    body = {"schedule": "every 2h", "prompt": "fixture-only", "name": label, "model": "fixture-model", "provider": "fixture-provider", **post}
    if failure == "create":
        body["schedule"] = "not a schedule"
    params = {"profile_home": str(case / "home"), "job": body}
    if named:
        params["execution_home"] = str(store)
    expected = cron.job_for_api(dict(post))
    expected = {key: expected[key] for key in post}

    real_create, real_update = jobs.create_job, jobs.update_job
    between, release, created, dispatched = threading.Event(), threading.Event(), {}, []

    def create_then_hold(*args, **kwargs):
        job = real_create(*args, **kwargs)
        created["id"] = job["id"]
        between.set()
        release.wait(HOLD_S)
        return job

    def update(job_id, updates):
        if failure == "update" and job_id == created.get("id"):
            raise OSError("synthetic second-write failure")
        return real_update(job_id, updates)

    def complete(job) -> bool:
        shaped = cron.job_for_api(job)
        return all(shaped.get(key) == value for key, value in expected.items())

    run_tracked = cron.run_tracked
    jobs.create_job, jobs.update_job = create_then_hold, update
    cron.run_tracked = lambda job, *args, **kwargs: dispatched.append(dict(job)) or {"job_id": job["id"], "status": "captured"}
    creator, readers = _Reader(lambda: METHODS["cron.create"](_Ctx(), params)), []
    try:
        creator.start()
        if failure == "create":
            creator.join(HOLD_S)
            assert isinstance(creator.error, RpcError) and not between.is_set(), creator.error
            assert _stored(store) == [], _stored(store)
            _assert_released(store)
            return
        assert between.wait(HOLD_S), "create never reached its first write"
        job_id = created["id"]
        readers[:] = [
            _Reader(lambda: METHODS["cron.list"](_Ctx(), {"profile_home": str(store)})["jobs"]),
            _Reader(lambda: METHODS["cron.get"](_Ctx(), {"profile_home": str(store), "job_id": job_id})["job"]),
            _Reader(lambda: METHODS["cron.run"](_Ctx(), {"profile_home": str(store), "job_id": job_id})),
        ]
        for reader in readers:
            reader.start()
        for reader in readers:
            reader.settled()
    finally:
        release.set()
        creator.join(HOLD_S)
        for reader in readers:
            reader.join(HOLD_S)
        jobs.create_job, jobs.update_job, cron.run_tracked = real_create, real_update, run_tracked
    listed, got, ran = readers
    for reader in readers:
        assert reader.done.is_set(), f"{label}: a reader never finished"
    seen = [job for job in listed.result if job["id"] == job_id] + ([got.result] if got.result else []) + dispatched
    if failure == "update":
        assert isinstance(creator.error, OSError), creator.error
        assert seen == [], f"{label}: a reader observed the job a refused second write must not leave: {seen}"
        assert isinstance(ran.error, RpcError) and ran.error.data.get("condition") == "not_found", ran.error
        assert _stored(store) == [], f"{label}: a refused second write left a runnable partial job: {_stored(store)}"
    else:
        assert creator.error is None, creator.error
        assert complete(creator.result["job"]), creator.result
        assert all(complete(job) for job in seen), f"{label}: a reader observed the job without {expected}: {seen}"
        assert ran.error is None and (not dispatched or ran.result["status"] == "captured"), ran.error
        assert [job["id"] for job in _stored(store)] == [job_id]
    _assert_released(store)


def create() -> None:
    _create_case("default-no-fields", named=False, post={})
    _create_case("default-one-field", named=False, post={"toast_notifications": False})
    _create_case("default-many-fields", named=False, post={"toast_notifications": False, "owner_profile": "beta"})
    _create_case("named-one-field", named=True, post={"profile": "beta"})
    _create_case("named-many-fields", named=True, post={"profile": "beta", "owner_profile": "alpha", "toast_notifications": False})
    _create_case("create-failure", named=False, post={"toast_notifications": False}, failure="create")
    _create_case("default-second-write-failure", named=False, post={"toast_notifications": False}, failure="update")
    _create_case("named-second-write-failure", named=True, post={"profile": "beta", "owner_profile": "alpha"}, failure="update")


# ── resume ──────────────────────────────────────────────────────────────────

def _paused(home: Path, schedule: str) -> str:
    with jobs.use_cron_store(home):
        job = jobs.create_job(prompt="fixture-only", schedule=schedule, name=f"resume-{schedule}")
        jobs.pause_job(job["id"])
    return job["id"]


def _resume_race(label: str, schedule: str, edited: str, consistent) -> None:
    home = ROOT / "resume" / label
    home.mkdir(parents=True)
    job_id = _paused(home, schedule)
    real_compute, held, release = jobs.compute_next_run, threading.Event(), threading.Event()
    resumer: _Reader

    def compute_then_hold(*args, **kwargs):
        value = real_compute(*args, **kwargs)
        if threading.current_thread() is resumer and not held.is_set():
            held.set()
            release.wait(HOLD_S)
        return value

    def edit():
        with jobs.use_cron_store(home):  # an Agent store writer that never takes a Talaria lock
            return jobs.update_job(job_id, {"schedule": edited})

    jobs.compute_next_run = compute_then_hold
    resumer = _Reader(lambda: METHODS["cron.resume"](_Ctx(), {"profile_home": str(home), "job_id": job_id}))
    editor = _Reader(edit)
    try:
        resumer.start()
        assert held.wait(HOLD_S), f"{label}: resume never derived next_run_at"
        editor.start()
        editor.settled()
    finally:
        release.set()
        resumer.join(HOLD_S)
        editor.join(HOLD_S)
        jobs.compute_next_run = real_compute
    assert resumer.error is None and editor.error is None, (resumer.error, editor.error)
    saved = next(job for job in _stored(home) if job["id"] == job_id)
    assert saved["state"] == "scheduled" and saved["enabled"] is True, saved
    assert consistent(saved), f"{label}: schedule {saved['schedule']} saved with next_run_at {saved['next_run_at']}"
    _assert_released(home)


def _resume_exit(label: str, compute, expect) -> None:
    home = ROOT / "resume" / label
    home.mkdir(parents=True)
    job_id = _paused(home, "2050-01-01T00:00:00+00:00")
    if label == "refusal":
        with jobs.use_cron_store(home):
            jobs.update_job(job_id, {"schedule": "2001-01-01T00:00:00+00:00"})
    real_compute = jobs.compute_next_run
    jobs.compute_next_run = compute or real_compute
    try:
        METHODS["cron.resume"](_Ctx(), {"profile_home": str(home), "job_id": job_id})
    except BaseException as exc:  # noqa: BLE001 - asserted below
        assert expect(exc), f"{label}: {exc!r}"
    else:
        raise AssertionError(f"{label}: resume succeeded")
    finally:
        jobs.compute_next_run = real_compute
    saved = next(job for job in _stored(home) if job["id"] == job_id)
    assert saved["state"] == "paused" and saved["enabled"] is False, saved
    _assert_released(home)


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value)


def resume() -> None:
    feb = "2050-02-01T00:00:00+00:00"
    _resume_race("one-shot", "2050-01-01T00:00:00+00:00", feb,
                 lambda job: _instant(job["schedule"]["run_at"]) == _instant(feb) == _instant(job["next_run_at"]))
    _resume_race("recurring", "every 2h", "every 30d",
                 lambda job: job["schedule"]["minutes"] == 43200 and _instant(job["next_run_at"]) > datetime.now(timezone.utc) + timedelta(days=7))

    def boom(*args, **kwargs):
        raise RuntimeError("synthetic next-run failure")

    _resume_exit("refusal", None, lambda exc: isinstance(exc, RpcError) and exc.data.get("condition") == "cron_resume_failed")
    _resume_exit("exception", boom, lambda exc: isinstance(exc, RuntimeError) and "synthetic" in str(exc))


{"create": create, "resume": resume}[sys.argv[2]]()
print(f"{sys.argv[2]}: ok")
