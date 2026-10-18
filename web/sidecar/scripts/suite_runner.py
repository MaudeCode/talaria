"""Bounded, module-preserving pytest subprocesses and verified JUnit aggregation.

Also loaded as a pytest plugin to record collection and actual test starts. Only
the existing pytest dependency is used; orchestration itself is Python stdlib.
"""

from collections import Counter, defaultdict
import atexit
import json
import contextlib
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
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
_collected, _started, _layers = [], [], {}
_inventory, _active_case, _harness_launch = {}, None, False
_launches, _violations = [], []
_active_phase = 'collection'


def pytest_addoption(parser):
    parser.addoption('--talaria-layer', choices=('all', 'fast', 'process', 'compatibility'), default='all')


def pytest_configure(config):
    global _inventory
    path = Path(config.rootpath) / 'tests/process_inventory.json'
    if path.exists():
        data = json.loads(path.read_text())
        if data.get('schemaVersion') != 1 or not isinstance(data.get('families'), dict):
            raise ValueError('invalid process inventory')
        _inventory = data['families']
        for family, entry in _inventory.items():
            if (not isinstance(entry, dict) or entry.get('layer') not in ('process', 'compatibility')
                    or not isinstance(entry.get('reason'), str) or not entry['reason'].strip()
                    or not isinstance(entry.get('cases'), list) or not entry['cases']
                    or any(not isinstance(case, str) or (case and not (case.startswith('[') and case.endswith(']'))) for case in entry['cases'])
                    or len(entry['cases']) != len(set(entry['cases']))):
                raise ValueError(f'invalid process inventory family: {family}')
    sys.addaudithook(_audit_launch)
    def final_policy_check():
        if _violations:
            try:
                pytest_sessionfinish(None)
            finally:
                os._exit(1)
    atexit.register(final_policy_check)


def _audit_launch(event, args):
    if event not in ('subprocess.Popen', 'os.fork', 'os.forkpty', 'os.posix_spawn', 'os.exec',
                     'os.system', 'os.startfile', 'os.startfile/2', 'socket.connect', 'socket.bind',
                     'socket.getaddrinfo', 'socket.gethostbyname', 'socket.gethostbyname_ex',
                     'socket.gethostbyaddr', 'socket.getnameinfo', 'socket.sendto', 'socket.sendmsg'):
        return
    family = (_active_case or '').split('[', 1)[0]
    if family not in _inventory:
        boundary = 'network access' if event.startswith('socket.') else 'process launch'
        violation = f'unclassified {boundary} in {_active_case or "collection"}: {event} {args[:2]!r}'
        _violations.append(violation)
        raise RuntimeError(violation)
    _launches.append({'nodeid': _active_case, 'phase': _active_phase, 'harness': _harness_launch, 'event': event, 'args': repr(args[:2])})


@contextlib.contextmanager
def harness_process_scan():
    global _harness_launch
    previous, _harness_launch = _harness_launch, True
    try:
        yield
    finally:
        _harness_launch = previous


def pytest_runtest_logreport(report):
    global _active_case, _active_phase
    _active_phase = {'setup': 'call', 'call': 'teardown', 'teardown': 'collection'}[report.when]
    if report.when == 'teardown':
        _active_case = None


def case_layer(nodeid):
    return _inventory.get(nodeid.split('[', 1)[0], {}).get('layer', 'fast')


def pytest_collection_modifyitems(items, config):
    selected, deselected = [], []
    layer = config.getoption('--talaria-layer')
    for item in items:
        family, bracket, case = item.nodeid.partition('[')
        entry = _inventory.get(family)
        agent = ({'sidecar', 'handshaken'} & set(item.fixturenames) or any(
            mark.kwargs.get('reason') == 'pinned Hermes Agent checkout with venv not found'
            for mark in item.iter_markers('skipif')))
        if agent and case_layer(item.nodeid) != 'compatibility':
            raise ValueError(f'unclassified Agent case: {item.nodeid}')
        if entry and ('[' + case if bracket else '') not in entry['cases']:
            raise ValueError(f'unreviewed process case: {item.nodeid}')
        target = selected if layer == 'all' or layer == case_layer(item.nodeid) else deselected
        target.append(item)
    config.hook.pytest_deselected(items=deselected)
    items[:] = selected
    for item in items:
        item.user_properties.append(("talaria_nodeid", item.nodeid))


def pytest_collection_finish(session):
    _collected.extend(item.nodeid for item in session.items)
    for item in session.items:
        _layers[item.nodeid] = case_layer(item.nodeid)
    if os.environ.get('TALARIA_POLICY_CHECK_ALL') == '1':
        reviewed = {family + case
                    for family, entry in _inventory.items() for case in entry['cases']}
        missing = reviewed - set(_collected)
        if missing:
            raise ValueError(f'missing reviewed coverage: {sorted(missing)}')


def pytest_runtest_logstart(nodeid):
    global _active_case, _active_phase
    _active_case, _active_phase = nodeid, 'setup'
    _started.append(nodeid)


def pytest_sessionfinish(session):
    if _violations:
        print('\n'.join(_violations), file=sys.stderr, flush=True)
        if session is not None:
            session.exitstatus = 1
    if path := os.environ.get('TALARIA_PYTEST_MANIFEST'):
        Path(path).write_text(json.dumps({'collected': _collected, 'started': _started, 'layers': _layers, 'launches': _launches, 'violations': _violations}))


def layer_arguments(args):
    remaining, layer, release = [], 'all', None
    for arg in args:
        if arg.startswith('--layer='):
            layer = arg.split('=', 1)[1]
        elif arg.startswith('--agent-release='):
            release = arg.split('=', 1)[1]
        else:
            remaining.append(arg)
    if layer not in ('all', 'fast', 'process', 'compatibility'):
        raise ValueError('layer must be all, fast, process or compatibility')
    layers = ['fast', 'process', 'compatibility'] if layer == 'all' else [layer]
    if release and layer == 'all':
        pin = Path(__file__).resolve().parents[1] / 'agent_dependency.json'
        active = json.loads(pin.read_text())['x-talaria']['releaseTag']
        if release != active:
            layers = ['compatibility']
    return remaining, layers


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


def reap_orphans(processes, *, terminate=False):
    if sys.platform != "linux":
        return
    # Only adopted children belong to this reaper. Popen must retain the exit
    # statuses of registered collection/workers, including already-dead workers.
    managed = {proc.pid for proc in processes if proc.returncode is None}
    children = Path(f"/proc/self/task/{os.getpid()}/children")
    while True:
        try:
            direct = None if terminate else set(map(int, children.read_text().split()))
        except FileNotFoundError:  # CONFIG_PROC_CHILDREN is optional.
            direct = None
        # During final cleanup, children are exiting and the proc list can omit
        # entries. Use the same fallback snapshot for that discovery too.
        if direct is None:
            direct = {pid for pid, ppid, _, _ in process_snapshot() if ppid == os.getpid()}
        adopted, reaped = direct - managed, False
        for pid in adopted:
            try:
                # The fallback snapshot includes its already-reaped ps child.
                # Confirm wait ownership before signaling any remaining child.
                waited, _ = os.waitpid(pid, os.WNOHANG)
                if terminate and not waited:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    waited, _ = os.waitpid(pid, 0)
                reaped |= bool(waited)
            except ChildProcessError:
                pass
        if not terminate or not reaped:
            return


def wait_for(proc, processes):
    while proc.poll() is None:
        reap_orphans(processes)
        time.sleep(.02)
    reap_orphans(processes)
    return proc.returncode


def process_snapshot():
    # Readline can set native COLUMNS behind os.environ's back. Ownership paths
    # must survive that terminal width in both pytest fixtures and final cleanup.
    with harness_process_scan():
        listing = subprocess.check_output(["ps", "-ww", "-eo", "pid=,ppid=,pgid=,args="], text=True)
    return [(int(row[0]), int(row[1]), int(row[2]), row[3])
            for row in (line.split(None, 3) for line in listing.splitlines()) if len(row) == 4]


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
    rows = process_snapshot()
    parents = {pid: ppid for pid, ppid, _, _ in rows}
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
    for pid, _, pgid, args in rows:
        if (str(state) in args or pid in owned or pgid in groups) and pid not in ancestors:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    reap_orphans(processes, terminate=True)


def merge_reports(jobs, destination):
    merged = ET.Element("testsuites")
    durations, modules, manifests = [], defaultdict(float), []
    for job, expected in jobs:
        manifest = json.loads((job / "manifest.json").read_text())
        if manifest.get('violations'):
            raise ValueError('; '.join(manifest['violations']))
        manifests.append(manifest)
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
    coverage = {'collected': [node for manifest in manifests for node in manifest['collected']],
                'started': [node for manifest in manifests for node in manifest['started']],
                'layers': {node: layer for manifest in manifests for node, layer in manifest.get('layers', {}).items()},
                'launches': [launch for manifest in manifests for launch in manifest.get('launches', [])]}
    coverage_path = Path(str(destination) + '.coverage.json')
    coverage_temporary = coverage_path.with_suffix('.tmp')
    coverage_temporary.write_text(json.dumps(coverage))
    coverage_temporary.replace(coverage_path)
    ET.ElementTree(merged).write(temporary, encoding="utf-8", xml_declaration=True)
    temporary.replace(destination)
    for label, entries in (("Slow tests", durations), ("Slow modules", [(seconds, name) for name, seconds in modules.items()])):
        print(label + ":", flush=True)
        for seconds, name in sorted(entries, reverse=True)[:10]:
            print(f"  {seconds:.3f}s {name}", flush=True)
    return any(case.find(tag) is not None for case in merged.iter("testcase") for tag in ("failure", "error"))


def run(args):
    remaining, report = report_argument(args)
    if report:
        report.unlink(missing_ok=True)  # A stale report must never prove this run passed.
        Path(str(report) + '.coverage.json').unlink(missing_ok=True)
    remaining, layers = layer_arguments(remaining)
    count = worker_count(os.environ.get(WORKERS))
    selected = 1 if remaining else count
    print(f"Sidecar pytest: workers={selected}, host budget={os.environ.get('TALARIA_SIDECAR_TOTAL_WORKERS', count)}", flush=True)
    diagnostics = Path(str(report) + ".workers") if report else Path(__file__).resolve().parents[2] / ".codex-tmp/sidecar-pytest"
    diagnostics.mkdir(parents=True, exist_ok=True)
    # A unique invocation directory also prevents reusing evidence on retries.
    output = Path(tempfile.mkdtemp(prefix="run-", dir=diagnostics))
    processes, streams = [], []
    with tempfile.TemporaryDirectory(prefix="talaria-pytest-state-") as directory:
        state = Path(directory)

        def launch(name, arguments, layer=None, complete=False):
            job, home = output / name, state / name
            job.mkdir()
            for child in ("home", "tmp"):
                (home / child).mkdir(parents=True)
            env = {**os.environ, "HOME": str(home / "home"), "TMPDIR": str(home / "tmp"),
                   "PYTHONPATH": str(Path(__file__).parent) + os.pathsep + os.environ.get("PYTHONPATH", ""),
                   "TALARIA_PYTEST_MANIFEST": str(job / "manifest.json")}
            if layer in ('fast', 'process'):
                env.pop('HERMES_WEBUI_AGENT_DIR', None)
                env.pop('HERMES_WEBUI_PYTHON', None)
            env['TALARIA_TEST_LAYER'] = layer or 'collection'
            env['TALARIA_POLICY_CHECK_ALL'] = '1' if complete else '0'
            log = (job / "output.log").open("w")
            streams.append(log)
            proc = subprocess.Popen([sys.executable, "-m", "pytest", "-p", "suite_runner", "-q",
                                     f"--basetemp={home / 'pytest'}", *arguments], env=env,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            processes.append(proc)
            return job, proc

        try:
            job, collection = launch("collection", [*remaining, "--collect-only"], complete=not remaining)
            if wait_for(collection, processes):
                raise ValueError("pytest collection failed")
            collected = json.loads((job / "manifest.json").read_text())
            nodeids = collected['collected']
            if not nodeids or len(nodeids) != len(set(nodeids)):
                raise ValueError("empty or duplicate pytest collection")
            expected = [node for node in nodeids if collected['layers'][node] in layers]
            if not expected:
                raise ValueError('empty selected layer coverage')
            if any(arg in ('--collect-only', '--collectonly', '--co') for arg in remaining):
                print('\n'.join(expected), flush=True)
                return 0
            print(f"Collected {len(nodeids)} cases; selected {len(expected)} in {layers}; diagnostics: {output}", flush=True)
            jobs = []
            failed = False
            for layer in layers:
                groups = partition([node for node in expected if collected['layers'][node] == layer], selected)
                current = []
                for group in groups:
                    name = f'worker-{len(jobs) + 1}'
                    selection = remaining if remaining else list(dict.fromkeys(node.split('::', 1)[0] for node in group))
                    job, proc = launch(name, [f"--junitxml={output / name / 'junit.xml'}",
                                              f'--talaria-layer={layer}', *selection], layer)
                    jobs.append((job, group, proc))
                    current.append((job, proc))
                for job, proc in current:
                    code = wait_for(proc, processes)
                    print(f'{job.name} ({layer}): exit={code}', flush=True)
                    failed |= code != 0
            if Counter(node for _, group, _ in jobs for node in group) != Counter(expected):
                raise ValueError('missing or duplicate selected layer coverage')
            report_failed = merge_reports([(job, group) for job, group, _ in jobs], report or output / "junit.xml")
            return int(failed or report_failed)
        finally:
            for sig in (signal.SIGINT, signal.SIGTERM):
                signal.signal(sig, signal.SIG_IGN)
            try:
                cleanup(processes, state)
            finally:
                # Release checkouts may be disposable. Keep logs in the run
                # output too, including cancellation and partial startup.
                for stream in streams:
                    stream.close()
                    path = Path(stream.name)
                    print(f"=== {path.parent.name}/output.log ===\n{path.read_text()}", flush=True)
                print(f"Worker diagnostics retained: {output}", flush=True)


def main():
    if sys.argv[1:2] == ['--requires-agent']:
        print(str('compatibility' in layer_arguments(sys.argv[2:])[1]).lower())
        return 0
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
