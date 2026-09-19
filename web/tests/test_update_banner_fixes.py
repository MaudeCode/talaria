"""Tests for update banner fixes — #813 (conflict recovery) and #814 (restart after update).

Covers:
  - conflict error now includes 'conflict: True' flag and actionable git command (#813)
  - successful update returns 'restart_scheduled: True' (#814)
  - _schedule_restart() spawns a daemon thread, does not block (#814)
  - apply_force_update() returns ok on clean reset path (#813)
  - /api/updates/force route exists in routes.py (#813)
  - UI: _showUpdateError and forceUpdate functions exist in ui.js (#813)
  - UI: updateError element and btnForceUpdate element exist in index.html (#813)
  - UI: success toast says 'Restarting' not 'Reloading' (#814)
  - UI: reload timeout bumped to 2500 ms to allow server restart (#814)
"""

import pathlib
import re
import threading
import time
import sys
import os
import io
import json
import subprocess
import types
import functools

import pytest

REPO = pathlib.Path(__file__).parent.parent


def read(rel):
    return (REPO / rel).read_text(encoding='utf-8')


def extract_js_function(src: str, name: str) -> str:
    match = re.search(rf'(async\s+)?function\s+{re.escape(name)}\b', src)
    assert match, f"{name}() not found"
    open_paren = src.index("(", match.start())
    paren_depth = 1
    idx = open_paren + 1
    while paren_depth > 0 and idx < len(src):
        ch = src[idx]
        if ch == "(":
            paren_depth += 1
        elif ch == ")":
            paren_depth -= 1
        idx += 1
    brace = src.index("{", idx)
    depth = 0
    end = None
    for idx in range(brace, len(src)):
        ch = src[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = idx + 1
                break
    assert end is not None, f"{name}() body was not balanced"
    return src[match.start():end]


@pytest.fixture(autouse=True)
def _stub_pycache_purge(monkeypatch):
    """No-op the __pycache__ purge for the update/restart tests in this module.

    _schedule_restart() purges __pycache__ before os.execv() (#3774) so the
    re-exec'd process recompiles freshly-pulled source. The real purge walks
    REPO_ROOT + _AGENT_DIR on disk — slow (~0.4 s on the agent repo's ~17k
    files) and destructive — which blows these tests' tight restart-timing
    budgets and, worse, can delay the daemon thread past monkeypatch teardown
    so it fires the REAL os.execv and corrupts the pytest worker. These tests
    exercise restart coordination/locking, not the purge (which has dedicated
    coverage in test_pycache_purge.py), so stub it to a no-op. The wiring
    (purge happens before execv) is pinned by
    test_schedule_restart_purges_pycache_before_execv, which re-patches with a
    recording spy.
    """
    import api.updates as upd
    monkeypatch.setattr(upd, "_purge_agent_pycache", lambda *a, **k: None)


def _extract_summary_cache_js():
    src = read('static/ui.js')
    function_names = [
        '_summaryStorageByteLength',
        '_summaryCacheEntriesSortedByRecency',
        '_loadStoredUpdateSummaries',
        '_persistGeneratedSummaries',
        '_rememberGeneratedSummary',
    ]
    declarations = [
        line.strip()
        for line in src.splitlines()
        if line.startswith('const WHATS_NEW_SUMMARY_STORAGE_KEY')
        or line.startswith('const WHATS_NEW_SUMMARY_STORAGE_MAX_BYTES')
    ]
    functions = [extract_js_function(src, name) for name in function_names]
    return '\n'.join(declarations + functions)


def _parse_byte_expr(expr):
    expr = expr.strip()
    if re.fullmatch(r"\d+", expr):
        return int(expr)
    if re.fullmatch(r"(?:\d+\s*\*\s*)+\d+", expr):
        result = 1
        for piece in re.split(r"\s*\*\s*", expr):
            result *= int(piece)
        return result
    return None


# ── api/updates.py ────────────────────────────────────────────────────────────

class TestUpdateChecker:
    def test_build_compare_url_requires_all_pieces(self):
        import api.updates as upd

        assert upd._build_compare_url(
            'https://github.com/nesquena/hermes-webui', 'abc1234', 'def5678'
        ) == 'https://github.com/nesquena/hermes-webui/compare/abc1234...def5678'
        assert upd._build_compare_url(None, 'abc1234', 'def5678') is None
        assert upd._build_compare_url('https://github.com/nesquena/hermes-webui', None, 'def5678') is None
        assert upd._build_compare_url('https://github.com/nesquena/hermes-webui', 'abc1234', None) is None

    def test_build_compare_url_rejects_unsafe_remote_urls(self):
        import api.updates as upd

        assert upd._build_compare_url('javascript:alert(1)', 'abc1234', 'def5678') is None
        assert upd._build_compare_url('file:///tmp/hermes-webui', 'abc1234', 'def5678') is None
        assert upd._build_compare_url('https:github.com/nesquena/hermes-webui', 'abc1234', 'def5678') is None
        assert upd._build_compare_url('https://github.com/nesquena/hermes-webui', 'abc1234', 'def5678')

    def test_check_repo_includes_compare_url_from_normalized_remote_and_merge_base(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()

        def fake_run(args, cwd, timeout=10):
            if args[0] == 'fetch':
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[:2] == ['rev-list', '--count']:
                return '2', True
            if args[0] == 'merge-base':
                return 'abcdef1234567890', True
            if args[:3] == ['rev-parse', '--short', 'abcdef1234567890']:
                return 'abcdef1', True
            if args[:3] == ['rev-parse', '--short', 'origin/master']:
                return 'def5678', True
            if args[:2] == ['remote', 'get-url']:
                return 'git@github.com:NousResearch/hermes-agent.git', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        result = upd._check_repo(tmp_path, 'agent')

        assert result['repo_url'] == 'https://github.com/NousResearch/hermes-agent'
        assert result['current_sha'] == 'abcdef1'
        assert result['latest_sha'] == 'def5678'
        assert result['compare_url'] == 'https://github.com/NousResearch/hermes-agent/compare/abcdef1...def5678'

    def test_check_repo_omits_compare_url_when_merge_base_missing(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()

        def fake_run(args, cwd, timeout=10):
            if args[0] == 'fetch':
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[:2] == ['rev-list', '--count']:
                return '2', True
            if args[0] == 'merge-base':
                return 'fatal: no merge base', False
            if args[:3] == ['rev-parse', '--short', 'origin/master']:
                return 'def5678', True
            if args[:2] == ['remote', 'get-url']:
                return 'https://github.com/nesquena/hermes-webui.git', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        result = upd._check_repo(tmp_path, 'webui')

        assert result['current_sha'] is None
        assert result['latest_sha'] == 'def5678'
        assert result['compare_url'] is None

    def test_repo_url_strips_only_dot_git_suffix(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()

        def fake_run(args, cwd, timeout=10):
            if args[0] == 'fetch':
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[:2] == ['rev-list', '--count']:
                return '0', True
            if args[0] == 'merge-base':
                return 'abcdef1234567890', True
            if args[:2] == ['rev-parse', '--short']:
                return 'abcdef1', True
            if args[:2] == ['remote', 'get-url']:
                return 'https://github.com/nesquena/hermes-webui.git', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        result = upd._check_repo(tmp_path, 'webui')

        assert result['repo_url'] == 'https://github.com/nesquena/hermes-webui'

    def test_repo_url_converts_ssh_and_strips_only_dot_git_suffix(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()

        def fake_run(args, cwd, timeout=10):
            if args[0] == 'fetch':
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/main', True
            if args[:2] == ['rev-list', '--count']:
                return '0', True
            if args[0] == 'merge-base':
                return 'abcdef1234567890', True
            if args[:2] == ['rev-parse', '--short']:
                return 'abcdef1', True
            if args[:2] == ['remote', 'get-url']:
                return 'git@github.com:NousResearch/hermes-agent.git', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        result = upd._check_repo(tmp_path, 'agent')

        assert result['repo_url'] == 'https://github.com/NousResearch/hermes-agent'

    def test_repo_url_strips_dot_git_before_trailing_slashes(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()

        def fake_run(args, cwd, timeout=10):
            if args[0] == 'fetch':
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[:2] == ['rev-list', '--count']:
                return '2', True
            if args[0] == 'merge-base':
                return 'abcdef1234567890', True
            if args[:2] == ['rev-parse', '--short']:
                return 'abcdef1', True
            if args[:2] == ['remote', 'get-url']:
                return 'https://github.com/nesquena/hermes-webui.git/', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        result = upd._check_repo(tmp_path, 'webui')

        assert result['repo_url'] == 'https://github.com/nesquena/hermes-webui'

    def test_release_check_ignores_post_release_branch_commits(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()

        def fake_run(args, cwd, timeout=10):
            if args[0] == 'fetch':
                return '', True
            if args[:3] == ['tag', '--list', 'v*']:
                return 'v2026.5.7\nv2026.4.30', True
            if args[:3] == ['describe', '--tags', '--abbrev=0']:
                return 'v2026.5.7', True
            if args[:2] == ['remote', 'get-url']:
                return 'https://github.com/NousResearch/hermes-agent.git', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/main', True
            if args[:2] == ['rev-list', '--count']:
                return '16', True
            if args[0] == 'merge-base':
                return '3800972dd', True
            return '', False

        monkeypatch.setattr(upd, '_run_git', fake_run)
        result = upd._check_repo(tmp_path, 'agent')

        assert result['release_based'] is True
        assert result['current_version'] == 'v2026.5.7'
        assert result['latest_version'] == 'v2026.5.7'
        assert result['behind'] == 0

    def test_release_check_counts_release_gap(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()

        def fake_run(args, cwd, timeout=10):
            if args[0] == 'fetch':
                return '', True
            if args[:3] == ['tag', '--list', 'v*']:
                return 'v0.51.35\nv0.51.34\nv0.51.33', True
            if args[:3] == ['describe', '--tags', '--abbrev=0']:
                return 'v0.51.34', True
            if args == ['merge-base', '--is-ancestor', 'HEAD', 'v0.51.35']:
                return '', True
            if args[:2] == ['remote', 'get-url']:
                return 'https://github.com/nesquena/hermes-webui.git', True
            return '', False

        monkeypatch.setattr(upd, '_run_git', fake_run)
        result = upd._check_repo(tmp_path, 'webui')

        assert result['release_based'] is True
        assert result['current_version'] == 'v0.51.34'
        assert result['latest_version'] == 'v0.51.35'
        assert result['behind'] == 1
        assert result['branch'] == 'v0.51.35'

    def test_detect_agent_version_reads_copied_source_tree(self, tmp_path, monkeypatch):
        import api.updates as upd

        agent_dir = tmp_path / 'hermes-agent'
        package_dir = agent_dir / 'hermes_cli'
        package_dir.mkdir(parents=True)
        (package_dir / '__init__.py').write_text('__version__ = "0.14.0"\n', encoding='utf-8')

        monkeypatch.setattr(upd, '_AGENT_DIR', str(agent_dir))
        monkeypatch.setattr(upd, '_describe_git_version', lambda path: None)
        monkeypatch.setattr(upd, '_detect_agent_version_from_gateway_health', lambda: None)

        assert upd._detect_agent_version() == '0.14.0'

    def test_detect_agent_version_falls_back_to_gateway_health(self, monkeypatch):
        import api.updates as upd

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return b'{"status":"ok","platform":"hermes-agent","version":"0.14.1"}'

        seen = []

        def fake_urlopen(url, timeout=0):
            seen.append((url, timeout))
            return FakeResponse()

        monkeypatch.setattr(upd, '_AGENT_DIR', None)
        monkeypatch.setenv('GATEWAY_HEALTH_URL', 'http://hermes-agent:8642/health')
        monkeypatch.setattr(upd.urllib.request, 'urlopen', fake_urlopen)

        assert upd._detect_agent_version() == '0.14.1'
        assert seen == [('http://hermes-agent:8642/health', 0.75)]


class TestConflictError:
    """#813 — conflict error must include flag + recovery command."""

    def test_conflict_returns_conflict_flag(self, tmp_path, monkeypatch):
        import api.updates as upd

        # Fake a repo with conflict markers in git status output
        (tmp_path / '.git').mkdir()
        conflict_status = 'UU some/file.py'

        calls = []
        def fake_run(args, cwd, timeout=10):
            calls.append(args)
            if args[:2] == ['status', '--porcelain']:
                return conflict_status, True
            if args[0] == 'fetch':
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)

        result = upd.apply_update('webui')
        assert result['ok'] is False
        assert result.get('conflict') is True, "conflict flag must be True"
        assert 'checkout' in result['message'] or 'pull' in result['message'], (
            "conflict message must include recovery command"
        )
        assert 'merge conflict' in result['message'].lower()

    def test_conflict_message_includes_git_command(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()

        def fake_run(args, cwd, timeout=10):
            if args[:2] == ['status', '--porcelain']:
                return 'AA conflict.txt', True
            if args[0] == 'fetch':
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)

        result = upd.apply_update('agent')
        # Message must be actionable — should mention git checkout or pull
        msg = result['message']
        assert 'git' in msg.lower(), f"message should mention git: {msg}"


class TestScheduleRestart:
    """#814 — _schedule_restart must exist and be non-blocking."""

    def test_schedule_restart_exists(self):
        from api.updates import _schedule_restart
        assert callable(_schedule_restart)

    def test_schedule_restart_is_nonblocking(self, monkeypatch):
        """_schedule_restart() must return immediately (spawns daemon thread)."""
        import api.updates as upd

        execv_called = []

        def fake_execv(exe, args):
            execv_called.append((exe, args))

        # Monkeypatch os.execv inside the module's thread closure
        import os as _os
        original_execv = _os.execv

        monkeypatch.setattr(sys, 'platform', 'linux')
        monkeypatch.setattr(upd, '_wait_until_restart_safe', lambda *a, **k: {'restart_blocked': False})
        monkeypatch.setattr(_os, 'execv', fake_execv)

        start = time.monotonic()
        upd._schedule_restart(delay=0.05)
        elapsed = time.monotonic() - start

        assert elapsed < 0.5, f"_schedule_restart must return immediately, took {elapsed:.2f}s"
        # Give the thread time to call execv
        time.sleep(0.2)
        assert execv_called, "_schedule_restart must eventually call os.execv"

    def test_schedule_restart_purges_pycache_before_execv(self, monkeypatch):
        """The restart thread must purge __pycache__ before re-exec (#3774).

        Pins the fix wiring: os.execv() replaces the process image without
        touching on-disk .pyc files, so stale bytecode could otherwise serve
        an old class definition after a self-update. Records the call order of
        _purge_agent_pycache vs os.execv and asserts the purge runs first.
        """
        import api.updates as upd

        events = []

        def spy_purge(repo_dir):
            events.append(("purge", repo_dir))

        def fake_execv(exe, args):
            events.append(("execv", exe))

        # Override the autouse no-op stub with a recording spy.
        monkeypatch.setattr(sys, 'platform', 'linux')
        monkeypatch.setattr(upd, '_wait_until_restart_safe', lambda *a, **k: {'restart_blocked': False})
        monkeypatch.setattr(upd, "_purge_agent_pycache", spy_purge)
        monkeypatch.setattr(os, "execv", fake_execv)

        upd._schedule_restart(delay=0.05)
        time.sleep(0.3)

        kinds = [kind for kind, _ in events]
        assert "purge" in kinds, "_schedule_restart must purge __pycache__"
        assert "execv" in kinds, "_schedule_restart must call os.execv"
        assert kinds.index("purge") < kinds.index("execv"), (
            "__pycache__ purge must happen BEFORE os.execv so the re-exec'd "
            "process recompiles from fresh source"
        )


class TestApplyUpdateRestartSafety:
    """Self-update must not re-exec while chat streams are active."""

    def test_apply_update_refuses_when_stream_active(self, tmp_path, monkeypatch):
        import queue
        import api.updates as upd
        from api.config import STREAMS, STREAMS_LOCK

        (tmp_path / '.git').mkdir()
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        called = []
        monkeypatch.setattr(upd, '_run_git', lambda *a, **k: (called.append(a) or ('', True)))
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: (_ for _ in ()).throw(AssertionError('must not restart')))

        with STREAMS_LOCK:
            old = dict(STREAMS)
            STREAMS.clear()
            STREAMS['stream_active'] = queue.Queue()
        try:
            result = upd.apply_update('webui')
        finally:
            with STREAMS_LOCK:
                STREAMS.clear()
                STREAMS.update(old)

        assert result['ok'] is False
        assert result.get('active_streams') == 1
        assert result.get('restart_blocked') is True
        assert 'active chat stream' in result['message']
        assert called == []

    def test_force_update_refuses_when_stream_active(self, tmp_path, monkeypatch):
        import queue
        import api.updates as upd
        from api.config import STREAMS, STREAMS_LOCK

        (tmp_path / '.git').mkdir()
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        monkeypatch.setattr(upd, '_run_git', lambda *a, **k: (_ for _ in ()).throw(AssertionError('must not run git')))
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: (_ for _ in ()).throw(AssertionError('must not restart')))

        with STREAMS_LOCK:
            old = dict(STREAMS)
            STREAMS.clear()
            STREAMS['stream_active'] = queue.Queue()
        try:
            result = upd.apply_force_update('agent')
        finally:
            with STREAMS_LOCK:
                STREAMS.clear()
                STREAMS.update(old)

        assert result['ok'] is False
        assert result.get('active_streams') == 1
        assert result.get('restart_blocked') is True
        assert 'active chat stream' in result['message']

    def test_apply_update_refuses_when_active_run_without_stream(self, tmp_path, monkeypatch):
        import api.updates as upd
        from api.config import ACTIVE_RUNS, ACTIVE_RUNS_LOCK, STREAMS, STREAMS_LOCK

        (tmp_path / '.git').mkdir()
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        called = []
        monkeypatch.setattr(upd, '_run_git', lambda *a, **k: (called.append(a) or ('', True)))
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: (_ for _ in ()).throw(AssertionError('must not restart')))

        with STREAMS_LOCK:
            old_streams = dict(STREAMS)
            STREAMS.clear()
        with ACTIVE_RUNS_LOCK:
            old_runs = dict(ACTIVE_RUNS)
            ACTIVE_RUNS.clear()
            ACTIVE_RUNS['run_active'] = {'session_id': 's1', 'stream_id': 'missing-stream'}
        try:
            result = upd.apply_update('webui')
        finally:
            with ACTIVE_RUNS_LOCK:
                ACTIVE_RUNS.clear()
                ACTIVE_RUNS.update(old_runs)
            with STREAMS_LOCK:
                STREAMS.clear()
                STREAMS.update(old_streams)

        assert result['ok'] is False
        assert result.get('active_streams') == 0
        assert result.get('active_runs') == 1
        assert result.get('restart_blocked') is True
        assert 'active agent run' in result['message']
        assert called == []

    def test_force_update_refuses_when_active_run_without_stream(self, tmp_path, monkeypatch):
        import api.updates as upd
        from api.config import ACTIVE_RUNS, ACTIVE_RUNS_LOCK, STREAMS, STREAMS_LOCK

        (tmp_path / '.git').mkdir()
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        monkeypatch.setattr(upd, '_run_git', lambda *a, **k: (_ for _ in ()).throw(AssertionError('must not run git')))
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: (_ for _ in ()).throw(AssertionError('must not restart')))

        with STREAMS_LOCK:
            old_streams = dict(STREAMS)
            STREAMS.clear()
        with ACTIVE_RUNS_LOCK:
            old_runs = dict(ACTIVE_RUNS)
            ACTIVE_RUNS.clear()
            ACTIVE_RUNS['run_active'] = {'session_id': 's1', 'stream_id': 'missing-stream'}
        try:
            result = upd.apply_force_update('agent')
        finally:
            with ACTIVE_RUNS_LOCK:
                ACTIVE_RUNS.clear()
                ACTIVE_RUNS.update(old_runs)
            with STREAMS_LOCK:
                STREAMS.clear()
                STREAMS.update(old_streams)

        assert result['ok'] is False
        assert result.get('active_streams') == 0
        assert result.get('active_runs') == 1
        assert result.get('restart_blocked') is True
        assert 'active agent run' in result['message']

    def test_wait_until_restart_safe_waits_for_active_run_to_clear(self, monkeypatch):
        import api.updates as upd

        snapshots = [
            {'restart_blocked': True, 'active_streams': 0, 'active_runs': 1},
            {'restart_blocked': False, 'active_streams': 0, 'active_runs': 0},
        ]
        sleeps = []
        monkeypatch.setattr(upd, '_restart_blocker_snapshot', lambda: snapshots.pop(0))
        monkeypatch.setattr(upd.time, 'sleep', lambda seconds: sleeps.append(seconds))

        result = upd._wait_until_restart_safe(poll_seconds=0.25)

        assert result['restart_blocked'] is False
        assert sleeps == [0.25]


class TestSuccessfulUpdateReturnsRestartScheduled:
    """#814 — successful apply_update must return restart_scheduled: True."""

    def test_apply_update_returns_restart_scheduled(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()

        def fake_run(args, cwd, timeout=10):
            if args[0] == 'fetch':
                return '', True
            if args[0] == 'tag':
                return '', True
            if args[:2] == ['status', '--porcelain']:
                return '', True   # clean tree
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[0] == 'pull':
                return 'Already up to date.', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        # Don't actually restart
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: None)

        result = upd.apply_update('webui')
        assert result['ok'] is True
        assert result.get('restart_scheduled') is True, (
            "successful update must set restart_scheduled: True"
        )

    def test_apply_update_pulls_latest_release_tag_when_updates_are_release_based(
        self, tmp_path, monkeypatch
    ):
        import api.updates as upd

        (tmp_path / '.git').mkdir()
        ran = []

        def fake_run(args, cwd, timeout=10):
            ran.append(args)
            if args[0] == 'fetch':
                return '', True
            if args[0] == 'tag':
                return 'v0.51.106\nv0.51.105\nv0.51.104', True
            if args == ['describe', '--tags', '--abbrev=0']:
                return 'v0.51.105', True
            if args == ['merge-base', '--is-ancestor', 'v0.51.106', 'HEAD']:
                return '', False
            if args[:2] == ['status', '--porcelain']:
                return '', True
            if args[0] == 'pull':
                return 'Updating release tag', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: None)

        result = upd.apply_update('webui')
        assert result['ok'] is True
        assert ['fetch', 'origin', '--quiet', '--tags', '--force'] in ran
        assert ['pull', '--ff-only', 'origin', 'v0.51.106'] in ran
        assert ['rev-parse', '--abbrev-ref', '@{upstream}'] not in ran

    def test_apply_update_falls_back_to_tracking_branch_without_release_tags(
        self, tmp_path, monkeypatch
    ):
        import api.updates as upd

        (tmp_path / '.git').mkdir()
        ran = []

        def fake_run(args, cwd, timeout=10):
            ran.append(args)
            if args[0] == 'fetch':
                return '', True
            if args[0] == 'tag':
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'fork/feature-branch', True
            if args[:2] == ['status', '--porcelain']:
                return '', True
            if args[0] == 'pull':
                return 'Already up to date.', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: None)
        monkeypatch.setattr(
            'api.updates.restart_active_profile_gateway',
            lambda **kwargs: {'status': 'completed', 'message': 'Gateway service restarted successfully'},
        )

        result = upd.apply_update('agent')
        assert result['ok'] is True
        assert ['pull', '--ff-only', 'fork', 'feature-branch'] in ran


class TestApplyForceUpdate:
    """#813 — apply_force_update must reset hard and return ok."""

    def test_apply_force_update_ok(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()
        ran = []

        def fake_run(args, cwd, timeout=10):
            ran.append(args)
            if args[0] == 'fetch':
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[0] == 'checkout':
                return '', True
            if args[0] == 'reset':
                return '', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: None)

        result = upd.apply_force_update('webui')
        assert result['ok'] is True
        assert result.get('restart_scheduled') is True

        git_cmds = [r[0] for r in ran]
        assert 'reset' in git_cmds, "force update must call git reset --hard"
        assert 'checkout' in git_cmds, "force update must call git checkout . to clear conflicts"

    def test_apply_force_update_proceeds_when_clean_fails(self, tmp_path, monkeypatch):
        """#4914 — a `git clean -fd` failure must NOT abort the force update.

        On Windows a reserved-device-name file (nul/con/prn/aux/com1-9/lpt1-9)
        can land in the working tree (e.g. `> nul` under Git Bash) and git can't
        delete it, so `clean -fd` exits non-zero. The reset --hard still applies
        the update, so clean failure must be non-fatal.
        """
        import api.updates as upd

        (tmp_path / '.git').mkdir()
        ran = []

        def fake_run(args, cwd, timeout=10):
            ran.append(args)
            if args[0] == 'fetch':
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[0] == 'checkout':
                return '', True
            if args[0] == 'clean':
                # Simulate the Windows reserved-name failure.
                return "warning: failed to remove nul: Invalid argument", False
            if args[0] == 'reset':
                return '', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: None)

        result = upd.apply_force_update('webui')

        # Clean failed, but reset --hard succeeded → the force update must STILL
        # succeed (clean failure is non-fatal, #4914).
        assert result['ok'] is True, (
            f"force update must not abort on git clean failure (#4914): {result}"
        )
        assert result.get('restart_scheduled') is True
        git_cmds = [r[0] for r in ran]
        assert 'clean' in git_cmds, "force update should still attempt git clean"
        assert 'reset' in git_cmds, (
            "force update must proceed to git reset --hard even after clean failed"
        )

    def test_apply_force_update_rejects_unknown_target(self, tmp_path, monkeypatch):
        import api.updates as upd
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        result = upd.apply_force_update('invalid')
        assert result['ok'] is False


class TestAgentUpdateRequiresGatewayRestart:
    """Agent updates must prove gateway restart before returning ok=True."""

    def test_agent_gateway_restart_retries_one_transient_failure(self, monkeypatch):
        import api.updates as upd

        restart_results = iter([
            {'status': 'failed', 'message': 'Restart failed: bad file descriptor'},
            {'status': 'completed', 'message': 'Gateway service restarted successfully'},
        ])
        restart_calls = []
        sleeps = []

        def fake_restart(*, profile=None):
            restart_calls.append(profile)
            return next(restart_results)

        monkeypatch.setattr(upd, 'restart_active_profile_gateway', fake_restart)
        monkeypatch.setattr(upd.time, 'sleep', sleeps.append)
        monkeypatch.setattr(upd, 'get_active_profile_gateway_running_pid', lambda *, profile=None: 101)

        ok, result = upd._ensure_gateway_restart_for_agent_update()

        assert ok is True
        assert result['status'] == 'completed'
        assert result['retry_attempted'] is True
        assert 'bad file descriptor' in result['initial_failure']
        assert restart_calls == ['default', 'default']
        assert sleeps == [upd._AGENT_GATEWAY_RESTART_RETRY_DELAY_S]

    def test_agent_gateway_restart_retry_busy_stays_fail_closed(self, monkeypatch):
        import api.updates as upd

        restart_results = iter([
            {'status': 'failed', 'message': 'Restart failed: first'},
            {'status': 'busy', 'message': 'Restart already in progress'},
        ])
        sleeps = []
        gateway_pid_calls = []

        monkeypatch.setattr(upd, 'restart_active_profile_gateway', lambda **kwargs: next(restart_results))
        monkeypatch.setattr(upd.time, 'sleep', sleeps.append)
        monkeypatch.setattr(
            upd,
            'get_active_profile_gateway_running_pid',
            lambda *, profile=None: gateway_pid_calls.append(profile) or 101,
        )

        ok, result = upd._ensure_gateway_restart_for_agent_update()

        assert ok is False
        assert result['status'] == 'busy'
        assert result['retry_attempted'] is True
        assert 'first' in result['initial_failure']
        assert sleeps == [upd._AGENT_GATEWAY_RESTART_RETRY_DELAY_S]
        assert gateway_pid_calls == ['default']

    def test_agent_gateway_restart_accepts_verified_process_replacement_after_retry_failure(self, monkeypatch):
        import api.updates as upd

        timeline = []
        restart_results = iter([
            {'status': 'failed', 'message': 'Restart failed: first'},
            {'status': 'failed', 'message': 'Restart failed: retry'},
        ])
        sleeps = []
        gateway_pids = iter([101, 202])

        def fake_restart(*, profile=None):
            timeline.append('restart')
            return next(restart_results)

        def fake_gateway_pid(*, profile=None):
            pid = next(gateway_pids)
            timeline.append(f'pid:{pid}')
            return pid

        monkeypatch.setattr(upd, 'restart_active_profile_gateway', fake_restart)
        monkeypatch.setattr(upd.time, 'sleep', sleeps.append)
        monkeypatch.setattr(upd, 'get_active_profile_gateway_running_pid', fake_gateway_pid)

        ok, result = upd._ensure_gateway_restart_for_agent_update()

        assert ok is True
        assert result['status'] == 'completed'
        assert result['retry_attempted'] is True
        assert result['process_replaced'] is True
        assert 'first' in result['initial_failure']
        assert 'retry' in result['retry_failure']
        assert timeline == ['pid:101', 'restart', 'restart', 'pid:202']
        assert sleeps == [
            upd._AGENT_GATEWAY_RESTART_RETRY_DELAY_S,
            upd._AGENT_GATEWAY_RESTART_RETRY_DELAY_S,
        ]

    def test_agent_gateway_restart_fails_closed_after_retry_and_health_check(self, monkeypatch):
        import api.updates as upd

        restart_results = iter([
            {'status': 'failed', 'message': 'Restart failed: first'},
            {'status': 'failed', 'message': 'Restart failed: retry'},
        ])
        restart_calls = []
        sleeps = []

        def fake_restart(*, profile=None):
            restart_calls.append(profile)
            return next(restart_results)

        monkeypatch.setattr(upd, 'restart_active_profile_gateway', fake_restart)
        monkeypatch.setattr(upd.time, 'sleep', sleeps.append)
        monkeypatch.setattr(upd, 'get_active_profile_gateway_running_pid', lambda *, profile=None: 101)

        ok, result = upd._ensure_gateway_restart_for_agent_update()

        assert ok is False
        assert result['status'] == 'failed'
        assert result['retry_attempted'] is True
        assert 'Restart failed: first' in result['message']
        assert 'Restart failed: retry' in result['message']
        assert restart_calls == ['default', 'default']
        assert sleeps == [
            upd._AGENT_GATEWAY_RESTART_RETRY_DELAY_S,
            upd._AGENT_GATEWAY_RESTART_RETRY_DELAY_S,
        ]

    def test_agent_gateway_restart_default_retry_cannot_use_sticky_named_profile(self, monkeypatch):
        import api.updates as upd

        default_restart_results = iter([
            {'status': 'failed', 'message': 'Restart failed: default first'},
            {'status': 'failed', 'message': 'Restart failed: default retry'},
        ])
        restart_profiles = []

        def fake_restart(*, profile=None):
            effective_profile = profile or 'sticky-work'
            restart_profiles.append(effective_profile)
            if effective_profile == 'sticky-work':
                return {'status': 'completed', 'message': 'wrong profile restarted'}
            return next(default_restart_results)

        monkeypatch.setattr(upd, 'get_active_profile_name', lambda: 'default')
        monkeypatch.setattr(upd, 'restart_active_profile_gateway', fake_restart)
        monkeypatch.setattr(upd.time, 'sleep', lambda seconds: None)
        monkeypatch.setattr(upd, 'get_active_profile_gateway_running_pid', lambda *, profile=None: 101)

        ok, result = upd._ensure_gateway_restart_for_agent_update()

        assert ok is False
        assert restart_profiles == ['default', 'default']
        assert result['status'] == 'failed'
        assert 'default first' in result['message']
        assert 'default retry' in result['message']

    def test_agent_gateway_restart_real_profile_seam_unchanged_default_pid_fails(
        self,
        monkeypatch,
        tmp_path,
    ):
        from api import agent_health, gateway_restart, profiles
        import api.updates as upd

        root_home = tmp_path / ".hermes"
        sticky_home = root_home / "profiles" / "work"
        sticky_home.mkdir(parents=True)
        calls = {"popen": [], "pid_paths": []}

        class FailedRestartProcess:
            returncode = 7

            def communicate(self, timeout=None):
                return "", "restart failed"

        class PathStrictGatewayStatus:
            def get_running_pid(self, pid_path=None, cleanup_stale=False):
                path = pathlib.Path(pid_path) if pid_path is not None else None
                calls["pid_paths"].append(path)
                if path == root_home / "gateway.pid":
                    return 101
                if path == sticky_home / "gateway.pid":
                    return 202
                return None

        def fake_popen(args, stdout=None, stderr=None, text=True, env=None):
            calls["popen"].append((args, dict(env or {})))
            return FailedRestartProcess()

        monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", root_home)
        monkeypatch.setattr(profiles, "_active_profile", "work")
        monkeypatch.setattr(gateway_restart, "_GATEWAY_RESTART_LOCK", threading.Lock())
        monkeypatch.setattr(gateway_restart.shutil, "which", lambda cmd: "/mock/bin/hermes")
        monkeypatch.setattr(gateway_restart.subprocess, "Popen", fake_popen)
        monkeypatch.setattr(agent_health, "_gateway_status_module", lambda: PathStrictGatewayStatus())
        monkeypatch.setattr(upd.time, 'sleep', lambda seconds: None)

        profiles.set_request_profile("default")
        try:
            ok, result = upd._ensure_gateway_restart_for_agent_update()
        finally:
            profiles.clear_request_profile()

        assert ok is False
        assert result["status"] == "failed"
        assert calls["pid_paths"] == [root_home / "gateway.pid", root_home / "gateway.pid"]
        assert [call[0] for call in calls["popen"]] == [
            ["/mock/bin/hermes", "--profile", "default", "gateway", "restart"],
            ["/mock/bin/hermes", "--profile", "default", "gateway", "restart"],
        ]
        assert [call[1]["HERMES_HOME"] for call in calls["popen"]] == [str(root_home), str(root_home)]

    def test_agent_gateway_restart_legacy_implicit_sticky_pid_change_fails_closed(
        self,
        monkeypatch,
        tmp_path,
    ):
        from api import agent_health, gateway_restart, profiles
        import api.updates as upd

        root_home = tmp_path / ".hermes"
        sticky_home = root_home / "profiles" / "work"
        sticky_home.mkdir(parents=True)
        calls = {"popen": [], "implicit_pid": 0}

        class FailedRestartProcess:
            returncode = 7

            def communicate(self, timeout=None):
                return "", "restart failed"

        class LegacyImplicitStickyGatewayStatus:
            def __init__(self):
                self._pids = iter([201, 202])

            def get_running_pid(self, cleanup_stale=False):
                calls["implicit_pid"] += 1
                return next(self._pids)

        def fake_popen(args, stdout=None, stderr=None, text=True, env=None):
            calls["popen"].append((args, dict(env or {})))
            return FailedRestartProcess()

        monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", root_home)
        monkeypatch.setattr(profiles, "_active_profile", "work")
        monkeypatch.setattr(gateway_restart, "_GATEWAY_RESTART_LOCK", threading.Lock())
        monkeypatch.setattr(gateway_restart.shutil, "which", lambda cmd: "/mock/bin/hermes")
        monkeypatch.setattr(gateway_restart.subprocess, "Popen", fake_popen)
        monkeypatch.setattr(agent_health, "_gateway_status_module", LegacyImplicitStickyGatewayStatus)
        monkeypatch.setattr(upd.time, 'sleep', lambda seconds: None)

        profiles.set_request_profile("default")
        try:
            ok, result = upd._ensure_gateway_restart_for_agent_update()
        finally:
            profiles.clear_request_profile()

        assert ok is False
        assert result["status"] == "failed"
        assert calls["implicit_pid"] == 0
        assert [call[0] for call in calls["popen"]] == [
            ["/mock/bin/hermes", "--profile", "default", "gateway", "restart"],
            ["/mock/bin/hermes", "--profile", "default", "gateway", "restart"],
        ]
        assert [call[1]["HERMES_HOME"] for call in calls["popen"]] == [str(root_home), str(root_home)]

    def test_agent_gateway_restart_kwargs_wrapper_pid_change_fails_closed(
        self,
        monkeypatch,
        tmp_path,
    ):
        from api import agent_health, gateway_restart, profiles
        import api.updates as upd

        root_home = tmp_path / ".hermes"
        sticky_home = root_home / "profiles" / "work"
        sticky_home.mkdir(parents=True)
        calls = {"popen": [], "ambient_pid": 0}

        class FailedRestartProcess:
            returncode = 7

            def communicate(self, timeout=None):
                return "", "restart failed"

        class AmbientKwargsGatewayStatus:
            def __init__(self):
                self._pids = iter([201, 202])

            def get_running_pid(self, **kwargs):
                calls["ambient_pid"] += 1
                return next(self._pids)

        def fake_popen(args, stdout=None, stderr=None, text=True, env=None):
            calls["popen"].append((args, dict(env or {})))
            return FailedRestartProcess()

        monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", root_home)
        monkeypatch.setattr(profiles, "_active_profile", "work")
        monkeypatch.setattr(gateway_restart, "_GATEWAY_RESTART_LOCK", threading.Lock())
        monkeypatch.setattr(gateway_restart.shutil, "which", lambda cmd: "/mock/bin/hermes")
        monkeypatch.setattr(gateway_restart.subprocess, "Popen", fake_popen)
        monkeypatch.setattr(agent_health, "_gateway_status_module", AmbientKwargsGatewayStatus)
        monkeypatch.setattr(upd.time, 'sleep', lambda seconds: None)

        profiles.set_request_profile("default")
        try:
            ok, result = upd._ensure_gateway_restart_for_agent_update()
        finally:
            profiles.clear_request_profile()

        assert ok is False
        assert result["status"] == "failed"
        assert calls["ambient_pid"] == 0
        assert [call[0] for call in calls["popen"]] == [
            ["/mock/bin/hermes", "--profile", "default", "gateway", "restart"],
            ["/mock/bin/hermes", "--profile", "default", "gateway", "restart"],
        ]
        assert [call[1]["HERMES_HOME"] for call in calls["popen"]] == [str(root_home), str(root_home)]

    def test_agent_gateway_restart_wrapped_kwargs_pid_change_fails_closed(
        self,
        monkeypatch,
        tmp_path,
    ):
        from api import agent_health, gateway_restart, profiles
        import api.updates as upd

        root_home = tmp_path / ".hermes"
        sticky_home = root_home / "profiles" / "work"
        sticky_home.mkdir(parents=True)
        calls = {"popen": [], "ambient_pid": 0}

        class FailedRestartProcess:
            returncode = 7

            def communicate(self, timeout=None):
                return "", "restart failed"

        def declared_pid_reader(pid_path=None, *, cleanup_stale=True):
            raise AssertionError("wrapped declaration must not be followed")

        class WrappedKwargsGatewayStatus:
            def __init__(self):
                self._pids = iter([201, 202])

            @functools.wraps(declared_pid_reader)
            def get_running_pid(self, **kwargs):
                calls["ambient_pid"] += 1
                return next(self._pids)

        def fake_popen(args, stdout=None, stderr=None, text=True, env=None):
            calls["popen"].append((args, dict(env or {})))
            return FailedRestartProcess()

        monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", root_home)
        monkeypatch.setattr(profiles, "_active_profile", "work")
        monkeypatch.setattr(gateway_restart, "_GATEWAY_RESTART_LOCK", threading.Lock())
        monkeypatch.setattr(gateway_restart.shutil, "which", lambda cmd: "/mock/bin/hermes")
        monkeypatch.setattr(gateway_restart.subprocess, "Popen", fake_popen)
        monkeypatch.setattr(agent_health, "_gateway_status_module", WrappedKwargsGatewayStatus)
        monkeypatch.setattr(upd.time, 'sleep', lambda seconds: None)

        profiles.set_request_profile("default")
        try:
            ok, result = upd._ensure_gateway_restart_for_agent_update()
        finally:
            profiles.clear_request_profile()

        assert ok is False
        assert result["status"] == "failed"
        assert calls["ambient_pid"] == 0
        assert [call[0] for call in calls["popen"]] == [
            ["/mock/bin/hermes", "--profile", "default", "gateway", "restart"],
            ["/mock/bin/hermes", "--profile", "default", "gateway", "restart"],
        ]
        assert [call[1]["HERMES_HOME"] for call in calls["popen"]] == [str(root_home), str(root_home)]

    def test_agent_gateway_restart_wrapped_args_pid_change_fails_closed(
        self,
        monkeypatch,
        tmp_path,
    ):
        from api import agent_health, gateway_restart, profiles
        import api.updates as upd

        root_home = tmp_path / ".hermes"
        sticky_home = root_home / "profiles" / "work"
        sticky_home.mkdir(parents=True)
        calls = {"popen": [], "ambient_pid": 0}

        class FailedRestartProcess:
            returncode = 7

            def communicate(self, timeout=None):
                return "", "restart failed"

        def declared_pid_reader(pid_path=None, *, cleanup_stale=True):
            raise AssertionError("wrapped declaration must not be followed")

        class WrappedArgsGatewayStatus:
            def __init__(self):
                self._pids = iter([201, 202])

            @functools.wraps(declared_pid_reader)
            def get_running_pid(self, *args):
                calls["ambient_pid"] += 1
                return next(self._pids)

        def fake_popen(args, stdout=None, stderr=None, text=True, env=None):
            calls["popen"].append((args, dict(env or {})))
            return FailedRestartProcess()

        monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", root_home)
        monkeypatch.setattr(profiles, "_active_profile", "work")
        monkeypatch.setattr(gateway_restart, "_GATEWAY_RESTART_LOCK", threading.Lock())
        monkeypatch.setattr(gateway_restart.shutil, "which", lambda cmd: "/mock/bin/hermes")
        monkeypatch.setattr(gateway_restart.subprocess, "Popen", fake_popen)
        monkeypatch.setattr(agent_health, "_gateway_status_module", WrappedArgsGatewayStatus)
        monkeypatch.setattr(upd.time, 'sleep', lambda seconds: None)

        profiles.set_request_profile("default")
        try:
            ok, result = upd._ensure_gateway_restart_for_agent_update()
        finally:
            profiles.clear_request_profile()

        assert ok is False
        assert result["status"] == "failed"
        assert calls["ambient_pid"] == 0
        assert [call[0] for call in calls["popen"]] == [
            ["/mock/bin/hermes", "--profile", "default", "gateway", "restart"],
            ["/mock/bin/hermes", "--profile", "default", "gateway", "restart"],
        ]
        assert [call[1]["HERMES_HOME"] for call in calls["popen"]] == [str(root_home), str(root_home)]

    def test_agent_gateway_restart_shifted_positional_only_pid_path_is_bound(
        self,
        monkeypatch,
        tmp_path,
    ):
        from api import agent_health, gateway_restart, profiles
        import api.updates as upd

        root_home = tmp_path / ".hermes"
        sticky_home = root_home / "profiles" / "work"
        sticky_home.mkdir(parents=True)
        calls = {"popen": [], "pid_paths": [], "ambient_pid": 0}

        class FailedRestartProcess:
            returncode = 7

            def communicate(self, timeout=None):
                return "", "restart failed"

        class ShiftedPositionalOnlyGatewayStatus:
            def get_running_pid(self, ambient=None, pid_path=None, /, *, cleanup_stale=True):
                if pid_path is None:
                    calls["ambient_pid"] += 1
                    return 202
                path = pathlib.Path(pid_path)
                calls["pid_paths"].append(path)
                if path == root_home / "gateway.pid":
                    return 101
                return None

        def fake_popen(args, stdout=None, stderr=None, text=True, env=None):
            calls["popen"].append((args, dict(env or {})))
            return FailedRestartProcess()

        monkeypatch.setattr(profiles, "_DEFAULT_HERMES_HOME", root_home)
        monkeypatch.setattr(profiles, "_active_profile", "work")
        monkeypatch.setattr(gateway_restart, "_GATEWAY_RESTART_LOCK", threading.Lock())
        monkeypatch.setattr(gateway_restart.shutil, "which", lambda cmd: "/mock/bin/hermes")
        monkeypatch.setattr(gateway_restart.subprocess, "Popen", fake_popen)
        monkeypatch.setattr(agent_health, "_gateway_status_module", ShiftedPositionalOnlyGatewayStatus)
        monkeypatch.setattr(upd.time, 'sleep', lambda seconds: None)

        profiles.set_request_profile("default")
        try:
            ok, result = upd._ensure_gateway_restart_for_agent_update()
        finally:
            profiles.clear_request_profile()

        assert ok is False
        assert result["status"] == "failed"
        assert calls["ambient_pid"] == 0
        assert calls["pid_paths"] == [root_home / "gateway.pid", root_home / "gateway.pid"]
        assert [call[0] for call in calls["popen"]] == [
            ["/mock/bin/hermes", "--profile", "default", "gateway", "restart"],
            ["/mock/bin/hermes", "--profile", "default", "gateway", "restart"],
        ]
        assert [call[1]["HERMES_HOME"] for call in calls["popen"]] == [str(root_home), str(root_home)]

    def test_agent_gateway_restart_isolated_default_home_omits_profile_flag(
        self,
        monkeypatch,
        tmp_path,
    ):
        from api import agent_health, gateway_restart, profiles
        import api.updates as upd

        base_home = tmp_path / ".hermes"
        isolated_home = base_home / "profiles" / "default"
        isolated_home.mkdir(parents=True)
        calls = {"popen": [], "pid_paths": []}

        class FailedRestartProcess:
            returncode = 7

            def communicate(self, timeout=None):
                return "", "restart failed"

        class PathStrictGatewayStatus:
            def get_running_pid(self, pid_path=None, cleanup_stale=False):
                path = pathlib.Path(pid_path) if pid_path is not None else None
                calls["pid_paths"].append(path)
                if path == isolated_home / "gateway.pid":
                    return 101
                return None

        def fake_popen(args, stdout=None, stderr=None, text=True, env=None):
            calls["popen"].append((args, dict(env or {})))
            return FailedRestartProcess()

        monkeypatch.setattr(profiles, "_INITIAL_HERMES_HOME", str(isolated_home))
        monkeypatch.setattr(profiles, "_INITIAL_ISOLATED_PROFILE_OPT_IN", "1")
        monkeypatch.setattr(gateway_restart, "_GATEWAY_RESTART_LOCK", threading.Lock())
        monkeypatch.setattr(gateway_restart.shutil, "which", lambda cmd: "/mock/bin/hermes")
        monkeypatch.setattr(gateway_restart.subprocess, "Popen", fake_popen)
        monkeypatch.setattr(agent_health, "_gateway_status_module", lambda: PathStrictGatewayStatus())
        monkeypatch.setattr(upd.time, 'sleep', lambda seconds: None)

        ok, result = upd._ensure_gateway_restart_for_agent_update()

        assert ok is False
        assert result["status"] == "failed"
        assert calls["pid_paths"] == [isolated_home / "gateway.pid", isolated_home / "gateway.pid"]
        assert [call[0] for call in calls["popen"]] == [
            ["/mock/bin/hermes", "gateway", "restart"],
            ["/mock/bin/hermes", "gateway", "restart"],
        ]
        assert [call[1]["HERMES_HOME"] for call in calls["popen"]] == [
            str(isolated_home),
            str(isolated_home),
        ]

    def test_apply_update_agent_requires_gateway_restart(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()
        ran = []
        gateway_restarts = []

        def fake_run(args, cwd, timeout=10):
            ran.append(args)
            if args[0] == 'fetch':
                return '', True
            if args[0] == 'tag':
                return '', True
            if args[:2] == ['status', '--porcelain']:
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[0] == 'pull':
                return 'Already up to date.', True
            return '', True

        def fake_gateway_restart(*, profile=None):
            gateway_restarts.append(profile)
            return {'status': 'completed', 'message': 'Gateway service restarted successfully'}

        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: None)
        monkeypatch.setattr('api.updates.restart_active_profile_gateway', fake_gateway_restart)

        result = upd.apply_update('agent')
        assert result['ok'] is True
        assert result['target'] == 'agent'
        assert result['restart_scheduled'] is True
        assert result['gateway_restart'] == 'completed'
        assert gateway_restarts == ['default']

    def test_apply_update_agent_stash_conflict_success_invokes_gateway_restart(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()
        gateway_restarts = []
        ran = []

        def fake_run(args, cwd, timeout=10):
            ran.append(args)
            if args[0] == 'fetch':
                return '', True
            if args[0] == 'tag':
                return '', True
            if args[:2] == ['status', '--porcelain']:
                return 'M file', True
            if args[:2] == ['status', '--porcelain', '--untracked-files=no']:
                return 'M file', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[:2] == ['rev-parse', '--short']:
                return 'abc1234', True
            if args[:2] == ['stash', 'push']:
                return '', True
            if args[:2] == ['stash', 'apply']:
                return '', False
            if args[0] == 'stash':
                return '', True
            if args[:3] == ['reset', '--hard', 'HEAD']:
                return '', True
            if args[0] == 'pull':
                return 'Updating', True
            return '', True

        def fake_gateway_restart(*, profile=None):
            gateway_restarts.append(profile)
            return {'status': 'in_progress', 'message': 'Gateway service restart initiated (in progress)'}

        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: None)
        monkeypatch.setattr('api.updates.restart_active_profile_gateway', fake_gateway_restart)

        result = upd.apply_update('agent')
        assert result['ok'] is True
        assert result['stash_conflict'] is True
        assert result['target'] == 'agent'
        assert result['restart_scheduled'] is True
        assert result['gateway_restart'] == 'in_progress'
        assert gateway_restarts == ['default']

    def test_apply_update_agent_without_gateway_restart_result_fails(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()

        def fake_run(args, cwd, timeout=10):
            if args[0] == 'fetch':
                return '', True
            if args[0] == 'tag':
                return '', True
            if args[:2] == ['status', '--porcelain']:
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[:2] == ['rev-parse', '--short', 'origin/master']:
                return 'abc1234', True
            if args[0] == 'pull':
                return 'Already up to date.', True
            return '', True

        restart_calls = []
        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: (_ for _ in ()).throw(AssertionError('must not restart')))
        monkeypatch.setattr('api.updates.restart_active_profile_gateway', lambda **kwargs: (
            restart_calls.append(kwargs.get('profile')),
            {'status': 'busy', 'message': 'Restart already in progress. Please wait a moment and try again.'},
        )[1])

        result = upd.apply_update('agent')
        assert result['ok'] is False
        assert 'restart_scheduled' not in result
        assert result['target'] == 'agent'
        assert result['gateway_restart'] == 'busy'
        assert 'hermes gateway restart' in result['message']
        assert restart_calls == ['default']

    def test_apply_force_update_agent_uses_gateway_restart_status(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()
        ran = []

        def fake_run(args, cwd, timeout=10):
            ran.append(args)
            if args[0] == 'fetch':
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[0] == 'checkout':
                return '', True
            if args[0] == 'reset':
                return '', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: None)
        monkeypatch.setattr('api.updates.restart_active_profile_gateway', lambda **kwargs: {'status': 'completed', 'message': 'Gateway service restarted successfully'})

        result = upd.apply_force_update('agent')
        assert result['ok'] is True
        assert result['target'] == 'agent'
        assert result['restart_scheduled'] is True
        assert result['gateway_restart'] == 'completed'

    def test_apply_force_update_agent_fails_when_gateway_restart_busy(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()

        def fake_run(args, cwd, timeout=10):
            if args[0] == 'fetch':
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[0] == 'checkout':
                return '', True
            if args[0] == 'reset':
                return '', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: (_ for _ in ()).throw(AssertionError('must not restart')))
        monkeypatch.setattr(
            'api.updates.restart_active_profile_gateway',
            lambda **kwargs: {'status': 'busy', 'message': 'Restart already in progress. Please wait a moment and try again.'},
        )

        result = upd.apply_force_update('agent')
        assert result['ok'] is False
        assert result['target'] == 'agent'
        assert result['gateway_restart'] == 'busy'
        assert 'hermes gateway restart' in result['message']

    def test_apply_update_webui_does_not_call_gateway_restart(self, tmp_path, monkeypatch):
        import api.updates as upd

        (tmp_path / '.git').mkdir()
        monkeypatch.setattr(
            'api.updates.restart_active_profile_gateway',
            lambda: (_ for _ in ()).throw(AssertionError('helper must not run for webui updates')),
        )

        def fake_run(args, cwd, timeout=10):
            if args[0] == 'fetch':
                return '', True
            if args[0] == 'tag':
                return '', True
            if args[:2] == ['status', '--porcelain']:
                return '', True
            if args[:2] == ['rev-parse', '--abbrev-ref']:
                return 'origin/master', True
            if args[0] == 'pull':
                return 'Already up to date.', True
            return '', True

        monkeypatch.setattr(upd, '_run_git', fake_run)
        monkeypatch.setattr(upd, 'REPO_ROOT', tmp_path)
        monkeypatch.setattr(upd, '_AGENT_DIR', tmp_path)
        monkeypatch.setattr(upd, '_schedule_restart', lambda delay=2.0: None)

        result = upd.apply_update('webui')
        assert result['ok'] is True
        assert result['target'] == 'webui'
        assert result['restart_scheduled'] is True


# ── api/routes.py ─────────────────────────────────────────────────────────────

class TestForceUpdateRoute:
    """#813 — /api/updates/force route must exist in routes.py."""

    def test_force_route_exists(self):
        src = read('api/routes.py')
        assert '"/api/updates/force"' in src, (
            "routes.py must handle POST /api/updates/force"
        )
        assert 'apply_force_update' in src, (
            "routes.py must import and call apply_force_update"
        )


class TestHealthRouteContract:
    def test_health_payload_includes_server_started_at(self):
        src = read('api/routes.py')
        health_start = src.index('def _handle_health')
        payload_start = src.index('payload = {', health_start)
        payload_end = src.index('if "oldest_run_age_seconds" in run_check:', payload_start)
        payload = src[payload_start:payload_end]
        assert '"server_started_at": SERVER_START_TIME' in payload, (
            "/health must expose server_started_at sourced from SERVER_START_TIME"
        )
        assert '"uptime_seconds": round(time.time() - SERVER_START_TIME, 1)' in payload, (
            "/health must keep exposing uptime_seconds alongside server_started_at"
        )


class TestUpdateSummaryRouteModelSelection:
    """Update summaries should use a known text auxiliary model before main model fallback."""

    def test_summary_route_prefers_documented_compression_auxiliary_model(self):
        src = read('api/routes.py')

        assert 'get_text_auxiliary_client' in src
        assert '"compression"' in src
        assert '"update_summary"' not in src
        assert 'main_runtime=main_runtime' in src
        assert 'update summary auxiliary model failed; falling back to main model' in src
        assert 'require_ai_agent_class()' in src

    def test_summary_route_auxiliary_model_uses_active_profile_env(self, monkeypatch, tmp_path):
        import api.config as cfg
        import api.profiles as profiles
        import api.routes as routes
        import api.updates as updates

        class FakeHandler:
            def __init__(self, payload):
                raw = json.dumps(payload).encode('utf-8')
                self.headers = {'Content-Length': str(len(raw))}
                self.rfile = io.BytesIO(raw)
                self.wfile = io.BytesIO()
                self.status = None

            def send_response(self, status):
                self.status = status

            def send_header(self, _key, _value):
                pass

            def end_headers(self):
                pass

            def response_payload(self):
                return json.loads(self.wfile.getvalue().decode('utf-8'))

        captured = {}
        profile_home = tmp_path / 'profiles' / 'work'
        fake_skill_module = types.ModuleType('tools.skills_tool')
        setattr(fake_skill_module, 'HERMES_HOME', 'default-home')
        setattr(fake_skill_module, 'SKILLS_DIR', 'default-home/skills')
        monkeypatch.setitem(sys.modules, 'tools.skills_tool', fake_skill_module)

        monkeypatch.setattr(profiles, 'get_hermes_home_for_profile', lambda profile: profile_home)
        monkeypatch.setattr(
            profiles,
            'get_profile_runtime_env',
            lambda home: {'HERMES_TEST_PROFILE_ENV': 'work-runtime'},
        )
        monkeypatch.setattr(cfg, 'get_effective_default_model', lambda: 'openai/test-main')

        def fake_resolve_model_provider(model):
            thread_env = getattr(cfg._thread_ctx, 'env', {})
            captured['model_resolution_env'] = {
                'HERMES_HOME': os.environ.get('HERMES_HOME'),
                'HERMES_TEST_PROFILE_ENV': os.environ.get('HERMES_TEST_PROFILE_ENV'),
                'THREAD_HERMES_HOME': thread_env.get('HERMES_HOME'),
                'THREAD_HERMES_TEST_PROFILE_ENV': thread_env.get('HERMES_TEST_PROFILE_ENV'),
            }
            return model, 'openai', 'https://example.test/v1'

        monkeypatch.setattr(cfg, 'resolve_model_provider', fake_resolve_model_provider)
        monkeypatch.setattr(cfg, 'resolve_custom_provider_connection', lambda provider: (None, None))

        fake_runtime_provider = types.ModuleType('hermes_cli.runtime_provider')
        fake_runtime_provider.resolve_runtime_provider = lambda requested=None: {
            'api_key': 'fake-key',
            'provider': requested or 'openai',
            'base_url': 'https://example.test/v1',
        }
        fake_hermes_cli = types.ModuleType('hermes_cli')
        fake_hermes_cli.__path__ = []
        fake_hermes_cli.runtime_provider = fake_runtime_provider
        monkeypatch.setitem(sys.modules, 'hermes_cli', fake_hermes_cli)
        monkeypatch.setitem(sys.modules, 'hermes_cli.runtime_provider', fake_runtime_provider)

        class FakeAuxClient:
            class chat:
                class completions:
                    @staticmethod
                    def create(model, messages):
                        captured['aux_create'] = {'model': model, 'messages': messages}
                        return types.SimpleNamespace(
                            choices=[
                                types.SimpleNamespace(
                                    message=types.SimpleNamespace(
                                        content='Notice: Profile-routed update summaries work.'
                                    )
                                )
                            ]
                        )

        def fake_get_text_auxiliary_client(task, main_runtime=None):
            thread_env = getattr(cfg._thread_ctx, 'env', {})
            captured['aux_env'] = {
                'HERMES_HOME': os.environ.get('HERMES_HOME'),
                'HERMES_TEST_PROFILE_ENV': os.environ.get('HERMES_TEST_PROFILE_ENV'),
                'THREAD_HERMES_HOME': thread_env.get('HERMES_HOME'),
                'THREAD_HERMES_TEST_PROFILE_ENV': thread_env.get('HERMES_TEST_PROFILE_ENV'),
                'SKILL_MODULE_HOME': getattr(fake_skill_module, 'HERMES_HOME'),
                'SKILL_MODULE_DIR': getattr(fake_skill_module, 'SKILLS_DIR'),
            }
            captured['aux_task'] = task
            captured['main_runtime'] = dict(main_runtime or {})
            return FakeAuxClient(), 'profile-compression-model'

        fake_auxiliary_client = types.ModuleType('agent.auxiliary_client')
        fake_auxiliary_client.get_text_auxiliary_client = fake_get_text_auxiliary_client
        fake_agent = types.ModuleType('agent')
        fake_agent.__path__ = []
        fake_agent.auxiliary_client = fake_auxiliary_client
        monkeypatch.setitem(sys.modules, 'agent', fake_agent)
        monkeypatch.setitem(sys.modules, 'agent.auxiliary_client', fake_auxiliary_client)

        with updates._cache_lock:
            updates._summary_cache.clear()

        monkeypatch.setenv('HERMES_HOME', 'default-home')
        monkeypatch.setenv('HERMES_TEST_PROFILE_ENV', 'default-runtime')

        body = {
            'target': 'webui',
            'updates': {
                'webui': {
                    'behind': 1,
                    'current_sha': 'profile-env-before',
                    'latest_sha': f'profile-env-after-{time.time_ns()}',
                    'compare_url': 'https://example.test/compare',
                },
            },
        }
        handler = FakeHandler(body)

        profiles.set_request_profile('work')
        try:
            routes.handle_post(handler, types.SimpleNamespace(path='/api/updates/summary'))
        finally:
            profiles.clear_request_profile()

        assert handler.status == 200
        payload = handler.response_payload()
        assert payload['generated_by'] == 'llm'
        assert captured['aux_task'] == 'compression'
        assert captured['model_resolution_env'] == {
            'HERMES_HOME': 'default-home',
            'HERMES_TEST_PROFILE_ENV': 'default-runtime',
            'THREAD_HERMES_HOME': str(profile_home),
            'THREAD_HERMES_TEST_PROFILE_ENV': 'work-runtime',
        }
        assert captured['aux_env'] == {
            'HERMES_HOME': 'default-home',
            'HERMES_TEST_PROFILE_ENV': 'default-runtime',
            'THREAD_HERMES_HOME': str(profile_home),
            'THREAD_HERMES_TEST_PROFILE_ENV': 'work-runtime',
            'SKILL_MODULE_HOME': 'default-home',
            'SKILL_MODULE_DIR': 'default-home/skills',
        }
        assert captured['aux_create']['model'] == 'profile-compression-model'
        assert fake_skill_module.HERMES_HOME == 'default-home'
        assert fake_skill_module.SKILLS_DIR == 'default-home/skills'
        assert os.environ.get('HERMES_HOME') == 'default-home'
        assert os.environ.get('HERMES_TEST_PROFILE_ENV') == 'default-runtime'


# ── static/index.html ─────────────────────────────────────────────────────────

# ── Regression: sequential webui+agent update — restart coordination ──────────

class TestSequentialUpdateRestartCoordination:
    """Regression guard for the two-target race: when both webui and agent
    have updates, the client POSTs them sequentially (webui → agent). The
    first update's success schedules a restart timer; without coordination
    that timer fires while the second update's git-pull is still running,
    killing it mid-stream and leaving the second repo partial.

    Fix: `_schedule_restart` must acquire `_apply_lock` before calling
    `os.execv`, so a pending second update always completes first.
    """

    def test_schedule_restart_waits_for_apply_lock(self, monkeypatch):
        """The restart thread must wait for any in-flight update before
        calling execv. Exercised by holding _apply_lock from another thread
        and verifying execv is delayed until the lock is released."""
        import api.updates as upd
        import threading as _th
        import time as _t

        execv_called = _th.Event()
        execv_time = []

        def fake_execv(exe, args):
            execv_time.append(_t.monotonic())
            execv_called.set()

        monkeypatch.setattr(sys, 'platform', 'linux')
        monkeypatch.setattr(upd, '_wait_until_restart_safe', lambda *a, **k: {'restart_blocked': False})
        monkeypatch.setattr(os, 'execv', fake_execv)

        # Hold _apply_lock from another thread (simulating an in-flight
        # second update) for 0.4 s.
        release_time = []
        lock_held = _th.Event()

        def holder():
            with upd._apply_lock:
                lock_held.set()
                _t.sleep(0.4)
                release_time.append(_t.monotonic())

        holder_thread = _th.Thread(target=holder, daemon=True)
        holder_thread.start()
        lock_held.wait(timeout=2)

        # Schedule a restart with a short delay. The lock is held;
        # the restart thread should block on it.
        upd._schedule_restart(delay=0.05)
        _t.sleep(0.15)
        assert not execv_called.is_set(), (
            "execv called while _apply_lock was still held by another "
            "thread — restart must wait for in-flight updates to finish"
        )

        # Let the holder release.
        holder_thread.join(timeout=2)
        assert release_time, "holder didn't release the lock"

        # execv should fire shortly after the lock release.
        assert execv_called.wait(timeout=2), (
            "execv never fired after _apply_lock was released"
        )
        assert execv_time[0] >= release_time[0], (
            f"execv fired before lock was released "
            f"(execv={execv_time[0]}, release={release_time[0]})"
        )

    def test_schedule_restart_still_fires_when_no_update_in_flight(self, monkeypatch):
        """Sanity: with nothing holding the lock, restart still fires promptly."""
        import api.updates as upd
        import time as _t

        execv_called = []
        def fake_execv(exe, args):
            execv_called.append(True)
        monkeypatch.setattr(sys, 'platform', 'linux')
        monkeypatch.setattr(upd, '_wait_until_restart_safe', lambda *a, **k: {'restart_blocked': False})
        monkeypatch.setattr(os, 'execv', fake_execv)

        upd._schedule_restart(delay=0.05)
        _t.sleep(0.25)
        assert execv_called, (
            "restart must still fire when _apply_lock is free"
        )



class TestUpdateCompareSource:
    def test_simulated_update_check_payload_includes_both_safe_compare_urls(self):
        src = read('api/routes.py')
        assert '"repo_url": "https://github.com/nesquena/hermes-webui"' in src
        assert '"compare_url": "https://github.com/nesquena/hermes-webui/compare/abc1234...def5678"' in src
        assert '"repo_url": "https://github.com/NousResearch/hermes-agent"' in src
        assert '"compare_url": "https://github.com/NousResearch/hermes-agent/compare/aaa0001...bbb0002"' in src

class TestWhatsNewSummaryToggle:
    def test_settings_default_and_persistence_allow_whats_new_summary_toggle(self):
        src = read('api/config.py')
        assert '"whats_new_summary_enabled": False' in src
        bool_keys_start = src.find('_SETTINGS_BOOL_KEYS')
        assert bool_keys_start != -1
        bool_keys = src[bool_keys_start:src.find('}', bool_keys_start)]
        assert '"whats_new_summary_enabled"' in bool_keys

    def test_summary_endpoint_and_prompt_are_human_readable_not_technical(self):
        routes = read('api/routes.py')
        updates = read('api/updates.py')
        assert '"/api/updates/summary"' in routes
        assert 'summarize_update_payload' in routes
        assert 'def summarize_update_payload' in updates
        assert 'human-readable' in updates
        assert 'avoid technical jargon' in updates
        assert 'regular diff comparison' in updates
        assert 'Return only prefixed bullets' in updates
        assert 'def _format_update_summary_sections' in updates

    def test_update_summary_formats_llm_text_into_stable_sections(self):
        from api.updates import summarize_update_payload

        payload = {
            'webui': {'behind': 2, 'current_sha': 'abc', 'latest_sha': 'def', 'compare_url': 'https://example.test/webui'},
            'agent': {'behind': 1, 'current_sha': 'aaa', 'latest_sha': 'bbb', 'compare_url': 'https://example.test/agent'},
        }
        result = summarize_update_payload(
            payload,
            llm_callback=lambda _system, _prompt: 'The settings panel is easier to understand. Update prompts are clearer.',
            use_cache=False,
        )
        assert result['summary_sections'][0]['title'] == "What you'll notice"
        assert result['summary_sections'][1]['title'] == 'Worth knowing'
        assert result['summary_sections'][0]['items']
        assert result['summary_sections'][1]['items']
        assert 'regular diff comparison' not in ' '.join(result['summary_sections'][1]['items']).lower()
        assert 'What you\'ll notice' in result['summary']
        assert 'Worth knowing' in result['summary']
        assert '- The settings panel is easier to understand.' in result['summary']

    def test_update_summary_deduplicates_notice_items_from_worth_knowing(self):
        from api.updates import summarize_update_payload

        payload = {
            'webui': {'behind': 2, 'current_sha': 'abc', 'latest_sha': 'def', 'compare_url': 'https://example.test/webui'},
        }
        result = summarize_update_payload(
            payload,
            llm_callback=lambda _system, _prompt: 'The settings panel is easier to understand. Update prompts are clearer.',
            use_cache=False,
        )
        notice_items = result['summary_sections'][0]['items']
        worth_section = next((section for section in result['summary_sections'] if section['title'] == 'Worth knowing'), None)

        assert notice_items == [
            'The settings panel is easier to understand.',
            'Update prompts are clearer.',
        ]
        assert worth_section is None
        assert 'Worth knowing' not in result['summary']
        assert 'This summary covers WebUI' not in result['summary']

    def test_update_summary_deduplicates_repeated_agent_summary_bullets(self):
        from api.updates import summarize_update_payload

        duplicate_menu_item = (
            'The `hermes tools` menus should open noticeably faster, especially when checking available tools or auth state.'
        )
        duplicate_quality_item = (
            'These updates are small quality-of-life improvements focused on smoother messaging and less waiting in the CLI.'
        )
        result = summarize_update_payload(
            {
                'agent': {
                    'behind': 2,
                    'current_sha': 'abc',
                    'latest_sha': 'def',
                    'compare_url': 'https://example.test/agent',
                },
            },
            llm_callback=lambda _system, _prompt: '\n'.join(
                [
                    'Slack thread commands now also work with `!cmd`, giving you an easier fallback when slash commands are awkward or unavailable.',
                    duplicate_menu_item,
                    duplicate_quality_item,
                    duplicate_menu_item,
                    duplicate_quality_item,
                ]
            ),
            use_cache=False,
        )
        sections = {section['title']: section['items'] for section in result['summary_sections']}

        assert duplicate_menu_item in sections["What you'll notice"]
        assert duplicate_quality_item in sections["What you'll notice"]
        assert 'Worth knowing' not in sections
        assert result['summary'].count(duplicate_menu_item) == 1
        assert result['summary'].count(duplicate_quality_item) == 1

    def test_update_summary_keeps_all_categorized_notice_and_worth_bullets(self):
        from api.updates import summarize_update_payload

        result = summarize_update_payload(
            {'webui': {'behind': 8, 'current_sha': 'abc', 'latest_sha': 'def', 'compare_url': 'https://example.test/webui'}},
            llm_callback=lambda _system, _prompt: '\n'.join(
                [
                    'Notice: The settings panel loads faster.',
                    'Notice: Update prompts are easier to read.',
                    'Notice: Chat status is clearer during reconnects.',
                    'Notice: Tool results stay grouped by source.',
                    'Notice: Mobile controls remain visible.',
                    'Worth knowing: Some labels were renamed to match the new flow.',
                    'Worth knowing: The full diff is still available from the update banner.',
                ]
            ),
            use_cache=False,
        )
        sections = {section['title']: section['items'] for section in result['summary_sections']}

        assert sections["What you'll notice"] == [
            'The settings panel loads faster.',
            'Update prompts are easier to read.',
            'Chat status is clearer during reconnects.',
            'Tool results stay grouped by source.',
            'Mobile controls remain visible.',
        ]
        assert sections['Worth knowing'] == [
            'Some labels were renamed to match the new flow.',
            'The full diff is still available from the update banner.',
        ]

    def test_update_summary_keeps_unknown_prefixed_bullets_as_notice(self):
        from api.updates import summarize_update_payload

        result = summarize_update_payload(
            {'webui': {'behind': 3, 'current_sha': 'abc', 'latest_sha': 'def', 'compare_url': 'https://example.test/webui'}},
            llm_callback=lambda _system, _prompt: '\n'.join(
                [
                    'Notice: The settings panel loads faster.',
                    'Caveat: Restart once after applying the update.',
                    'Action required: Reopen the update banner if the summary was already cached.',
                    'Worth knowing: The full diff is still available from the update banner.',
                ]
            ),
            use_cache=False,
        )
        sections = {section['title']: section['items'] for section in result['summary_sections']}

        assert sections["What you'll notice"] == [
            'The settings panel loads faster.',
            'Caveat: Restart once after applying the update.',
            'Action required: Reopen the update banner if the summary was already cached.',
        ]
        assert sections['Worth knowing'] == [
            'The full diff is still available from the update banner.',
        ]

    def test_update_summary_many_updates_caps_commit_input_and_discloses_scope(self, monkeypatch):
        import api.updates as upd

        subjects = [f'Commit subject {idx}' for idx in range(1, 25)]
        monkeypatch.setattr(
            upd,
            '_commit_subjects_for_update_with_limit',
            lambda _info, *, limit=24: (subjects[:limit], True),
        )
        prompts = []

        def fake_llm(_system, prompt):
            prompts.append(prompt)
            return '\n'.join([
                'Notice: Several user-facing fixes are ready.',
                'Notice: Settings and update messaging should be easier to understand.',
                'Notice: The update flow should feel safer and clearer.',
                'Notice: Mobile update controls should stay reachable.',
                'Worth knowing: Some lower-level cleanup supports the visible update changes.',
            ])

        result = upd.summarize_update_payload(
            {
                'webui': {
                    'behind': 57,
                    'current_sha': 'abc',
                    'latest_sha': 'def',
                    'compare_url': 'https://example.test/webui',
                }
            },
            target='webui',
            llm_callback=fake_llm,
            use_cache=False,
        )

        assert len(subjects) == 24
        assert prompts
        assert 'Showing latest 24 of 57 commit subjects; summarize trends, not every commit.' in prompts[0]
        assert 'Commit subject 24' in prompts[0]
        assert 'Commit subject 25' not in prompts[0]
        sections = {section['title']: section['items'] for section in result['summary_sections']}
        assert sections["What you'll notice"] == [
            'Several user-facing fixes are ready.',
            'Settings and update messaging should be easier to understand.',
            'The update flow should feel safer and clearer.',
            'Mobile update controls should stay reachable.',
        ]
        assert sections['Worth knowing'] == [
            'Some lower-level cleanup supports the visible update changes.',
            'WebUI has 57 updates; this summary uses the latest 24 commit subjects, with the full comparison still available in the diff link.',
        ]
        assert result['targets'][0]['commits_truncated'] is True

    def test_update_summary_cache_reuses_same_update_summary(self):
        import api.updates as upd

        upd._summary_cache.clear()
        calls = []
        payload = {
            'webui': {'behind': 2, 'current_sha': 'abc', 'latest_sha': 'def', 'compare_url': 'https://example.test/webui'},
        }

        def fake_llm(_system, _prompt):
            calls.append(True)
            return f'- Stable cached summary #{len(calls)}'

        first = upd.summarize_update_payload(payload, llm_callback=fake_llm)
        second = upd.summarize_update_payload(payload, llm_callback=fake_llm)
        changed = upd.summarize_update_payload(
            {'webui': {'behind': 3, 'current_sha': 'abc', 'latest_sha': 'xyz', 'compare_url': 'https://example.test/webui2'}},
            llm_callback=fake_llm,
        )
        assert len(calls) == 2
        assert second['summary'] == first['summary']
        assert second['cached'] is True
        assert changed['summary'] != first['summary']

    def test_update_summary_cache_is_bounded_lru(self):
        import api.updates as upd

        upd._summary_cache.clear()
        calls = []

        def payload(n):
            return {
                'webui': {
                    'behind': n + 1,
                    'current_sha': f'old-{n}',
                    'latest_sha': f'new-{n}',
                    'compare_url': f'https://example.test/webui/{n}',
                },
            }

        def fake_llm(_system, prompt):
            calls.append(prompt)
            return f'- Generated summary #{len(calls)}'

        try:
            for i in range(upd._SUMMARY_CACHE_MAX):
                upd.summarize_update_payload(payload(i), llm_callback=fake_llm)

            assert len(upd._summary_cache) == upd._SUMMARY_CACHE_MAX
            assert len(calls) == upd._SUMMARY_CACHE_MAX

            first_again = upd.summarize_update_payload(payload(0), llm_callback=fake_llm)
            assert first_again['cached'] is True
            assert len(calls) == upd._SUMMARY_CACHE_MAX

            upd.summarize_update_payload(payload(upd._SUMMARY_CACHE_MAX), llm_callback=fake_llm)
            assert len(upd._summary_cache) == upd._SUMMARY_CACHE_MAX

            still_cached = upd.summarize_update_payload(payload(0), llm_callback=fake_llm)
            assert still_cached['cached'] is True
            assert len(calls) == upd._SUMMARY_CACHE_MAX + 1

            evicted = upd.summarize_update_payload(payload(1), llm_callback=fake_llm)
            assert evicted['cached'] is False
            assert len(calls) == upd._SUMMARY_CACHE_MAX + 2
        finally:
            upd._summary_cache.clear()

    def test_update_summary_can_be_generated_per_target_and_cached_separately(self):
        import api.updates as upd

        upd._summary_cache.clear()
        calls = []
        payload = {
            'webui': {'behind': 2, 'current_sha': 'web-a', 'latest_sha': 'web-b', 'compare_url': 'https://example.test/webui'},
            'agent': {'behind': 1, 'current_sha': 'agent-a', 'latest_sha': 'agent-b', 'compare_url': 'https://example.test/agent'},
        }

        def fake_llm(_system, prompt):
            calls.append(prompt)
            if 'Agent:' in prompt:
                return '- Agent startup is clearer.'
            return '- WebUI settings are easier to use.'

        webui = upd.summarize_update_payload(payload, target='webui', llm_callback=fake_llm)
        agent = upd.summarize_update_payload(payload, target='agent', llm_callback=fake_llm)
        webui_again = upd.summarize_update_payload(payload, target='webui', llm_callback=fake_llm)

        assert len(calls) == 2
        assert webui['target'] == 'webui'
        assert agent['target'] == 'agent'
        assert [t['name'] for t in webui['targets']] == ['webui']
        assert [t['name'] for t in agent['targets']] == ['agent']
        assert 'WebUI settings are easier to use.' in webui['summary']
        assert 'Agent startup is clearer.' in agent['summary']
        assert webui_again['cached'] is True
        assert webui_again['summary'] == webui['summary']


# ── Regression: force button reset on retry ──────────────────────────────────

# ── #785: Manual 'Check for Updates' button ───────────────────────────────────
