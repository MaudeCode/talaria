import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ProjectStore } from './projects.js'

it('preserves both system projects when async session index readers run concurrently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'talaria-project-concurrency-'))
  try {
    const store = new ProjectStore(join(directory, 'projects.json'), () => Promise.resolve([]))
    const ids = await Promise.all([store.ensureSystemProject('cron', 'first'), store.ensureSystemProject('cron', 'second')])
    expect((await store.load()).map((p) => p.project_id).sort()).toEqual(ids.sort())
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
