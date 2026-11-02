"""Exercise the shared shell entry point using disposable pytest projects."""

import os
import importlib.util
import json
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import textwrap
import time
import xml.etree.ElementTree as ET

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


@pytest.fixture
def project(tmp_path):
    # A worker name in an ancestor path must not match an inner worker launch.
    root = tmp_path / "worker-2" / "suite"
    (root / "scripts").mkdir(parents=True)
    (root / "tests").mkdir()
    (root / ".venv").symlink_to(sys.prefix, target_is_directory=True)
    for name in ("test.sh", "suite_runner.py"):
        if (SCRIPTS / name).exists():
            shutil.copy(SCRIPTS / name, root / "scripts" / name)
    (root / "pytest.ini").write_text("[pytest]\ntestpaths = tests\naddopts = -p no:cacheprovider\n")
    return root


def run(project, workers, *args):
    return subprocess.run(
        [str(project / "scripts/test.sh"), *args],
        env={**os.environ, "HERMES_WEBUI_AGENT_DIR": str(project), "TALARIA_SIDECAR_WORKERS": str(workers)},
        capture_output=True, text=True, timeout=45,
    )


def review_process_cases(project, reason, *nodeids):
    path = project / 'tests/process_inventory.json'
    inventory = json.loads(path.read_text()) if path.exists() else {'schemaVersion': 1, 'families': {}}
    for nodeid in nodeids:
        family, bracket, case = nodeid.partition('[')
        entry = inventory['families'].setdefault(family, {'layer': 'process', 'reason': reason, 'cases': []})
        entry['cases'].append('[' + case if bracket else '')
    path.write_text(json.dumps(inventory))


@pytest.mark.parametrize('api', ['subprocess', 'os-system'])
def test_policy_rejects_an_unclassified_process_launch(project, api):
    launch = "subprocess.run([sys.executable, '-c', 'pass'], check=True)" if api == 'subprocess' else "os.system('exit 0')"
    (project / 'tests/test_launch.py').write_text(
        'import os, subprocess, sys\ndef test_launch(): ' + launch + '\n')
    result = run(project, 1)
    assert result.returncode != 0, result.stdout + result.stderr
    assert 'unclassified process launch' in result.stdout


def test_policy_allows_boundary_fakes_without_an_agent(project):
    (project / 'tests/test_fake.py').write_text(
        "import subprocess\nfrom unittest.mock import patch\ndef test_fake():\n"
        " with patch('subprocess.run', return_value=subprocess.CompletedProcess(['synthetic'], 0, 'ok')):\n"
        "  assert subprocess.run(['synthetic']).stdout == 'ok'\n")
    result = run(project, 1)
    assert result.returncode == 0, result.stdout + result.stderr


def test_policy_rejects_expanding_a_reviewed_process_family(project):
    (project / 'tests/test_launch.py').write_text(
        "import pytest, subprocess, sys\n@pytest.mark.parametrize('mode', ['reviewed', 'extra'])\n"
        "def test_launch(mode): subprocess.run([sys.executable, '-c', 'pass'], check=True)\n")
    (project / 'tests/process_inventory.json').write_text(json.dumps({
        'schemaVersion': 1,
        'families': {'tests/test_launch.py::test_launch': {
            'layer': 'process', 'reason': 'Proves the harness permits an explicitly classified child process.',
            'cases': ['[reviewed]'],
        }},
    }))
    result = run(project, 1)
    assert result.returncode != 0, result.stdout + result.stderr
    assert 'unreviewed process case' in result.stdout


@pytest.mark.parametrize('release', [None, 'active', 'older'])
def test_layers_execute_each_case_once_and_fast_has_no_agent(project, release):
    (project / 'agent_dependency.json').write_text(json.dumps({'x-talaria': {'releaseTag': 'active'}}))
    (project / 'tests/test_layers.py').write_text(
        "import os, subprocess, sys\n"
        "def test_fast(): assert 'HERMES_WEBUI_AGENT_DIR' not in os.environ\n"
        "def test_process(): subprocess.run([sys.executable, '-c', 'pass'], check=True)\n"
        "def test_compatibility(): assert os.environ['HERMES_WEBUI_AGENT_DIR']\n")
    (project / 'tests/process_inventory.json').write_text(json.dumps({'schemaVersion': 1, 'families': {
        'tests/test_layers.py::test_process': {'layer': 'process', 'reason': 'Proves a reviewed disposable child launch.', 'cases': ['']},
        'tests/test_layers.py::test_compatibility': {'layer': 'compatibility', 'reason': 'Proves compatibility workers receive the selected Agent environment.', 'cases': ['']},
    }}))
    report = project / 'result.xml'
    result = run(project, 4, f'--junitxml={report}', *([f'--agent-release={release}'] if release else []))
    assert result.returncode == 0, result.stdout + result.stderr
    cases = ET.parse(report).findall('.//testcase')
    assert sorted(case.get('name') for case in cases) == (['test_compatibility'] if release == 'older'
        else ['test_compatibility', 'test_fast', 'test_process'])


def test_policy_rejects_losing_a_reviewed_compatibility_case(project):
    (project / 'tests/test_kept.py').write_text('def test_kept(): pass\n')
    (project / 'tests/process_inventory.json').write_text(json.dumps({'schemaVersion': 1, 'families': {
        'tests/test_removed.py::test_removed': {'layer': 'compatibility', 'reason': 'Proves required coverage cannot disappear.', 'cases': ['']},
    }}))
    result = run(project, 1)
    assert result.returncode != 0, result.stdout + result.stderr
    assert 'missing reviewed coverage' in result.stdout


def test_serial_selection_rejects_a_missing_execution_journal(project):
    (project / 'tests/test_serial.py').write_text(
        "import atexit, os\nfrom pathlib import Path\ndef test_ok():\n"
        " atexit.register(lambda: Path(os.environ['TALARIA_PYTEST_MANIFEST']).unlink(missing_ok=True))\n")
    result = run(project, 4, 'tests/test_serial.py')
    assert result.returncode != 0, result.stdout + result.stderr


def test_collection_only_validates_inventory_without_executing_cases(project):
    marker = project / 'executed'
    (project / 'tests/test_collect.py').write_text(
        f'from pathlib import Path\ndef test_collect(): Path({str(marker)!r}).touch()\n')
    result = run(project, 4, '--collect-only')
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'tests/test_collect.py::test_collect' in result.stdout
    assert not marker.exists()


@pytest.mark.parametrize('phase', ['call', 'exit'])
def test_policy_fails_even_when_a_boundary_catches_the_launch_error(project, phase):
    (project / 'tests/test_caught.py').write_text(
        "import atexit, subprocess, sys\ndef attempt():\n"
        " try: subprocess.run([sys.executable, '-c', 'pass'])\n"
        " except RuntimeError: pass\n"
        + ("def test_caught(): atexit.register(attempt)\n" if phase == 'exit' else 'def test_caught(): attempt()\n'))
    result = run(project, 1)
    assert result.returncode != 0, result.stdout + result.stderr
    assert 'unclassified process launch' in result.stdout


def test_policy_rejects_an_unclassified_agent_skip(project):
    (project / 'tests/test_agent.py').write_text(
        "import pytest\n@pytest.mark.skipif(True, reason='pinned Hermes Agent checkout with venv not found')\n"
        "def test_agent(): pass\n")
    result = run(project, 1)
    assert result.returncode != 0, result.stdout + result.stderr
    assert 'unclassified Agent case' in result.stdout


@pytest.mark.parametrize('layer', ['process', 'fast'])
def test_policy_owns_setup_hooks_before_the_fixture_protocol(project, layer):
    (project / 'tests/conftest.py').write_text(
        "import pytest, subprocess, sys\n@pytest.hookimpl(tryfirst=True)\n"
        "def pytest_runtest_setup(item): subprocess.run([sys.executable, '-c', 'pass'], check=True)\n")
    (project / 'tests/test_setup.py').write_text('def test_ok(): pass\n')
    if layer == 'process':
        review_process_cases(project, 'Proves a classified real launch in an early pytest setup hook has its owning case.',
                             'tests/test_setup.py::test_ok')
    result = run(project, 1)
    assert (result.returncode == 0) is (layer == 'process'), result.stdout + result.stderr


@pytest.mark.parametrize('api', ['bind', 'udp'])
def test_policy_rejects_real_network_access_in_fast_cases(project, api):
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
        receiver.bind(('127.0.0.1', 0))
        operation = "server.bind(('127.0.0.1', 0))" if api == 'bind' else f"server.sendto(b'proof', {receiver.getsockname()!r})"
        (project / 'tests/test_network.py').write_text(
            'import socket\ndef test_network():\n'
            ' with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server: ' + operation + '\n')
        result = run(project, 1)
    assert result.returncode != 0, result.stdout + result.stderr
    assert 'unclassified network access' in result.stdout


@pytest.mark.parametrize("workers,modules", [(1, 2), (2, 3), (4, 5), (8, 9), (8, 2)])
def test_independent_modules_overlap(project, workers, modules):
    barrier = project / "barrier"
    barrier.mkdir()
    concurrent = min(workers, modules)
    for index in range(modules):
        (project / f"tests/test_{index}.py").write_text(textwrap.dedent(f"""
            import time, os, json
            from pathlib import Path
            def test_overlap():
                barrier = Path({str(barrier)!r})
                state = {{key: os.environ[key] for key in ('HOME', 'TMPDIR')}}
                state['pid'] = os.getpid()
                (barrier / '{index}').write_text(json.dumps(state))
                deadline = time.monotonic() + 5
                while len(list(barrier.iterdir())) < {concurrent} and time.monotonic() < deadline:
                    time.sleep(.02)
                assert len(list(barrier.iterdir())) >= {concurrent}, 'independent modules never overlapped'
        """))
    result = run(project, workers)
    assert result.returncode == 0, result.stdout + result.stderr
    states = [json.loads(path.read_text()) for path in barrier.iterdir()]
    assert len(states) == modules
    for key in ('HOME', 'TMPDIR', 'pid'):
        assert len({state[key] for state in states}) == concurrent


def test_shards_split_cases_so_each_runs_exactly_once(project):
    # A release checks each Agent in three jobs (TAL-1599): a module's cases spread over the shards, every case runs in
    # exactly one, and each shard's coverage names the whole suite it was dealt from.
    (project / 'tests/test_slow.py').write_text("import pytest\n@pytest.mark.parametrize('n', range(7))\ndef test_case(n): pass\n")
    (project / 'tests/test_one.py').write_text("def test_alone(): pass\n")
    ran, suites = [], []
    for index in (1, 2, 3):
        report = project / f'shard-{index}.xml'
        result = run(project, 2, f'--shard={index}/3', f'--junitxml={report}')
        assert result.returncode == 0, result.stdout + result.stderr
        assert f'for shard {index}/3' in result.stdout
        coverage = json.loads(Path(str(report) + '.coverage.json').read_text())
        assert coverage['shard'] == f'{index}/3'
        assert sorted(coverage['started']) == sorted(coverage['collected'])
        names = [case.find("properties/property[@name='talaria_nodeid']").get('value') for case in ET.parse(report).iter('testcase')]
        assert sorted(names) == sorted(coverage['started'])
        assert sum(name.startswith('tests/test_slow.py') for name in names) in (2, 3)
        ran += names
        suites.append(coverage['suite'])
    assert suites[0] == suites[1] == suites[2]
    assert sorted(ran) == sorted(suites[0]) and len(ran) == 8


@pytest.mark.parametrize("arguments,message", [(('--shard=0/3',), 'shard must be N/M'), (('--shard=4/3',), 'shard must be N/M'),
                                               (('--shard=1/3', '-k', 'one'), 'takes no other selection'),
                                               (('--shard=3/3',), 'selected no cases')],
                         ids=['zero', 'over', 'selector', 'empty'])
def test_invalid_shards_fail(project, arguments, message):
    (project / 'tests/test_cases.py').write_text("def test_one(): pass\ndef test_two(): pass\n")
    result = run(project, 2, *arguments)
    assert result.returncode != 0
    assert message in result.stderr


@pytest.mark.parametrize("value", ["", "0", "-1", "1.5", "abc"])
def test_invalid_worker_count_fails(project, value):
    (project / "tests/test_ok.py").write_text("def test_ok(): pass\n")
    report = project / 'result.xml'
    coverage = Path(str(report) + '.coverage.json')
    report.write_text('<testsuites/>')
    coverage.write_text('{"stale":true}')
    result = run(project, value, f'--junitxml={report}')
    assert result.returncode != 0
    assert "positive integer" in result.stderr
    assert not report.exists() and not coverage.exists()


@pytest.mark.parametrize("selector", [("tests/test_cases.py::test_one",), ("-k", "one"), ("-m", "focus")])
def test_selectors_stay_serial(project, selector):
    (project / "tests/test_cases.py").write_text("import pytest\n@pytest.mark.focus\ndef test_one(): pass\ndef test_two(): pass\n")
    report = project / "result.xml"
    result = run(project, 8, *selector, f"--junitxml={report}")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "workers=1" in result.stdout
    assert len(ET.parse(report).findall(".//testcase")) == 1


def test_merged_outcomes_and_durations(project):
    (project / "tests/test_cases.py").write_text(textwrap.dedent("""
        import pytest
        def test_pass(): pass
        def test_fail(): assert False, 'synthetic failure'
        @pytest.mark.skip(reason='synthetic skip')
        def test_skip(): pass
        @pytest.fixture
        def broken(): raise RuntimeError('synthetic setup failure')
        def test_error(broken): pass
        @pytest.fixture
        def double_broken(request):
            request.addfinalizer(lambda: pytest.fail('synthetic finalizer failure'))
            raise RuntimeError('synthetic setup failure')
        def test_two_setup_errors(double_broken): pass
        @pytest.fixture
        def teardown_error():
            yield
            pytest.fail('synthetic teardown failure')
        def test_call_and_teardown_error(teardown_error): assert False, 'synthetic call failure'
    """))
    (project / "tests/test_other.py").write_text("def test_other(): pass\n")
    report = project / "result.xml"
    result = run(project, 2, f"--junitxml={report}")
    assert result.returncode != 0
    suites = ET.parse(report).findall("testsuite")
    assert {key: sum(int(suite.get(key)) for suite in suites) for key in ('tests', 'failures', 'errors', 'skipped')} == {
        'tests': 8, 'failures': 2, 'errors': 4, 'skipped': 1,
    }
    assert all(float(case.get('time')) >= 0 for suite in suites for case in suite.findall('testcase'))
    assert 'Slow modules:' in result.stdout


@pytest.mark.parametrize("damage", ["crash", "missing", "malformed", "omitted", "duplicate", "junit-count", "junit-coverage", "junit-duplicate"])
def test_partial_evidence_never_succeeds(project, damage):
    source = "import atexit, os, pathlib, json, sys\ndef test_ok():\n"
    if damage == "crash":
        source += "    os._exit(7)\n"
    else:
        edits = {
            "missing": "report.unlink()",
            "malformed": "report.write_text('<broken')",
            "omitted": "data['started'].pop(); manifest.write_text(json.dumps(data))",
            "duplicate": "data['started'] *= 2; manifest.write_text(json.dumps(data))",
            "junit-count": "report.write_text(report.read_text().replace('tests=\"1\"', 'tests=\"2\"'))",
            "junit-coverage": "report.write_text(report.read_text().replace('talaria_nodeid', 'missing_nodeid'))",
            "junit-duplicate": "import xml.etree.ElementTree as ET; tree = ET.parse(report); suite = tree.getroot().find('testsuite'); suite.append(ET.fromstring(ET.tostring(suite.find('testcase')))); suite.set('tests', '2'); tree.write(report)",
        }
        source += textwrap.indent(textwrap.dedent(f"""
            def damage():
                manifest = pathlib.Path(os.environ['TALARIA_PYTEST_MANIFEST'])
                data = json.loads(manifest.read_text())
                report = manifest.parent / 'junit.xml'
                {edits[damage]}
            atexit.register(damage)
        """), "    ")
    (project / "tests/test_cases.py").write_text(source)
    report = project / "result.xml"
    report.write_text('<testsuites/>')
    coverage = Path(str(report) + '.coverage.json')
    coverage.write_text('{"stale":true}')
    result = run(project, 2, f"--junitxml={report}")
    assert result.returncode != 0, result.stdout + result.stderr
    assert not report.exists(), "partial or stale evidence was published"
    assert not coverage.exists(), 'stale coverage survived the failed invocation'
    assert list(Path(str(report) + '.workers').glob('run-*/worker-*/output.log'))


def test_collection_failure_starts_no_workers(project):
    (project / "tests/test_bad.py").write_text("raise RuntimeError('cannot collect this module')\n")
    result = run(project, 4)
    assert result.returncode != 0
    assert "pytest collection failed" in result.stderr
    assert not list((project.parent / '.codex-tmp').glob('**/worker-*'))


def wait_for(path, process):
    deadline = time.monotonic() + 10
    while not path.exists() and process.poll() is None and time.monotonic() < deadline:
        time.sleep(.02)
    assert path.exists(), process.communicate(timeout=10)


def process_is_live(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
    return result.returncode == 0 and not result.stdout.strip().startswith('Z')


def project_pids(root):
    listing = subprocess.run(['ps', '-ww', '-eo', 'pid=,args='], capture_output=True, text=True).stdout
    return [int(pid) for pid, args in (line.split(None, 1) for line in listing.splitlines() if ' ' in line.strip())
            if str(root) in args and int(pid) != os.getpid()]


def hide_proc_children(project):
    (project / 'sitecustomize.py').write_text(textwrap.dedent("""
        import pathlib
        original = pathlib.Path.read_text
        def read_text(path, *args, **kwargs):
            if str(path).startswith('/proc/self/task/') and path.name == 'children':
                raise FileNotFoundError('optional kernel children entry unavailable')
            return original(path, *args, **kwargs)
        pathlib.Path.read_text = read_text
    """))


# 'poll' lands SIGTERM inside Popen.poll's `except OSError` window, as a busy CI runner can.
@pytest.mark.parametrize('failure', ['cancel', 'startup', 'poll'])
@pytest.mark.parametrize('proc_entry', ['present', pytest.param('missing', marks=pytest.mark.skipif(sys.platform != 'linux', reason='Linux proc fallback'))])
def test_workers_and_detached_children_cleaned_on_abort(project, failure, proc_entry):
    review_process_cases(project, 'Proves runner cancellation/startup failure reaps actual detached children while another worker starts.',
                         'tests/test_a.py::test_child', 'tests/test_b.py::test_other')
    if proc_entry == 'missing':
        hide_proc_children(project)
    pidfile = project / 'child.pid'
    observed = project / 'parent-observed-child'
    (project / 'tests/test_a.py').write_text(textwrap.dedent(f"""
        import subprocess, sys, pathlib, time
        def test_child(tmp_path):
            child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)', str(tmp_path)], start_new_session=True)
            pidfile = pathlib.Path({str(pidfile)!r})
            temporary = pidfile.with_suffix('.tmp')
            temporary.write_text(str(child.pid))
            temporary.replace(pidfile)
            time.sleep(60)
    """))
    (project / 'tests/test_b.py').write_text("def test_other(): pass\n")
    # Hold startup failure until the parent has observed worker 1's live child.
    wrapper = project / 'scripts/abort.py'
    wrapper.write_text(textwrap.dedent(f"""
        import os, signal, sys
        from pathlib import Path
        if {failure!r} == 'poll':
            # subprocess binds waitpid at import, so fault it before the runner loads.
            assert 'subprocess' not in sys.modules
            real_waitpid = os.waitpid
            def waitpid(pid, options):
                result = real_waitpid(pid, options)
                if Path({str(observed)!r}).exists() and sys._getframe(1).f_code.co_name == '_internal_poll':
                    signal.raise_signal(signal.SIGTERM)
                return result
            os.waitpid = waitpid
        import suite_runner as runner, time
        if {proc_entry!r} == 'missing':
            try:
                Path('/proc/self/task/' + str(runner.os.getpid()) + '/children').read_text()
            except FileNotFoundError:
                pass
            else:
                raise AssertionError('optional proc entry fault was not installed')
        original = runner.subprocess.Popen
        def launch(command, **kwargs):
            if any(arg.startswith('--junitxml=') and Path(arg.split('=', 1)[1]).parent.name == 'worker-2' for arg in command):
                deadline = time.monotonic() + 10
                while not Path({str(observed)!r}).exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                assert Path({str(observed)!r}).exists(), 'parent never observed the live child'
                raise OSError('synthetic startup failure')
            return original(command, **kwargs)
        if {failure!r} == 'startup':
            runner.subprocess.Popen = launch
        raise SystemExit(runner.main())
    """))
    proc = subprocess.Popen([sys.executable, str(wrapper)], cwd=project,
                            env={**os.environ, 'TALARIA_SIDECAR_WORKERS': '2',
                                 'PYTHONPATH': str(project) + os.pathsep + os.environ.get('PYTHONPATH', '')},
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    try:
        wait_for(pidfile, proc)
        child = int(pidfile.read_text())
        assert process_is_live(child)
        observed.touch()
        if failure == 'cancel':
            proc.send_signal(signal.SIGTERM)
        try:
            output = proc.communicate(timeout=15)[0]
        except subprocess.TimeoutExpired as expired:
            pytest.fail(f'runner ignored the abort: {expired.output}')
        assert proc.returncode != 0, output
        assert 'worker-1/output.log' in output, 'aborted worker diagnostics were not retained in the run output'
        deadline = time.monotonic() + 5
        while process_is_live(child) and time.monotonic() < deadline:
            time.sleep(.02)
        assert not process_is_live(child), output
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            # Workers run in their own sessions; stop them so a hang reports one failure.
            for pid in project_pids(project.parent):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if pidfile.exists() and process_is_live(int(pidfile.read_text())):
            os.kill(int(pidfile.read_text()), signal.SIGKILL)


@pytest.mark.parametrize('mocked_api', ['Popen', 'check_output'])
def test_cleanup_fixture_runs_after_subprocess_mocks_are_restored(project, mocked_api):
    review_process_cases(project, 'Proves the real process scan runs after subprocess mocks unwind and cache state stays test-local.',
                         'tests/test_mocks.py::test_mock', 'tests/test_mocks.py::test_next_cache')
    shutil.copy(SCRIPTS.parent / 'tests/conftest.py', project / 'tests/conftest.py')
    (project / 'tests/test_mocks.py').write_text(textwrap.dedent(f"""
        import subprocess, sys, types
        chat = types.ModuleType('talaria_sidecar.methods.chat')
        chat._AGENT_CACHE = {{'previous': object()}}
        sys.modules[chat.__name__] = chat
        def test_mock(monkeypatch):
            assert not chat._AGENT_CACHE
            chat._AGENT_CACHE['current'] = object()
            def mocked(*args, **kwargs):
                raise AssertionError('subprocess mock survived into process cleanup')
            monkeypatch.setattr(subprocess, {mocked_api!r}, mocked)
        def test_next_cache():
            assert not chat._AGENT_CACHE
    """))
    result = run(project, 1)
    assert result.returncode == 0, result.stdout + result.stderr


def test_cleanup_fixture_leaves_sibling_child_alive_and_detects_own_leak(project):
    review_process_cases(project, 'Proves real leak detection kills owned children and preserves children belonging to a concurrent worker.',
        'tests/test_a.py::test_own_child', 'tests/test_a.py::test_leak',
        'tests/test_b.py::test_sibling', 'tests/test_b.py::test_after_sibling_cleanup')
    # Exercise the real basetemp-scanning fixture, without another harness.
    shutil.copy(SCRIPTS.parent / 'tests/conftest.py', project / 'tests/conftest.py')
    ready, finished, pidfile = (project / name for name in ('ready', 'finished', 'child.pid'))
    (project / 'tests/test_a.py').write_text(textwrap.dedent(f"""
        import os, subprocess, sys, pathlib, time
        def start_child(tmp_path):
            # GNU readline changes C environ without updating Python's mapping.
            os.putenv('COLUMNS', '80')
            started = tmp_path / 'child-started'
            child = subprocess.Popen([sys.executable, '-c', 'import pathlib, sys, time; pathlib.Path(sys.argv[1]).touch(); time.sleep(60)', str(started)])
            deadline = time.monotonic() + 10
            while not started.exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(.02)
            assert started.exists() and child.poll() is None, 'child did not finish startup'
            return child
        def test_own_child(tmp_path):
            child = start_child(tmp_path)
            pathlib.Path({str(pidfile)!r}).write_text(str(child.pid))
            pathlib.Path({str(ready)!r}).touch()
            deadline = time.monotonic() + 10
            while not pathlib.Path({str(finished)!r}).exists() and time.monotonic() < deadline:
                time.sleep(.02)
            assert pathlib.Path({str(finished)!r}).exists()
            assert child.poll() is None, 'sibling fixture killed this worker child'
            child.terminate()
            child.wait()
        def test_leak(tmp_path):
            start_child(tmp_path)
    """))
    (project / 'tests/test_b.py').write_text(textwrap.dedent(f"""
        import pathlib, time
        def test_sibling():
            deadline = time.monotonic() + 10
            while not pathlib.Path({str(ready)!r}).exists() and time.monotonic() < deadline:
                time.sleep(.02)
            assert pathlib.Path({str(ready)!r}).exists()
        def test_after_sibling_cleanup():
            pathlib.Path({str(finished)!r}).touch()
    """))
    result = run(project, 2, f'--junitxml={project / "result.xml"}')
    assert result.returncode != 0, result.stdout + result.stderr
    assert 'processes outlived the test' in result.stdout
    assert 'sibling fixture killed' not in result.stdout
    assert not process_is_live(int(pidfile.read_text()))


@pytest.mark.skipif(sys.platform != 'linux', reason='Linux subreaper ownership')
@pytest.mark.parametrize('proc_entry', ['present', 'missing'])
def test_exited_orphans_are_reaped_while_worker_runs(project, proc_entry):
    review_process_cases(project, 'Proves actual Linux orphan adoption and child reaping with and without the proc children entry.',
                         'tests/test_orphan.py::test_orphan')
    if proc_entry == 'missing':
        hide_proc_children(project)
    child = "import pathlib, sys, time\nrelease = pathlib.Path(sys.argv[1])\nwhile not release.exists(): time.sleep(.01)\n"
    parent = f"import subprocess, sys\nchild = subprocess.Popen([sys.executable, '-c', {child!r}, sys.argv[1]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\nprint(child.pid, flush=True)\n"
    (project / 'tests/test_orphan.py').write_text(textwrap.dedent(f"""
        import os, subprocess, sys, time
        def test_orphan(tmp_path):
            release = tmp_path / 'release'
            # Waiting for the parent to exit establishes orphan adoption before release.
            pid = int(subprocess.check_output([sys.executable, '-c', {parent!r}, str(release)], text=True))
            release.touch()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(.02)
            else:
                raise AssertionError('exited orphan was not reaped during worker execution')
    """))
    result = run(project, 1)
    assert result.returncode == 0, result.stdout + result.stderr


def test_partition_keeps_modules_balanced():
    spec = importlib.util.spec_from_file_location('runner_under_test', SCRIPTS / 'suite_runner.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    nodes = [f'test_{module}.py::test_{case}' for module, count in enumerate([9, 6, 3, 2]) for case in range(count)]
    groups = runner.partition(nodes, 2)
    assert list(map(len, groups)) == [11, 9]
    assert sorted(sum(groups, [])) == sorted(nodes)
    assert runner.partition(nodes, 2) == groups
    assert not set(node.split('::')[0] for node in groups[0]) & set(node.split('::')[0] for node in groups[1])
