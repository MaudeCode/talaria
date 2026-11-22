/**
 * TAL-1342: path completion from a native owner chat's frozen workspace. A synthetic owner answers the sidecar's
 * `complete_path` as the installed owner's `complete.path` does; the real owner's listing is proven by the sidecar's
 * `[complete]` peer mode.
 */
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { PathCompletionsSchema, type GatewaySessionParams, type GatewaySessionResult, type PathCompletions } from '@maudecode/talaria-web-contracts'
import type { TestServer } from '../test/harness.js'
import type { FakeSidecar } from '../sidecar/fake.js'
import { attached, bootOwnerAttachment, sid, snapshot } from '../test/gateway-owner.js'

interface Item { text: string; display: string; meta: string }
const bare = { reason: null, snapshot: null, receipt: null }
const shared = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/web-path-completions.json', import.meta.url), 'utf8')) as {
  before: string; owner: { items: Item[] }; response: PathCompletions }

describe('native owner path completion (TAL-1342)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  let listing: Item[] | GatewaySessionResult
  beforeEach(async () => {
    ({ s, db, sidecar } = await bootOwnerAttachment())
    listing = []
    sidecar.respond('gateway.session', (params) => params.action === 'complete_path'
      ? Array.isArray(listing) ? { state: 'attached', ...bare, completion: { items: listing } } : listing
      : attached(snapshot({ session_id: params.session_id, stored_session_id: params.session_id })))
  })
  afterEach(async () => { db.close(); await s.close() })

  const complete = (before: string, extra: Record<string, unknown> = {}, session = sid, profile = 'default') => s.get('/api/chat/path-completions', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `hermes_profile=${profile}` }, body: JSON.stringify({ session_id: session, before, ...extra }) })
  const read = async (before: string) => {
    const res = await complete(before)
    expect(res.status, await res.clone().text()).toBe(200)
    return PathCompletionsSchema.parse(await res.json())
  }
  const asked = () => sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as GatewaySessionParams).action === 'complete_path')
    .map((c) => c.params as GatewaySessionParams)

  it('completes the partial segment before the caret from the owner listing, in its order', async () => {
    listing = [{ text: 'src/main.py', display: 'main.py', meta: '' }, { text: 'src/mail/', display: 'mail/', meta: 'dir' }]
    const before = 'please read src/ma'
    expect(await read(before)).toEqual({ available: true, reason: null, replace_from: before.indexOf('src/ma'), items: [
      { label: 'main.py', detail: '', kind: 'file', insert: 'src/main.py' },
      { label: 'mail/', detail: '', kind: 'folder', insert: 'src/mail/' },
    ] })
    // Only the word travels: no root, no draft.
    expect(asked()).toEqual([expect.objectContaining({ action: 'complete_path', word: 'src/ma', session_id: sid })])
    expect(Object.keys(asked()[0]!).sort()).toEqual(['action', 'profile_home', 'session_id', 'word'])
  })

  it('quotes a reference value with spaces and keeps Unicode, counting the caret offset in the draft\'s own units', async () => {
    // The shared fixture: the owner's answer for a word after an emoji and an accented word, and the server's rows.
    listing = shared.owner.items
    expect(await read(shared.before)).toEqual(shared.response)
    expect(asked()[0]!.word).toBe('@file:no')
  })

  it('ships at most the bounded count', async () => {
    listing = Array.from({ length: 100 }, (_, i) => ({ text: `f${String(i)}.txt`, display: `f${String(i)}.txt`, meta: '' }))
    const read30 = await read('see ./f')
    expect(read30.items).toHaveLength(30)
    expect(read30.items[0]!.insert).toBe('f0.txt')
  })

  it.each(['cat /etc/pa', 'open ~/.ss', 'read ../sec', 'read src/../../sec', '@file:/etc/pa', '@folder:../', '@file:~/x', 'C:\\Users\\'])(
    'refuses %s as a root of its own without asking the owner', async (before) => {
      expect(await read(before)).toEqual({ available: true, reason: 'outside_workspace', replace_from: null, items: [] })
      expect(asked()).toEqual([])
    })

  it('drops an owner candidate that leaves the frozen workspace', async () => {
    listing = [{ text: '../secret.txt', display: 'secret.txt', meta: '' }, { text: '/Users/me/secret', display: 'secret', meta: '' },
      { text: '@file:~/secret', display: 'secret', meta: '' }, { text: 'src/ok.ts', display: 'ok.ts', meta: '' }]
    expect((await read('src/')).items.map((i) => i.insert)).toEqual(['src/ok.ts'])
  })

  it('offers nothing the typed word already spells', async () => {
    listing = [{ text: 'src/main.py', display: 'main.py', meta: '' }]
    expect(await read('read src/main.py')).toMatchObject({ available: true, items: [] })
  })

  it('refuses a forged root in the request itself', async () => {
    expect((await complete('src/', { cwd: '/elsewhere' })).status).toBe(400)
    expect(asked()).toEqual([])
  })

  it('answers no candidates for a sandboxed backend or a missing directory, listing nothing itself', async () => {
    // The owner answers nothing for a remote, SSH or sandboxed backend, and for a folder its workspace lacks.
    listing = []
    sidecar.calls.length = 0
    expect(await read('absent/')).toEqual({ available: true, reason: null, replace_from: 0, items: [] })
    expect(sidecar.calls.map((c) => c.method).filter((m) => m !== 'gateway.session')).toEqual([])
  })

  it('offers nothing for prose, a slash command or an empty draft, without asking the owner', async () => {
    for (const before of ['', 'hello there', '/model src/', 'trailing space src/ ']) expect((await read(before)).replace_from).toBeNull()
    expect(asked()).toEqual([])
  })

  it('is unavailable under a profile whose Agent does not own the chat, without asking any owner', async () => {
    const other = await complete('src/', {}, sid, 'work')
    expect(other.status).toBe(200)
    expect(PathCompletionsSchema.parse(await other.json())).toEqual({ available: false, reason: 'not_owner_chat', replace_from: null, items: [] })
    expect(asked()).toEqual([])
  })

  it('is unavailable when the owner cannot answer', async () => {
    listing = { state: 'unavailable', ...bare, reason: 'owner_connection_lost' }
    expect(await read('src/')).toEqual({ available: false, reason: 'owner_unavailable', replace_from: null, items: [] })
  })
})
