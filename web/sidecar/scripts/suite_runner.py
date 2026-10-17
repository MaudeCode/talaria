"""Bounded, module-preserving pytest subprocesses and verified JUnit aggregation.

Also loaded as a pytest plugin to record collection and actual test starts. Only
the existing pytest dependency is used; orchestration itself is Python stdlib.
"""

from collections import Counter, defaultdict
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import traceback
import xml.etree.ElementTree as ET

WORKERS = "TALARIA_SIDECAR_WORKERS"


def worker_count(value=None):
    if value is None:
        cpu = getattr(os, "process_cpu_count", os.cpu_count)() or 1
        if hasattr(os, "sched_getaffinity"):
            cpu = min(cpu, len(os.sched_getaffinity(0)))
        return min(4, cpu)
    if not value.isdecimal() or int(value) < 1:
        raise ValueError(f"{WORKERS} must be a positive integer")
    return int(value)


def partition(nodeids, count):
    modules = defaultdict(list)
    for nodeid in nodeids:
        modules[nodeid.split("::", 1)[0]].append(nodeid)
    groups = [[] for _ in range(min(count, len(modules)))]
    for _, items in sorted(modules.items(), key=lambda pair: (-len(pair[1]), pair[0])):
        min(groups, key=len).extend(items)
    return groups


# Pytest plugin hooks. The collection and execution journal is independent of
# JUnit, which can contain an extra testcase for a teardown error.
_collected, _started = [], []


def pytest_collection_modifyitems(items):
    _collected.extend(item.nodeid for item in items)
    for item in items:
        item.user_properties.append(("talaria_nodeid", item.nodeid))


def pytest_runtest_logstart(nodeid):
    _started.append(nodeid)


def pytest_sessionfinish():
    Path(os.environ["TALARIA_PYTEST_MANIFEST"]).write_text(json.dumps({"collected": _collected, "started": _started}))


def report_argument(args):
    """Only an unfiltered full suite is parallelized; all other pytest arguments pass through serially."""
    remaining, report = [], None
    iterator = iter(args)
    for arg in iterator:
        if arg in ("--junitxml", "--junit-xml"):
            report = next(iterator)  # pytest would reject a missing value too.
        elif arg.startswith(("--junitxml=", "--junit-xml=")):
            report = arg.split("=", 1)[1]
        else:
            remaining.append(arg)
    return remaining, Path(report).resolve() if report else None


def cleanup(processes, state):
    """Reap workers and kill their process groups even when pytest exited first."""
    for proc in processes:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except PermissionError:
            # If group signaling is refused, kill the leader directly; the
            # ownership scan below still covers its group and detached children.
            proc.kill()
        except ProcessLookupError:
            pass
        proc.wait()
    # Tests can detach a process from pytest's group. Reuse the fixture's
    # disposable-path ownership rule to clean those up on crashes/cancellation.
    listing = subprocess.check_output(["ps", "-eo", "pid=,ppid=,pgid=,args="], text=True)
    rows = [line.split(None, 3) for line in listing.splitlines()]
    parents = {int(row[0]): int(row[1]) for row in rows if len(row) == 4}
    ancestors, pid = set(), os.getpid()
    while pid > 1 and pid not in ancestors:
        ancestors.add(pid)
        pid = parents.get(pid, 0)
    owned = {os.getpid()}
    while True:
        expanded = owned | {pid for pid, parent in parents.items() if parent in owned}
        if expanded == owned:
            break
        owned = expanded
    groups = {proc.pid for proc in processes}
    for row in rows:
        if (len(row) == 4 and (str(state) in row[3] or int(row[0]) in owned
                              or int(row[2]) in groups) and int(row[0]) not in ancestors):
            try:
                os.kill(int(row[0]), signal.SIGKILL)
            except ProcessLookupError:
                pass
    if sys.platform == "linux":
        # The runner is a subreaper, so killed orphan grandchildren can be
        # waited here instead of leaving zombies to a container's PID 1.
        while True:
            try:
                pid, _ = os.waitpid(-1, 0)
                if not pid:
                    break
            except ChildProcessError:
                break


def merge_reports(jobs, destination):
    merged = ET.Element("testsuites")
    durations, modules = [], defaultdict(float)
    for job, expected in jobs:
        manifest = json.loads((job / "manifest.json").read_text())
        if Counter(manifest["collected"]) != Counter(expected) or Counter(manifest["started"]) != Counter(expected):
            raise ValueError(f"incomplete or duplicate test coverage in {job}")
        report = ET.parse(job / "junit.xml").getroot()
        suites = [report] if report.tag == "testsuite" else list(report.findall("testsuite"))
        if not suites:
            raise ValueError(f"missing testsuites in {job}")
        cases = [case for suite in suites for case in suite.findall("testcase")]
        covered = [case.find("properties/property[@name='talaria_nodeid']") for case in cases]
        if any(prop is None for prop in covered) or set(prop.get("value") for prop in covered) != set(expected):
            raise ValueError(f"JUnit coverage differs from collection in {job}")
        by_node = defaultdict(list)
        for case, prop in zip(cases, covered):
            by_node[prop.get("value")].append(case)
        for records in by_node.values():
            # Pytest emits two records only for a call failure plus a teardown
            # error. Repeated successful records would inflate receipt counts.
            if len(records) > 1 and (len(records) != 2 or
                    sum(case.find("failure") is not None for case in records) != 1 or
                    sum(case.find("error") is not None for case in records) != 1):
                raise ValueError(f"duplicate JUnit testcase in {job}")
        for suite in suites:
            cases = suite.findall("testcase")
            counts = {"tests": len(cases), **{key: sum(len(case.findall(tag)) for case in cases)
                      for key, tag in (("failures", "failure"), ("errors", "error"), ("skipped", "skipped"))}}
            if any(int(suite.get(key, "-1")) != count for key, count in counts.items()):
                raise ValueError(f"JUnit counts differ from testcases in {job}")
            merged.append(suite)
            for case in cases:
                duration = float(case.get("time", "0"))
                nodeid = case.find("properties/property[@name='talaria_nodeid']").get("value")
                durations.append((duration, nodeid))
                modules[nodeid.split("::", 1)[0]] += duration
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    ET.ElementTree(merged).write(temporary, encoding="utf-8", xml_declaration=True)
    temporary.replace(destination)
    for label, entries in (("Slow tests", durations), ("Slow modules", [(seconds, name) for name, seconds in modules.items()])):
        print(label + ":", flush=True)
        for seconds, name in sorted(entries, reverse=True)[:10]:
            print(f"  {seconds:.3f}s {name}", flush=True)
    return any(case.find(tag) is not None for case in merged.iter("testcase") for tag in ("failure", "error"))


def run(args):
    count = worker_count(os.environ.get(WORKERS))
    remaining, report = report_argument(args)
    selected = 1 if remaining else count
    print(f"Sidecar pytest: workers={selected}, host budget={os.environ.get('TALARIA_SIDECAR_TOTAL_WORKERS', count)}", flush=True)
    if report:
        report.unlink(missing_ok=True)  # A stale report must never prove this run passed.
    diagnostics = Path(str(report) + ".workers") if report else Path(__file__).resolve().parents[2] / ".codex-tmp/sidecar-pytest"
    diagnostics.mkdir(parents=True, exist_ok=True)
    # A unique invocation directory also prevents reusing evidence on retries.
    output = Path(tempfile.mkdtemp(prefix="run-", dir=diagnostics))
    processes, streams = [], []
    with tempfile.TemporaryDirectory(prefix="talaria-pytest-state-") as directory:
        state = Path(directory)

        def launch(name, arguments):
            job, home = output / name, state / name
            job.mkdir()
            for child in ("home", "tmp"):
                (home / child).mkdir(parents=True)
            env = {**os.environ, "HOME": str(home / "home"), "TMPDIR": str(home / "tmp"),
                   "PYTHONPATH": str(Path(__file__).parent) + os.pathsep + os.environ.get("PYTHONPATH", ""),
                   "TALARIA_PYTEST_MANIFEST": str(job / "manifest.json")}
            log = (job / "output.log").open("w")
            streams.append(log)
            proc = subprocess.Popen([sys.executable, "-m", "pytest", "-p", "suite_runner", "-q",
                                     f"--basetemp={home / 'pytest'}", *arguments], env=env,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            processes.append(proc)
            return job, proc

        try:
            if remaining:
                job, proc = launch("serial", args)
                code = proc.wait()
                print((job / "output.log").read_text(), flush=True)
                return code
            job, collection = launch("collection", ["--collect-only"])
            if collection.wait():
                raise ValueError("pytest collection failed")
            nodeids = json.loads((job / "manifest.json").read_text())["collected"]
            if not nodeids or len(nodeids) != len(set(nodeids)):
                raise ValueError("empty or duplicate pytest collection")
            groups = partition(nodeids, count)
            print(f"Collected {len(nodeids)} cases in {len(groups)} module groups; diagnostics: {output}", flush=True)
            jobs = []
            for index, group in enumerate(groups):
                name = f"worker-{index + 1}"
                job, proc = launch(name, [f"--junitxml={output / name / 'junit.xml'}",
                                         *dict.fromkeys(nodeid.split("::", 1)[0] for nodeid in group)])
                jobs.append((job, group, proc))
            failed = False
            for job, _, proc in jobs:
                code = proc.wait()
                print(f"{job.name}: exit={code}\n{(job / 'output.log').read_text()}", flush=True)
                failed |= code != 0
            report_failed = merge_reports([(job, group) for job, group, _ in jobs], report or output / "junit.xml")
            return int(failed or report_failed)
        finally:
            for sig in (signal.SIGINT, signal.SIGTERM):
                signal.signal(sig, signal.SIG_IGN)
            cleanup(processes, state)
            if (output / "collection/output.log").exists():
                print((output / "collection/output.log").read_text(), flush=True)
            for stream in streams:
                stream.close()
            print(f"Worker diagnostics retained: {output}", flush=True)


def main():
    if sys.platform == "linux":
        import ctypes
        if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0):  # PR_SET_CHILD_SUBREAPER
            raise OSError("could not enable pytest child reaping")

    def interrupt(signum, frame):
        raise InterruptedError(f"sidecar suite interrupted by signal {signum}")

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, interrupt)
    try:
        return run(sys.argv[1:])
    except (Exception, KeyboardInterrupt) as error:
        print(f"Sidecar suite failed: {error}", file=sys.stderr, flush=True)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
