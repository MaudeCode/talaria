"""TAL-1716: run listings stay bounded however many run files a job has written."""

from __future__ import annotations

import builtins
import contextlib
import io
import os
import types

import pytest

from talaria_sidecar.methods import cron

HEAD_LIMIT = 4096
JOB = "job-1"


@pytest.fixture
def run_dir(tmp_path):
    path = tmp_path / "cron" / "output" / JOB
    path.mkdir(parents=True)
    return path


@pytest.fixture
def methods(monkeypatch, tmp_path, run_dir) -> dict:
    jobs = types.SimpleNamespace(use_cron_store=lambda home: contextlib.nullcontext(), get_cron_output_dir=lambda: run_dir.parent)
    monkeypatch.setattr(cron, "_jobs", lambda: jobs)
    registered: dict = {}

    class Registry:
        def method(self, name, **kwargs):
            return lambda fn: registered.setdefault(name, fn)

    cron.register(Registry())
    return registered


@pytest.fixture
def reads(monkeypatch, run_dir) -> dict:
    """Bytes or characters each run file handed out, through either ``open`` a reader can reach."""
    seen: dict[str, int] = {}
    real_open = io.open

    def spying_open(file, *args, **kwargs):
        handle = real_open(file, *args, **kwargs)
        if not str(file).startswith(str(run_dir)) or "r" not in (args[0] if args else kwargs.get("mode", "r")):
            return handle
        name = os.path.basename(str(file))
        seen.setdefault(name, 0)
        real_read = handle.read

        class Spy:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                handle.close()

            def read(self, *read_args):
                data = real_read(*read_args)
                seen[name] += len(data)
                return data

        return Spy()

    monkeypatch.setattr(builtins, "open", spying_open)
    monkeypatch.setattr(io, "open", spying_open)
    return seen


def write_run(run_dir, name: str, modified: int, text: str) -> None:
    path = run_dir / name
    path.write_text(text, encoding="utf-8")
    os.utime(path, (modified, modified))


def params(tmp_path, **extra) -> dict:
    return {"profile_home": str(tmp_path), "job_id": JOB, **extra}


def test_history_of_a_thousand_runs_reads_one_page_and_at_most_the_head_of_each(methods, reads, run_dir, tmp_path) -> None:
    body = "**Model:** head-model\n\n## Response\n\n" + "x" * (HEAD_LIMIT * 4)
    for index in range(1000):
        write_run(run_dir, f"run-{index:04}.md", 1_000_000 + index, body)

    result = methods["cron.history"](None, params(tmp_path, offset=10, limit=5))

    assert [run["filename"] for run in result["runs"]] == [f"run-{989 - index:04}.md" for index in range(5)]
    assert result["total"] == 1000 and result["offset"] == 10
    assert result["runs"][0]["usage"] == {"model": "head-model"}
    assert result["runs"][0]["size"] == len(body)
    assert result["runs"][0]["modified"] == 1_000_989
    assert len(reads) <= 15
    assert max(reads.values()) <= HEAD_LIMIT


def test_history_ignores_a_header_line_the_read_limit_cuts(methods, run_dir, tmp_path) -> None:
    prefix = "**Model:** kept\n" + "p" * (HEAD_LIMIT - len("**Model:** kept\n") - len("**Provider:** par") - 1) + "\n"
    write_run(run_dir, "cut.md", 1, prefix + "**Provider:** partial-name\n\n## Response\n\nanswer\n")

    assert methods["cron.history"](None, params(tmp_path))["runs"][0]["usage"] == {"model": "kept"}


@pytest.mark.parametrize("method", ["cron.history", "cron.output"])
def test_a_job_that_never_ran_has_no_runs(method, methods, run_dir, tmp_path) -> None:
    run_dir.rmdir()
    assert methods[method](None, params(tmp_path)).get("runs" if method == "cron.history" else "outputs") == []


def test_output_returns_only_the_newest_runs_and_skips_other_files(methods, run_dir, tmp_path) -> None:
    write_run(run_dir, "old.md", 1, "old")
    write_run(run_dir, "new.md", 3, "new")
    write_run(run_dir, "middle.md", 2, "middle")
    write_run(run_dir, "notes.txt", 4, "not a run")

    outputs = methods["cron.output"](None, params(tmp_path, limit=2))["outputs"]

    assert [(row["filename"], row["content"]) for row in outputs] == [("new.md", "new"), ("middle.md", "middle")]
