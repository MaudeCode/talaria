import { JsonDocuments } from './sessions/storage/json-documents.js'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectStore } from './projects.js'

type Json = Record<string, unknown>

it('preserves both system projects when async session index readers run concurrently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'talaria-project-concurrency-'))
  try {
    const store = new ProjectStore(new JsonDocuments(dirname(join(directory, 'projects.json'))), () => Promise.resolve([]))
    const ids = await Promise.all([store.ensureSystemProject('cron', 'first'), store.ensureSystemProject('cron', 'second')])
    expect((await store.load()).map((p) => p.project_id).sort()).toEqual(ids.sort())
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

describe('per-profile system projects', () => {
  let dir = ''
  let indexRows: Json[] = []
  const store = (isRoot: (n: string) => boolean = (n) => n === 'default'): ProjectStore => new ProjectStore(new JsonDocuments(dirname(join(dir, 'projects.json'))), () => indexRows, isRoot)
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'talaria-projects-')) })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); })
  const reset = (projects: Json[] = []): void => { writeFileSync(join(dir, 'projects.json'), JSON.stringify(projects)); indexRows = [] }

  it('each profile gets its own Cron Jobs project', async () => {
    reset()
    const p = store()
    const haku = (await p.ensureSystemProject('cron', 'haku'))
    const kinni = (await p.ensureSystemProject('cron', 'kinni'))
    expect(haku).not.toBe(kinni)
    const rows = (await p.load()).filter((r) => r.name === 'Cron Jobs')
    expect(rows.map((r) => r.profile).sort()).toEqual(['haku', 'kinni'])
  })

  it('repeat calls within one profile answer the same id', async () => {
    reset()
    const p = store()
    expect((await p.ensureSystemProject('cron', 'haku'))).toBe((await p.ensureSystemProject('cron', 'haku')))
    expect((await p.load())).toHaveLength(1)
  })

  it('a legacy untagged Cron Jobs row is reused and tagged with the caller', async () => {
    reset([{ project_id: 'legacy123456', name: 'Cron Jobs', color: '#6366f1' }])
    const p = store()
    expect((await p.ensureSystemProject('cron', 'haku'))).toBe('legacy123456')
    expect((await p.load({ migrate: false }))[0]).toMatchObject({ project_id: 'legacy123456', profile: 'haku' })
  })

  it('under a renamed root the default-tagged cron project is reused', async () => {
    reset([{ project_id: 'rootcron1234', name: 'Cron Jobs', color: '#6366f1', profile: 'default' }])
    const p = store((n) => n === 'default' || n === 'kinni')
    expect((await p.ensureSystemProject('cron', 'kinni'))).toBe('rootcron1234')
    expect((await p.load())).toHaveLength(1)
  })

  it('untagged projects inherit the profile of an assigned session and the backfill persists', async () => {
    reset([{ project_id: 'proj00000001', name: 'Work', color: '#fff' }])
    indexRows = [{ session_id: 's1', project_id: 'proj00000001', profile: 'haku' }]
    const p = store()
    expect((await p.load())[0]).toMatchObject({ profile: 'haku' })
    expect((JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8')) as Json[])[0]).toMatchObject({ profile: 'haku' })
  })

  it('an orphan untagged project falls back to default', async () => {
    reset([{ project_id: 'proj00000002', name: 'Orphan', color: '#fff' }])
    expect((await store().load())[0]).toMatchObject({ profile: 'default' })
  })

  it('a fully tagged projects.json is not rewritten', async () => {
    reset([{ project_id: 'proj00000003', name: 'Tagged', color: '#fff', profile: 'haku' }])
    // An mtime in the past moves on any rewrite.
    utimesSync(join(dir, 'projects.json'), 1, 1)
    const before = statSync(join(dir, 'projects.json')).mtimeMs
    const p = store()
    await p.load()
    await p.load()
    expect(statSync(join(dir, 'projects.json')).mtimeMs).toBe(before)
  })
})
