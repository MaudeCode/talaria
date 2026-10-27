#!/usr/bin/env python3
"""Synthetic release checks share one host worker budget; no Git/network/Agent."""

import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_checker', ROOT / 'scripts/check-release-agent.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class ReleaseBudgetTests(unittest.TestCase):
    def test_checks_bound_total_workers_and_aggregate_failures(self):
        for budget in (1, 2, 4, 8):
            for fail in (False, True):
                with self.subTest(budget=budget, fail=fail), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    pin = json.loads((ROOT / 'web/sidecar/agent_dependency.json').read_text())
                    identity = {**pin['x-talaria'], 'image': pin['services']['hermes-agent']['image']}
                    plan = root / 'plan.json'
                    plan.write_text(json.dumps({'components': {'web': {'sourceRevision': 'a' * 40}}, 'agent': identity}))
                    tags, seen, active, maximum, started = ['v1', 'v2', 'v3'], {}, 0, 0, 0
                    builds = []
                    lock = threading.Lock()
                    width = min(budget, len(tags))
                    barrier = threading.Barrier(width)

                    def output(command, **kwargs):
                        return json.dumps(tags if '--list' in command else pin).encode()

                    def run(command, **kwargs):
                        nonlocal active, maximum, started
                        if command[0] == 'npm':
                            builds.append(command)
                            for relative in ('node_modules', 'packages/contracts/dist', 'packages/server/dist'):
                                (Path(kwargs['cwd']) / relative).mkdir(parents=True, exist_ok=True)
                        if '--release' not in command:
                            return subprocess.CompletedProcess(command, 0)
                        if builds:
                            for relative in ('web/node_modules', 'web/packages/contracts/dist', 'web/packages/server/dist'):
                                self.assertTrue((Path(kwargs['cwd']) / relative).is_symlink())
                        tag = command[command.index('--release') + 1]
                        env = kwargs['env']
                        workers = int(env['TALARIA_SIDECAR_WORKERS'])
                        with lock:
                            seen[tag] = env
                            active += workers
                            maximum = max(maximum, active)
                            started += 1
                            first_wave = started <= width
                        if first_wave:
                            barrier.wait(timeout=10)
                        with lock:
                            active -= workers
                        return subprocess.CompletedProcess(command, int(fail and tag == 'v2'), stdout=f'{tag} checked\n')

                    with patch.object(checker, 'ROOT', root), patch.object(checker.subprocess, 'run', side_effect=run), \
                            patch.object(checker.subprocess, 'check_output', side_effect=output), \
                            patch.dict(os.environ, {'TALARIA_SIDECAR_WORKERS': str(budget)}), \
                            patch('sys.argv', ['check-release-agent.py', '--plan', str(plan)]), patch('sys.stdout', new_callable=io.StringIO):
                        if fail:
                            with self.assertRaisesRegex(RuntimeError, 'v2'):
                                checker.main()
                        else:
                            checker.main()
                    self.assertEqual(set(seen), set(tags))
                    self.assertEqual(builds, [['npm', 'ci', '--no-audit', '--no-fund'],
                        ['npm', 'run', 'build', '-w', 'packages/contracts'], ['npm', 'run', 'build', '-w', 'packages/server']])
                    self.assertLessEqual(maximum, budget)
                    self.assertTrue(all(env['TALARIA_SIDECAR_TOTAL_WORKERS'] == str(budget) for env in seen.values()))
                    self.assertEqual(sum(int(env['TALARIA_SIDECAR_WORKERS']) for env in seen.values()), max(budget, 3))

    def test_missing_runtime_artifacts_never_start_compatibility(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pin = json.loads((ROOT / 'web/sidecar/agent_dependency.json').read_text())
            identity = {**pin['x-talaria'], 'image': pin['services']['hermes-agent']['image']}
            plan = root / 'plan.json'
            plan.write_text(json.dumps({'components': {'web': {'sourceRevision': 'a' * 40}}, 'agent': identity}))
            commands = []
            def run(command, **kwargs):
                commands.append(command)
                return subprocess.CompletedProcess(command, 0, stdout='synthetic check\n')
            def output(command, **kwargs):
                return json.dumps(['v1', 'v2', 'v3'] if '--list' in command else pin).encode()
            with patch.object(checker, 'ROOT', root), patch.object(checker.subprocess, 'run', side_effect=run), \
                    patch.object(checker.subprocess, 'check_output', side_effect=output), \
                    patch('sys.argv', ['check-release-agent.py', '--plan', str(plan)]), patch('sys.stdout', new_callable=io.StringIO):
                with self.assertRaisesRegex(RuntimeError, 'runtime build did not produce'):
                    checker.main()
            self.assertFalse(any('--release' in command for command in commands))

    def test_release_jobs_check_one_supported_release_each_and_cover_them_all(self):
        # A release runs one job per supported Agent release (TAL-1550): --list feeds the matrix, --release checks one
        # release with the whole budget, and --expect proves the jobs covered exactly the supported releases.
        pin = json.loads((ROOT / 'web/sidecar/agent_dependency.json').read_text())
        identity = {**pin['x-talaria'], 'image': pin['services']['hermes-agent']['image']}

        def invoke(*options):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                plan = root / 'plan.json'
                plan.write_text(json.dumps({'components': {'web': {'sourceRevision': 'a' * 40}}, 'agent': identity}))
                checked, builds = [], []

                def run(command, **kwargs):
                    if command[0] == 'npm':
                        builds.append(command)
                        for relative in ('node_modules', 'packages/contracts/dist', 'packages/server/dist'):
                            (Path(kwargs['cwd']) / relative).mkdir(parents=True, exist_ok=True)
                    if '--release' in command:
                        checked.append((command[command.index('--release') + 1], kwargs['env']['TALARIA_SIDECAR_WORKERS']))
                    return subprocess.CompletedProcess(command, 0, stdout='synthetic check\n')

                def output(command, **kwargs):
                    return json.dumps(['v1', 'v2', 'v3'] if '--list' in command else pin).encode()

                with patch.object(checker, 'ROOT', root), patch.object(checker.subprocess, 'run', side_effect=run), \
                        patch.object(checker.subprocess, 'check_output', side_effect=output), \
                        patch.dict(os.environ, {'TALARIA_SIDECAR_WORKERS': '4'}), \
                        patch('sys.argv', ['check-release-agent.py', '--plan', str(plan), *options]), \
                        patch('sys.stdout', new_callable=io.StringIO) as stdout:
                    checker.main()
                return checked, builds, stdout.getvalue()

        checked, builds, printed = invoke('--list')
        self.assertEqual((checked, builds, json.loads(printed)), ([], [], ['v1', 'v2', 'v3']))
        checked, builds, _ = invoke('--release', 'v2')
        self.assertEqual(checked, [('v2', '4')])
        self.assertEqual(len(builds), 3)
        with self.assertRaisesRegex(ValueError, 'v4 is not a supported release'):
            invoke('--release', 'v4')
        checked, builds, _ = invoke('--expect', '["v3", "v1", "v2"]')
        self.assertEqual((checked, builds), ([], []))
        for expected in ('["v1", "v2"]', '["v1", "v2", "v3", "v4"]', '[]'):
            with self.subTest(expected=expected), self.assertRaisesRegex(ValueError, 'not the supported releases'):
                invoke('--expect', expected)


if __name__ == '__main__':
    unittest.main()
