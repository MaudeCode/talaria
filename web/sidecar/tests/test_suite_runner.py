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


@pytest.mark.parametrize("workers,modules", [(1, 1), (2, 2), (4, 4), (8, 8), (8, 2)])
def test_independent_modules_overlap(project, workers, modules):
    barrier = project / "barrier"
    barrier.mkdir()
    for index in range(modules):
        (project / f"tests/test_{index}.py").write_text(textwrap.dedent(f"""
            import time, os, json
            from pathlib import Path
            def test_overlap():
                barrier = Path({str(barrier)!r})
                (barrier / '{index}').write_text(json.dumps({{key: os.environ[key] for key in ('HOME', 'TMPDIR')}}))
                deadline = time.monotonic() + 5
                while len(list(barrier.iterdir())) < {modules} and time.monotonic() < deadline:
                    time.sleep(.02)
                assert len(list(barrier.iterdir())) == {modules}, 'independent modules never overlapped'
        """))
    result = run(project, workers)
    assert result.returncode == 0, result.stdout + result.stderr
    states = [json.loads(path.read_text()) for path in barrier.iterdir()]
    for key in ('HOME', 'TMPDIR'):
        assert len({state[key] for state in states}) == modules


@pytest.mark.parametrize("value", ["", "0", "-1", "1.5", "abc"])
def test_invalid_worker_count_fails(project, value):
    (project / "tests/test_ok.py").write_text("def test_ok(): pass\n")
    result = run(project, value)
    assert result.returncode != 0
    assert "positive integer" in result.stderr


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
    result = run(project, 2, f"--junitxml={report}")
    assert result.returncode != 0, result.stdout + result.stderr
    assert not report.exists(), "partial or stale evidence was published"
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


@pytest.mark.parametrize('failure', ['cancel', 'startup'])
def test_workers_and_detached_children_cleaned_on_abort(project, failure):
    pidfile = project / 'child.pid'
    observed = project / 'parent-observed-child'
    (project / 'tests/test_a.py').write_text(textwrap.dedent(f"""
        import subprocess, sys, pathlib, time
        def test_child(tmp_path):
            child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)', str(tmp_path)], start_new_session=True)
            pathlib.Path({str(pidfile)!r}).write_text(str(child.pid))
            time.sleep(60)
    """))
    (project / 'tests/test_b.py').write_text("def test_other(): pass\n")
    # Hold startup failure until the parent has observed worker 1's live child.
    wrapper = project / 'scripts/abort.py'
    wrapper.write_text(textwrap.dedent(f"""
        import suite_runner as runner, time
        from pathlib import Path
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
    proc = subprocess.Popen([sys.executable, str(wrapper)], cwd=project, env={**os.environ, 'TALARIA_SIDECAR_WORKERS': '2'},
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    try:
        wait_for(pidfile, proc)
        child = int(pidfile.read_text())
        assert process_is_live(child)
        observed.touch()
        if failure == 'cancel':
            proc.send_signal(signal.SIGTERM)
        output = proc.communicate(timeout=15)[0]
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
        if pidfile.exists() and process_is_live(int(pidfile.read_text())):
            os.kill(int(pidfile.read_text()), signal.SIGKILL)


def test_cleanup_fixture_leaves_sibling_child_alive_and_detects_own_leak(project):
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
def test_exited_orphans_are_reaped_while_worker_runs(project):
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
