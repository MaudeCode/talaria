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
                    lock = threading.Lock()
                    width = min(budget, len(tags))
                    barrier = threading.Barrier(width)

                    def output(command, **kwargs):
                        return json.dumps(tags if '--list' in command else pin).encode()

                    def run(command, **kwargs):
                        nonlocal active, maximum, started
                        if '--release' not in command:
                            return subprocess.CompletedProcess(command, 0)
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
                    self.assertLessEqual(maximum, budget)
                    self.assertTrue(all(env['TALARIA_SIDECAR_TOTAL_WORKERS'] == str(budget) for env in seen.values()))
                    self.assertEqual(sum(int(env['TALARIA_SIDECAR_WORKERS']) for env in seen.values()), max(budget, 3))


if __name__ == '__main__':
    unittest.main()
