#!/usr/bin/env python3
"""The daily Hermes Agent main canary (TAL-211). GitHub Scheduler dispatches .github/workflows/agent-main-canary.yml
once a day, so upstream movement coalesces into one run; it checks the exact commit `main` names then with
`check-agent-compatibility.py --main SHA`, and only when no earlier canary checked that commit.

plan    Resolves Agent main's exact commit and the last canary's state, the newest `agent-main-canary-state`
        artifact another `main` run of this repository uploaded, and prints the GitHub outputs `sha` and `run`.
report  Reads the checker's receipt, writes the next state, and appends the result, its bounded diagnostics and the
        Agent commits since the last canary to the step summary. Exits 1 when the canary failed.

The state keeps the last observed and the last passing Agent commit apart: a failure advances only the observed one.
A passing canary is evidence about unreleased code, never release approval; nothing here pins, promotes or deploys
an Agent. The feature review of the same range is the owner's upstream-release-review skill (TAL-1551).
"""

import argparse
from collections import Counter
import io
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
from xml.etree import ElementTree
import zipfile

AGENT_REPOSITORY = "NousResearch/hermes-agent"
ARTIFACT = "agent-main-canary-state"
SHA = re.compile(r"[0-9a-f]{40}")
LISTED_COMMITS = 50
LISTED_AREAS = 15
LISTED_TESTS = 20
FAILURE_CHARS = 2000
LOG_LINES = 40
PER_PAGE = 100
RETRY = "The state is unchanged, so the next run checks this commit again."


def gh(path):
    return subprocess.run(["gh", "api", "-H", "Accept: application/vnd.github+json", path],
                          capture_output=True, check=True).stdout


def agent_main():
    line = subprocess.check_output(["git", "ls-remote", f"https://github.com/{AGENT_REPOSITORY}.git", "refs/heads/main"],
                                   text=True).split()
    if len(line) != 2 or not SHA.fullmatch(line[0]):
        raise ValueError(f"Agent main did not resolve to a commit: {line!r}")
    return line[0]


def parse_state(raw):
    """A state another run wrote. Anything but exact commits is refused, so a bad artifact cannot steer the summary."""
    state = {"lastObserved": None, "lastObservedResult": None, "lastPassing": None, **json.loads(raw)}
    for key in ("lastObserved", "lastPassing"):
        if state[key] is not None and not SHA.fullmatch(str(state[key])):
            raise ValueError(f"canary state {key} is not an exact commit")
    if state["lastObservedResult"] not in (None, "success", "failure"):
        raise ValueError("canary state lastObservedResult is not success or failure")
    return {key: state[key] for key in ("lastObserved", "lastObservedResult", "lastPassing")}


def state_artifact(artifacts, run_id, repository_id):
    """The newest unexpired state another `main` run of this repository left. A rerun skips its own run's state, so it
    checks the commit again; a fork's pull request run cannot supply one."""
    for artifact in sorted(artifacts, key=lambda item: item["created_at"], reverse=True):
        run = artifact.get("workflow_run") or {}
        if (artifact["name"] == ARTIFACT and not artifact["expired"] and run.get("id") != run_id
                and run.get("head_branch") == "main" and run.get("repository_id") == run.get("head_repository_id") == repository_id):
            return artifact
    return None


def previous_state(repository, run_id, repository_id):
    artifacts = json.loads(gh(f"repos/{repository}/actions/artifacts?name={ARTIFACT}&per_page=100"))["artifacts"]
    artifact = state_artifact(artifacts, run_id, repository_id)
    if artifact is None:
        return parse_state("{}")
    with zipfile.ZipFile(io.BytesIO(gh(f"repos/{repository}/actions/artifacts/{artifact['id']}/zip"))) as archive:
        return parse_state(archive.read("state.json"))


def next_state(previous, sha, passed):
    return {"lastObserved": sha, "lastObservedResult": "success" if passed else "failure",
            "lastPassing": sha if passed else previous["lastPassing"]}


def commit_link(sha):
    return f"[`{sha[:10]}`](https://github.com/{AGENT_REPOSITORY}/commit/{sha})"


def compare_range(base, head):
    """The compare API's first page (counts and files) with at least the newest LISTED_COMMITS commits: pages run
    oldest first, so a range over one page reads its last page and, when that is short, the one before."""
    path = f"repos/{AGENT_REPOSITORY}/compare/{base}...{head}?per_page={PER_PAGE}"
    first = json.loads(gh(path))
    last = math.ceil(first["total_commits"] / PER_PAGE)

    def page(number):
        return first["commits"] if number == 1 else json.loads(gh(f"{path}&page={number}"))["commits"]

    if last > 1:
        commits = page(last)
        if len(commits) < LISTED_COMMITS:
            commits = page(last - 1) + commits
        first["commits"] = commits
    return first


def range_lines(previous, sha, compare):
    """The unreleased Agent change since the last canary: commit subjects, newest first, and the changed areas."""
    base = previous["lastObserved"]
    if base is None:
        return ["No earlier canary: this run starts the range at " + commit_link(sha) + "."]
    if base == sha:
        return ["Agent main has not moved since the last canary."]
    if isinstance(compare, str):
        return [f"The range {commit_link(base)}…{commit_link(sha)} is unavailable: {compare[:300]}"]
    url = f"https://github.com/{AGENT_REPOSITORY}/compare/{base}...{sha}"
    total = compare["total_commits"]
    lines = [f"[{total} commits]({url}) since the last canary at {commit_link(base)}."]
    if compare["status"] != "ahead":
        lines.append(f"Agent main was rewritten: the compare status is `{compare['status']}`, so {commit_link(base)} "
                     "is no longer on its history.")
    commits = compare["commits"][::-1][:LISTED_COMMITS]
    lines += ["", "| Commit | Subject |", "|---|---|"]
    for commit in commits:
        subject = (commit["commit"]["message"].splitlines() or [""])[0][:120].replace("|", "\\|")
        lines.append(f"| {commit_link(commit['sha'])} | {subject} |")
    if total > len(commits):
        lines.append(f"\n{total - len(commits)} older commits are in the [compare view]({url}).")
    areas = Counter(file["filename"].split("/", 1)[0] if "/" in file["filename"] else "(root)" for file in compare["files"])
    if areas:
        shown = ", ".join(f"`{area}` {count}" for area, count in areas.most_common(LISTED_AREAS))
        more = f" and {len(areas) - LISTED_AREAS} more areas" if len(areas) > LISTED_AREAS else ""
        files = f"the first {len(compare['files'])} " if len(compare["files"]) >= 300 else ""
        lines.append(f"\nChanged areas ({files}files per top-level path): {shown}{more}.")
    return lines


def failed_tests(junit):
    """Up to LISTED_TESTS failing case names with the first line of each message."""
    failures = []
    if not junit.is_file():
        return failures
    for case in ElementTree.parse(junit).getroot().iter("testcase"):
        problem = case.find("failure")
        if problem is None:
            problem = case.find("error")
        if problem is not None:
            message = ((problem.get("message") or problem.text or "").strip().splitlines() or [""])[0][:200]
            failures.append(f"{case.get('classname', '')}::{case.get('name', '')}: {message}")
    return failures


def log_tail(log):
    """The last LOG_LINES lines the checker logged before printing its receipt, where a probe, provisioning or suite
    failure ends (its own re-raise after the receipt repeats only the command), within FAILURE_CHARS."""
    if log is None or not log.is_file():
        return ""
    lines = log.read_text(errors="replace").splitlines()
    receipts = [index for index, line in enumerate(lines) if line.startswith('{"kind": ')]
    lines = lines[:receipts[-1]] if receipts else lines
    return "\n".join(line[:300] for line in lines[-LOG_LINES:])[-FAILURE_CHARS:]


def outcome(receipt_path, sha):
    """Whether the receipt is a passing canary of exactly this commit, and why not."""
    if not receipt_path.is_file():
        return False, f"The checker left no receipt: it did not run or was stopped before it finished. {RETRY}", {}
    receipt = json.loads(receipt_path.read_text())
    if (receipt.get("kind"), receipt.get("sourceRevision")) != ("canary", sha):
        return False, f"The receipt is not a canary of this Agent commit. {RETRY}", receipt
    if receipt.get("result") != "success":
        return False, str(receipt.get("failure") or "The checker failed.")[:FAILURE_CHARS], receipt
    return True, None, receipt


def summary(state, sha, passed, failure, receipt, failures, tail, kept, range_text, run_url):
    tests = receipt.get("tests") or {}
    counts = ", ".join(f"{tests[key]} {key}" for key in ("passed", "failed", "skipped") if key in tests) or "none recorded"
    passing = state["lastPassing"]
    lines = [f"## Agent main canary: {'passed' if passed else 'failed'}", "",
             f"Agent main {commit_link(sha)} checked with Python {receipt.get('python') or 'unknown'} against Talaria "
             f"`{(receipt.get('webRevision') or 'unknown')[:10]}`. Sidecar tests: {counts}.",
             f"Last passing Agent main: {commit_link(passing) if passing else 'none yet'}.",
             "This is not release approval: no Agent is pinned, promoted or deployed from it."]
    if not passed:
        # A tilde fence, so backticks in a failure or log line cannot end it.
        lines += ["", "### Failure", "", "~~~~", failure, *(["", "Checker log tail:", tail] if tail else []), "~~~~"]
        if failures:
            lines += ["", f"Failing tests ({min(len(failures), LISTED_TESTS)} of {len(failures)}):", ""]
            lines += [f"- `{line}`" for line in failures[:LISTED_TESTS]]
        if kept:  # A failure before the sidecar suite leaves no JUnit report; one before the checker, no receipt.
            names = ", ".join(kept[:-1]) + " and " + kept[-1] if len(kept) > 1 else kept[0]
            lines.append(f"\nThis run's `agent-main-canary-diagnostics` artifact keeps the {names}: {run_url}")
    return "\n".join([*lines, "", "### Unreleased Agent changes", "", *range_text, ""])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("plan", "report"))
    parser.add_argument("--state-dir", type=Path, required=True,
                        help="plan writes previous.json here; report reads it and writes state.json.")
    parser.add_argument("--sha", help="report: the Agent main commit plan resolved.")
    parser.add_argument("--receipt", type=Path, help="report: the checker's receipt.")
    parser.add_argument("--log", type=Path, help="report: the checker's output, whose tail a failure shows.")
    parser.add_argument("--summary", type=Path, help="report: the file the summary is appended to.")
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True)
    if args.command == "plan":
        previous = previous_state(os.environ["GITHUB_REPOSITORY"], int(os.environ["GITHUB_RUN_ID"]),
                                  int(os.environ["GITHUB_REPOSITORY_ID"]))
        (args.state_dir / "previous.json").write_text(json.dumps(previous) + "\n")
        sha = agent_main()
        unchanged = previous["lastObserved"] == sha
        if unchanged:
            print(f"Agent main is still {sha}, which the last canary checked ({previous['lastObservedResult']}).",
                  file=sys.stderr)
        print(f"sha={sha}\nrun={'false' if unchanged else 'true'}")
        return
    if not args.sha or not SHA.fullmatch(args.sha) or not args.receipt:
        parser.error("report needs --sha with an exact commit and --receipt")
    previous = parse_state((args.state_dir / "previous.json").read_text())
    passed, failure, receipt = outcome(args.receipt, args.sha)
    # Only a receipt for this commit advances the state: a setup failure or a killed checker tested nothing.
    checked = (receipt.get("kind"), receipt.get("sourceRevision")) == ("canary", args.sha)
    state = next_state(previous, args.sha, passed) if checked else previous
    if checked:
        (args.state_dir / "state.json").write_text(json.dumps(state, indent=2) + "\n")
    compare = None
    if previous["lastObserved"] not in (None, args.sha):
        try:
            compare = compare_range(previous["lastObserved"], args.sha)
        except subprocess.CalledProcessError as error:
            compare = (error.stderr or b"").decode(errors="replace").strip() or str(error)
    run_url = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ.get('GITHUB_REPOSITORY', '')}" \
              f"/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"
    junit = args.receipt.with_suffix(".junit.xml")
    kept = [name for name, path in (("receipt", args.receipt), ("JUnit report", junit), ("checker log", args.log))
            if path is not None and path.is_file()]
    text = summary(state, args.sha, passed, failure, receipt, failed_tests(junit), log_tail(args.log), kept,
                   range_lines(previous, args.sha, compare), run_url)
    print(text)
    if args.summary:
        with args.summary.open("a") as handle:
            handle.write(text)
    if not passed:
        print(f"::error title=Agent main canary failed::Agent main {args.sha} failed the compatibility check; "
              "see the run summary.")
        sys.exit(1)


if __name__ == "__main__":
    main()
