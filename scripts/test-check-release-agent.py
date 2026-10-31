#!/usr/bin/env python3
"""Synthetic release checks share one host worker budget; no Git/network/Agent."""

import hashlib
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

    def invoke(self, *options, receipts=None, attempt='1', sharded=True):
        pin = json.loads((ROOT / 'web/sidecar/agent_dependency.json').read_text())
        identity = {**pin['x-talaria'], 'image': pin['services']['hermes-agent']['image']}
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
                    self.assertNotIn('stdout', kwargs, 'the check streams its output into the job log')
                    checked.append((command[command.index('--release') + 1:], kwargs['env']['TALARIA_SIDECAR_WORKERS']))
                return subprocess.CompletedProcess(command, 0)

            def output(command, **kwargs):
                if '--help' in command:
                    # The selected source's checker: one from before TAL-1599 has no --shard.
                    return 'usage: check-agent-compatibility.py [--release RELEASE]' + (' [--shard N/M]' if sharded else '')
                return json.dumps(['v1', 'v2', 'v3'] if '--list' in command else pin).encode()

            argv = ['check-release-agent.py', '--plan', str(plan), *options, *(['--receipts', str(receipts)] if receipts else [])]
            with patch.object(checker, 'ROOT', root), patch.object(checker.subprocess, 'run', side_effect=run), \
                    patch.object(checker.subprocess, 'check_output', side_effect=output), \
                    patch.dict(os.environ, {'TALARIA_SIDECAR_WORKERS': '4', 'GITHUB_RUN_ID': '77', 'GITHUB_RUN_ATTEMPT': attempt}), \
                    patch('sys.argv', argv), patch('sys.stdout', new_callable=io.StringIO) as stdout:
                checker.main()
            return checked, builds, stdout.getvalue()

    def test_release_jobs_check_one_shard_of_one_supported_release_each(self):
        # A release runs every supported Agent release's sidecar suite in SHARDS jobs (TAL-1550, TAL-1599): --list
        # feeds the matrix and --release --shard checks one shard with the whole budget, streaming its log.
        checked, builds, printed = self.invoke('--list')
        self.assertEqual((checked, builds), ([], []))
        self.assertEqual(json.loads(printed), [{'release': tag, 'shard': shard, 'shards': 3} for tag in ('v1', 'v2', 'v3') for shard in (1, 2, 3)])
        with tempfile.TemporaryDirectory() as receipts:
            checked, builds, printed = self.invoke('--release', 'v2', '--shard', '2/3', receipts=receipts)
            self.assertEqual(checked, [(['v2', '--shard', '2/3', '--receipt', str(Path(receipts).resolve() / 'v2.shard-2.json')], '4')])
        self.assertEqual(len(builds), 3)
        self.assertIn('===== Agent v2 shard 2/3: started =====', printed)
        with self.assertRaisesRegex(ValueError, 'v4 is not a supported release'):
            self.invoke('--release', 'v4')
        with self.assertRaisesRegex(ValueError, 'not one of the selected source'):
            self.invoke('--release', 'v2', '--shard', '1/1')
        for options in (('--shard', '1/3'), ('--expect', '[]')):
            with self.subTest(options=options), patch('sys.stderr', new_callable=io.StringIO), self.assertRaises(SystemExit):
                self.invoke(*options)

    def test_a_retained_web_source_from_before_sharding_runs_one_job_per_release(self):
        # A release that keeps an older Web release checks the Agents against that source's own checker, which has no
        # --shard: each release runs whole in one job, and the join requires its one passing receipt.
        checked, _, printed = self.invoke('--list', sharded=False)
        self.assertEqual(json.loads(printed), [{'release': tag, 'shard': 1, 'shards': 1} for tag in ('v1', 'v2', 'v3')])
        with tempfile.TemporaryDirectory() as receipts:
            checked, _, _ = self.invoke('--release', 'v2', '--shard', '1/1', receipts=receipts, sharded=False)
            self.assertEqual(checked, [(['v2', '--receipt', str(Path(receipts).resolve() / 'v2.shard-1.json')], '4')])
        with self.assertRaisesRegex(ValueError, 'not one of the selected source'):
            self.invoke('--release', 'v2', '--shard', '2/3', sharded=False)
        jobs = json.dumps([{'release': tag, 'shard': 1, 'shards': 1} for tag in ('v1', 'v2', 'v3')])

        def expect(changes=None, listed=jobs):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for tag in ('v1', 'v2', 'v3'):
                    self.write_shards(root, tag)
                    for path in root.rglob(f'{tag}.shard-[23]*'):
                        path.unlink()
                    receipt = next(root.rglob(f'{tag}.shard-1.json'))
                    record = json.loads(receipt.read_text())
                    del record['shard']
                    receipt.write_text(json.dumps({**record, **(changes or {}).get(tag, {})}))
                return self.invoke('--expect', listed, receipts=root, sharded=False)

        self.assertIn('Agent v2: the selected source\'s checker ran its whole sidecar suite in one job', expect()[2])
        with self.assertRaisesRegex(ValueError, 'v3 shard 1/1 receipt is not a passing'):
            expect({'v3': {'result': 'failure'}})
        with self.assertRaisesRegex(ValueError, "not the supported releases' shards"):
            expect(listed=json.dumps([{'release': tag, 'shard': shard, 'shards': 3} for tag in ('v1', 'v2', 'v3') for shard in (1, 2, 3)]))

    def write_shards(self, root, tag, attempt=1, run=77, cases=None, changes=None):
        suite = sorted(f'tests/test_{name}.py::test_case' for name in 'abcdefg')
        digest = hashlib.sha256('\n'.join(suite).encode()).hexdigest()
        dealt = cases or [suite[shard - 1::3] for shard in (1, 2, 3)]
        for shard in (1, 2, 3):
            directory = root / f'agent-compatibility-{tag}-shard-{shard}-{attempt}'
            directory.mkdir(parents=True, exist_ok=True)
            (directory / f'{tag}.shard-{shard}.gate.json').write_text(json.dumps({
                'gate': 'agentCompatibility', 'sourceRevision': 'b' * 40, 'result': 'success',
                'runUrl': f'https://github.com/MaudeCode/talaria/actions/runs/{run}/attempts/{attempt}'}))
            (directory / f'{tag}.shard-{shard}.json').write_text(json.dumps({
                'kind': 'supported', 'releaseTag': tag, 'webRevision': 'a' * 40, 'imageVerified': True, 'result': 'success',
                'shard': {'shard': f'{shard}/3', 'suiteCases': len(suite), 'suiteDigest': digest, 'cases': dealt[shard - 1]},
                **(changes or {}).get(shard, {})}))

    def test_the_join_requires_every_shard_to_pass_and_run_each_case_once(self):
        jobs = json.dumps([{'release': tag, 'shard': shard, 'shards': 3} for tag in ('v3', 'v1', 'v2') for shard in (3, 1, 2)])

        def expect(prepare, attempt='1', listed=jobs):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for tag in ('v1', 'v2', 'v3'):
                    self.write_shards(root, tag)
                prepare(root)
                return self.invoke('--expect', listed, receipts=root, attempt=attempt)

        checked, builds, printed = expect(lambda root: None)
        self.assertEqual((checked, builds), ([], []))
        self.assertIn('Agent v2: 3 shards ran every one of 7 sidecar test cases exactly once', printed)
        # A rerun keeps the shards that passed before and reads each shard's newest passing attempt.
        expect(lambda root: self.write_shards(root, 'v1', attempt=2), attempt='2')

        def remove(path):
            return lambda root: [item.unlink() for item in root.rglob(path)]

        broken = {
            'v2 shard 2/3 left no passing receipt': remove('v2.shard-2.gate.json'),
            'v1 shard 1/3 left no passing receipt in this run': lambda root: [remove('v1.shard-1.gate.json')(root),
                                                                              self.write_shards(root, 'v1', run=78)],
            'v3 shard 3/3 receipt is not a passing': lambda root: self.write_shards(root, 'v3', changes={3: {'result': 'failure'}}),
            'v3 shard 1/3 receipt is not a passing': lambda root: self.write_shards(root, 'v3', changes={1: {'webRevision': 'c' * 40}}),
            'v3 shard 2/3 receipt is not a passing': lambda root: self.write_shards(root, 'v3', changes={2: {'imageVerified': False}}),
            'v1 shards ran 1 cases more than once': lambda root: self.write_shards(root, 'v1', cases=[
                ['tests/test_a.py::test_case', 'tests/test_d.py::test_case', 'tests/test_g.py::test_case'],
                ['tests/test_b.py::test_case', 'tests/test_e.py::test_case', 'tests/test_a.py::test_case'],
                ['tests/test_c.py::test_case', 'tests/test_f.py::test_case']]),
            'v1 shards ran 6 of its 7 sidecar test cases': lambda root: self.write_shards(root, 'v1', cases=[
                ['tests/test_a.py::test_case', 'tests/test_d.py::test_case'],
                ['tests/test_b.py::test_case', 'tests/test_e.py::test_case'],
                ['tests/test_c.py::test_case', 'tests/test_f.py::test_case']]),
            'v2 shards were dealt from different suites': lambda root: self.write_shards(root, 'v2', changes={1: {'shard': {
                'shard': '1/3', 'suiteCases': 8, 'suiteDigest': '0' * 64,
                'cases': ['tests/test_a.py::test_case', 'tests/test_d.py::test_case', 'tests/test_g.py::test_case']}}}),
        }
        for message, prepare in broken.items():
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                expect(prepare)
        # An attempt newer than this one never counts.
        with self.assertRaisesRegex(ValueError, 'v1 shard 1/3 left no passing receipt'):
            expect(lambda root: [remove('v1.shard-1.gate.json')(root), self.write_shards(root, 'v1', attempt=3)], attempt='2')
        for listed in (json.dumps(json.loads(jobs)[1:]), json.dumps([*json.loads(jobs), {'release': 'v4', 'shard': 1, 'shards': 3}]), '[]'):
            with self.subTest(listed=listed), self.assertRaisesRegex(ValueError, "not the supported releases' shards"):
                expect(lambda root: None, listed=listed)


if __name__ == '__main__':
    unittest.main()
