import { execFile } from 'node:child_process'
import { expect, it, vi } from 'vitest'

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), existsSync: () => false }))
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: vi.fn((_command, _args, _options, callback: (error: null, stdout: string, stderr: string) => void) => { callback(null, 'synthetic npm', '') }),
}))
import { runNpm, runPackageNpm } from './updates.js'

it.each([runNpm, runPackageNpm])('uses npm on PATH when neither preferred installation exists', async (run) => {
  vi.mocked(execFile).mockClear()
  expect(await run(['--version'], '/synthetic', 1000)).toEqual({ ok: true, out: 'synthetic npm' })
  expect(execFile).toHaveBeenCalledWith('npm', ['--version'], expect.objectContaining({ cwd: '/synthetic', timeout: 1000 }), expect.any(Function))
})
