#!/usr/bin/env python3
"""Print this Actions run attempt's job timeline as a Markdown table (TAL-414).

Each job's queue, start and finish times count from the run attempt's start, so a release run shows its critical
path and every macOS queue wait. Measurement only: it reads the run with the job token (actions: read)."""

import json
import os
import subprocess
from datetime import datetime


def seconds(value, origin):
    return round((datetime.fromisoformat(value.replace("Z", "+00:00")) - origin).total_seconds()) if value else None


def clock(value):
    return "" if value is None else f"{value // 60}:{value % 60:02d}"


def table(run, jobs):
    origin = datetime.fromisoformat(run["run_started_at"].replace("Z", "+00:00"))
    rows = []
    for job in jobs:
        queued, started, finished = (seconds(job.get(key), origin) for key in ("created_at", "started_at", "completed_at"))
        ran = finished - started if job.get("conclusion") != "skipped" and None not in (started, finished) else None
        waited = started - queued if ran is not None and queued is not None else None
        rows.append((started if ran is not None else float("inf"), job["name"], clock(queued), clock(waited),
                     clock(started if ran is not None else None), clock(ran), clock(finished if ran is not None else None),
                     job.get("conclusion") or job.get("status")))
    last = max((seconds(job.get("completed_at"), origin) or 0 for job in jobs), default=0)
    lines = ["### Release timeline", "",
             f"Minutes:seconds from the run attempt's start ({run['run_started_at']}); the last job finished at {clock(last)}.", "",
             "| Job | Queued | Waited | Started | Ran | Finished | Result |", "|---|---|---|---|---|---|---|"]
    lines += ["| " + " | ".join(row[1:]) + " |" for row in sorted(rows, key=lambda row: (row[0], row[1]))]
    return "\n".join(lines) + "\n"


def main():
    path = f"repos/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}/attempts/{os.environ['GITHUB_RUN_ATTEMPT']}"
    run = json.loads(subprocess.check_output(["gh", "api", path], text=True))
    jobs = json.loads(subprocess.check_output(["gh", "api", "--paginate", "--slurp", path + "/jobs?per_page=100"], text=True))
    print(table(run, [job for page in jobs for job in page["jobs"]]), end="")


if __name__ == "__main__":
    main()
