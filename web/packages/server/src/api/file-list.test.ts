import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'

const fixture = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/workspace-list-visibility.json', import.meta.url), 'utf8')) as {
  files: string[]
  cases: { mode: string; query: Record<string, string>; names: string[] }[]
}

describe('GET /api/list workspace visibility', () => {
  let server: TestServer
  let sessionId: string

  beforeAll(async () => {
    server = await bootTestServer()
    const response = await server.get('/api/session/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: server.workspace }),
    })
    expect(response.status).toBe(200)
    const { session } = await response.json() as { session: { session_id: string } }
    sessionId = session.session_id
    for (const name of fixture.files) writeFileSync(join(server.workspace, name), '')
  })

  afterAll(() => server?.close())

  async function listedNames(query: Record<string, string>): Promise<string[]> {
    const params = new URLSearchParams({ session_id: sessionId, ...query })
    const response = await server.get(`/api/list?${params.toString()}`)
    expect(response.status).toBe(200)
    const { entries } = await response.json() as { entries: { name: string }[] }
    return entries.map((entry) => entry.name)
  }

  it.each(fixture.cases)('returns the expected rows when show_hidden is $mode', async ({ query, names }) => {
    expect(await listedNames(query)).toEqual(names)
  })

  it('counts only visible rows toward the listing limit', async () => {
    const dir = join(server.workspace, 'capped')
    mkdirSync(dir)
    try {
      for (let index = 0; index < 200; index++) writeFileSync(join(dir, `.hidden-${index}`), '')
      writeFileSync(join(dir, 'note.txt'), '')

      expect(await listedNames({ path: 'capped' })).toEqual(['note.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
