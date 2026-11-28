import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'

const fixture = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/workspace-list-visibility.json', import.meta.url), 'utf8')) as {
  files: string[]
  cases: { mode: string; query: Record<string, string>; names: string[] }[]
  continuation: { files: string[]; cases: { query: Record<string, string>; names: string[] }[] }
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

  const list = (query: Record<string, string>) => server.get(`/api/list?${new URLSearchParams({ session_id: sessionId, ...query }).toString()}`)

  async function listedPage(query: Record<string, string>) {
    const response = await list(query)
    expect(response.status).toBe(200)
    const { entries, next_cursor } = await response.json() as { entries: { name: string }[]; next_cursor?: string }
    return { names: entries.map((entry) => entry.name), next_cursor }
  }

  it.each(fixture.cases)('returns the expected rows when show_hidden is $mode', async ({ query, names }) => {
    expect((await listedPage(query)).names).toEqual(names)
  })

  it('counts only visible rows toward the listing limit', async () => {
    const dir = join(server.workspace, 'capped')
    mkdirSync(dir)
    try {
      for (let index = 0; index < 200; index++) writeFileSync(join(dir, `.hidden-${index}`), '')
      writeFileSync(join(dir, 'note.txt'), '')

      expect((await listedPage({ path: 'capped' })).names).toEqual(['note.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('continues a mixed directory in server order under the same visibility and path checks', async () => {
    const path = 'paged'
    const dir = join(server.workspace, path)
    const folders = Array.from({ length: 199 }, (_, index) => `Folder-${String(index).padStart(3, '0')}`)
    mkdirSync(dir)
    try {
      for (const name of [...folders].reverse()) mkdirSync(join(dir, name))
      for (const name of fixture.continuation.files) writeFileSync(join(dir, name), '')
      symlinkSync('../note.txt', join(dir, 'Live'))
      symlinkSync('missing.txt', join(dir, 'Broken'))
      symlinkSync('.', join(dir, 'Loop'))

      for (const { query: visibility, names } of fixture.continuation.cases) {
        const query = { path, ...visibility }
        const first = await listedPage(query)
        expect(first.names).toEqual(['Live', ...folders])
        expect(first.next_cursor).toEqual(expect.any(String))
        const cursor = first.next_cursor!
        const second = await listedPage({ ...query, cursor })
        expect(second.names).toEqual(names)
        expect(second.next_cursor).toBeUndefined()
        expect((await list({ ...query, cursor, path: '..' })).status).toBe(404)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
