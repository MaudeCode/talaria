/**
 * Read-only escape grants (TAL-263): a workspace symlink whose target sits outside the workspace opens through a
 * short-lived token scoped to that one link. File grants never reach siblings, nested escaping links stay
 * display-only, and a grant dies when its link is retargeted, its clock runs out, or another session presents it.
 */
import { closeSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { anchoredAt, EscapeGrantExpired, EscapeGrants, type EscapeRequest } from '../workspace/escape.js'
import { NotFoundError, openAnchoredFd } from '../workspace/fs.js'

type Json = Record<string, unknown>

describe('escape grants', () => {
  let s: TestServer
  let ws: string
  let sid: string
  let outside: string
  let clock = Date.now() / 1000

  const post = async (path: string, body: unknown, headers: Record<string, string> = { origin: s.base }): Promise<{ status: number; body: Json }> => {
    const res = await s.get(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
    return { status: res.status, body: (await res.json()) as Json }
  }
  const getJson = async (path: string): Promise<{ status: number; body: Json }> => {
    const res = await s.get(path)
    return { status: res.status, body: (await res.json()) as Json }
  }
  const byName = (entries: unknown): Record<string, Json> => Object.fromEntries((entries as Json[]).map((e) => [String(e.name), e]))
  const qs = (params: Record<string, string>): string => new URLSearchParams(params).toString()
  const authorize = (path: string, session = sid): Promise<{ status: number; body: Json }> => post('/api/escape/authorize', { session_id: session, path })
  const token = async (path: string, session = sid): Promise<string> => {
    const { status, body } = await authorize(path, session)
    expect(status, JSON.stringify(body)).toBe(200)
    return String(body.token)
  }
  const newSession = async (): Promise<string> => {
    const { status, body } = await post('/api/session/new', { workspace: ws })
    expect(status).toBe(200)
    return String((body.session as Json).session_id)
  }
  /** A fresh directory beside the workspace, so every test owns its outside tree. */
  const outsideDir = (name: string): string => {
    const dir = join(outside, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  beforeAll(async () => {
    s = await bootTestServer({ now: () => clock })
    ws = realpathSync(join(s.state, 'workspace'))
    mkdirSync(ws, { recursive: true })
    sid = await newSession()
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-escape-outside-')))
  })
  afterAll(async () => {
    await s.close()
    rmSync(outside, { recursive: true, force: true })
  })
  beforeEach(() => { clock = Date.now() / 1000 })

  it('reads and raws a file grant through its parent anchor, and never reaches a sibling', async () => {
    const dir = outsideDir('file-grant')
    writeFileSync(join(dir, 'note.txt'), 'outside file')
    writeFileSync(join(dir, 'sibling.txt'), 'SIBLING-BYTES')
    symlinkSync(join(dir, 'note.txt'), join(ws, 'escape-file.txt'))

    const listing = await getJson(`/api/list?${qs({ session_id: sid, path: '.' })}`)
    const row = (listing.body.entries as Json[]).find((e) => e.name === 'escape-file.txt')
    expect(row?.target_outside_workspace).toBe(true)

    expect((await post('/api/escape/authorize', { session_id: sid, path: 'escape-file.txt' }, {})).status).toBe(403)
    expect((await post('/api/escape/authorize', { session_id: sid, path: 'escape-file.txt' }, { referer: `${s.base}/workspace` })).status).toBe(403)
    expect(await post('/api/escape/authorize', { session_id: sid, path: 'escape-file.txt' }, { origin: 'http://evil.example' })).toEqual({ status: 403, body: { error: 'Cross-origin mismatch - check reverse proxy headers' } })

    const auth = await authorize('escape-file.txt')
    expect(auth.status).toBe(200)
    expect(auth.body).toMatchObject({ path: 'escape-file.txt', is_dir: false, expires_in: 300, read_only: true })
    expect(auth.body.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(auth.body.expires_at).toBeCloseTo(clock + 300)
    const t = String(auth.body.token)

    const read = await getJson(`/api/escape/file/read?${qs({ session_id: sid, token: t, path: 'escape-file.txt' })}`)
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ path: 'escape-file.txt', content: 'outside file', escape_read_only: true, preview: 'text' })
    const raw = await s.get(`/api/escape/file/raw?${qs({ session_id: sid, token: t, path: 'escape-file.txt' })}`)
    expect(raw.status).toBe(200)
    expect(await raw.text()).toBe('outside file')

    expect((await getJson(`/api/escape/list?${qs({ session_id: sid, token: t, path: 'escape-file.txt' })}`)).status).toBe(404)
    for (const path of ['sibling.txt', 'escape-file.txt/../sibling.txt', 'escape-file.txt/sibling.txt', '../sibling.txt']) {
      const r = await getJson(`/api/escape/file/read?${qs({ session_id: sid, token: t, path })}`)
      expect(r.status, path).toBe(404)
      expect(JSON.stringify(r.body)).not.toContain('SIBLING-BYTES')
      const rawSibling = await s.get(`/api/escape/file/raw?${qs({ session_id: sid, token: t, path })}`)
      expect(rawSibling.status, path).toBe(404)
      expect(await rawSibling.text()).not.toContain('SIBLING-BYTES')
    }
    for (const body of [read.body, auth.body]) expect(JSON.stringify(body)).not.toContain(outside)
  })

  it('lists, reads, and raws a directory grant under virtual paths that never name the outside root', async () => {
    const dir = outsideDir('dir-grant')
    writeFileSync(join(dir, 'note.txt'), 'outside note')
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, 'nested', 'inside.txt'), 'inside')
    symlinkSync(join(dir, 'note.txt'), join(dir, 'alias.txt'))
    symlinkSync(dir, join(ws, 'escape'))

    const auth = await authorize('escape')
    expect(auth.body).toMatchObject({ path: 'escape', is_dir: true, read_only: true })
    const t = String(auth.body.token)

    const listed = await getJson(`/api/escape/list?${qs({ session_id: sid, token: t, path: 'escape' })}`)
    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({ path: 'escape', virtual_root: 'escape', read_only: true })
    expect(listed.body.signature).toMatch(/^[0-9a-f]{64}$/)
    const entries = byName(listed.body.entries)
    expect(entries['note.txt']).toMatchObject({ path: 'escape/note.txt', type: 'file', escape_read_only: true })
    expect(entries.nested).toMatchObject({ path: 'escape/nested', type: 'dir', escape_read_only: true })
    expect(entries['alias.txt']).toMatchObject({ path: 'escape/alias.txt', type: 'symlink', target: 'escape/note.txt', target_outside_workspace: false, escape_read_only: true })
    expect(JSON.stringify(listed.body)).not.toContain(outside)

    const sub = await getJson(`/api/escape/list?${qs({ session_id: sid, token: t, path: 'escape/nested' })}`)
    expect(sub.body).toMatchObject({ path: 'escape/nested', virtual_root: 'escape' })
    expect((sub.body.entries as Json[]).map((e) => e.path)).toEqual(['escape/nested/inside.txt'])

    const read = await getJson(`/api/escape/file/read?${qs({ session_id: sid, token: t, path: 'escape/nested/inside.txt' })}`)
    expect(read.body).toMatchObject({ path: 'escape/nested/inside.txt', content: 'inside', escape_read_only: true })
    const raw = await s.get(`/api/escape/file/raw?${qs({ session_id: sid, token: t, path: 'escape/note.txt' })}`)
    expect(await raw.text()).toBe('outside note')

    // The grant is the only way in: the ordinary file routes still refuse the escaping link.
    expect((await getJson(`/api/file?${qs({ session_id: sid, path: 'escape/note.txt' })}`)).status).toBe(404)
    expect((await getJson(`/api/escape/list?${qs({ session_id: sid, token: t, path: 'other' })}`)).status).toBe(404)
    expect((await getJson(`/api/escape/list?${qs({ session_id: sid, token: t, path: 'escape/../../etc' })}`)).status).toBe(404)
  })

  it('keeps nested escaping links display-only and refuses a grant for them', async () => {
    const dir = outsideDir('nested-root')
    const second = outsideDir('nested-second')
    writeFileSync(join(second, 'secret.txt'), 'secret')
    symlinkSync(second, join(dir, 'nested-escape'))
    symlinkSync(join(second, 'secret.txt'), join(dir, 'nested-file-escape.txt'))
    symlinkSync(dir, join(ws, 'escape-nested'))

    const t = await token('escape-nested')
    expect((await authorize('escape-nested/nested-escape')).status).toBe(404)

    const listed = await getJson(`/api/escape/list?${qs({ session_id: sid, token: t, path: 'escape-nested' })}`)
    const entries = byName(listed.body.entries)
    expect(entries['nested-escape']).toMatchObject({ path: 'escape-nested/nested-escape', target_outside_workspace: true, escape_read_only: true })
    expect(entries['nested-escape']).not.toHaveProperty('target')
    expect(entries['nested-file-escape.txt']).not.toHaveProperty('target')
    expect(JSON.stringify(listed.body)).not.toContain(second)

    expect((await getJson(`/api/escape/list?${qs({ session_id: sid, token: t, path: 'escape-nested/nested-escape' })}`)).status).toBe(404)
    expect((await getJson(`/api/escape/file/read?${qs({ session_id: sid, token: t, path: 'escape-nested/nested-file-escape.txt' })}`)).status).toBe(404)
    const raw = await s.get(`/api/escape/file/raw?${qs({ session_id: sid, token: t, path: 'escape-nested/nested-file-escape.txt' })}`)
    expect(raw.status).toBe(404)
    expect(await raw.text()).not.toContain('secret')
  })

  it('expires a grant when the link is retargeted or removed, and keeps other live grants', async () => {
    const a = outsideDir('live-a')
    const b = outsideDir('live-b')
    writeFileSync(join(a, 'alpha.txt'), 'alpha')
    writeFileSync(join(b, 'beta.txt'), 'beta')
    symlinkSync(a, join(ws, 'escape-a'))
    symlinkSync(b, join(ws, 'escape-b'))
    const ta = await token('escape-a')
    const tb = await token('escape-b')
    expect(ta).not.toBe(tb)

    const readA = () => getJson(`/api/escape/file/read?${qs({ session_id: sid, token: ta, path: 'escape-a/alpha.txt' })}`)
    expect((await readA()).body.content).toBe('alpha')
    expect((await getJson(`/api/escape/file/read?${qs({ session_id: sid, token: tb, path: 'escape-b/beta.txt' })}`)).body.content).toBe('beta')
    // A token names one link: grant B cannot open link A.
    expect((await getJson(`/api/escape/file/read?${qs({ session_id: sid, token: tb, path: 'escape-a/alpha.txt' })}`)).status).toBe(404)

    unlinkSync(join(ws, 'escape-a'))
    symlinkSync(b, join(ws, 'escape-a'))
    expect(await readA()).toEqual({ status: 403, body: { error: 'Escape authorization expired' } })
    expect((await s.get(`/api/escape/file/raw?${qs({ session_id: sid, token: ta, path: 'escape-a/beta.txt' })}`)).status).toBe(403)
    expect((await getJson(`/api/escape/list?${qs({ session_id: sid, token: ta, path: 'escape-a' })}`)).status).toBe(403)
    // Pointing the link back does not revive a grant that already failed its check.
    unlinkSync(join(ws, 'escape-a'))
    symlinkSync(a, join(ws, 'escape-a'))
    expect((await readA()).status).toBe(403)

    unlinkSync(join(ws, 'escape-b'))
    expect((await getJson(`/api/escape/file/read?${qs({ session_id: sid, token: tb, path: 'escape-b/beta.txt' })}`)).status).toBe(403)
  })

  it('expires a grant after 300 seconds and refuses it from another session or profile', async () => {
    const dir = outsideDir('scoped')
    writeFileSync(join(dir, 'x.txt'), 'x')
    symlinkSync(dir, join(ws, 'escape-scoped'))
    const t = await token('escape-scoped')
    const read = (session: string) => getJson(`/api/escape/file/read?${qs({ session_id: session, token: t, path: 'escape-scoped/x.txt' })}`)

    const other = await newSession()
    expect(await read(other)).toEqual({ status: 403, body: { error: 'Escape authorization expired' } })
    const foreign = await newSession()
    const stored = s.deps.sessionStore.get(foreign)
    stored.profile = 'other'
    s.deps.sessionStore.save(stored)
    expect((await read(foreign)).status).toBe(404)
    expect((await post('/api/escape/authorize', { session_id: foreign, path: 'escape-scoped' })).status).toBe(404)

    clock += 299
    expect((await read(sid)).status).toBe(200)
    clock += 1
    expect(await read(sid)).toEqual({ status: 403, body: { error: 'Escape authorization expired' } })
    expect(await getJson(`/api/escape/file/read?${qs({ session_id: sid, token: 'forged', path: 'escape-scoped/x.txt' })}`)).toEqual({ status: 403, body: { error: 'Escape authorization expired' } })
  })

  it('answers the old status codes for every authorize precondition', async () => {
    const dir = outsideDir('preconditions')
    writeFileSync(join(ws, 'plain.txt'), 'plain')
    symlinkSync(join(ws, 'plain.txt'), join(ws, 'inside-link'))
    symlinkSync(join(dir, 'missing'), join(ws, 'dangling'))
    symlinkSync('/etc', join(ws, 'system-link'))

    expect(await post('/api/escape/authorize', { session_id: sid, path: 'plain.txt', token: 'x' })).toEqual({ status: 400, body: { error: 'token must not be provided' } })
    expect(await post('/api/escape/authorize', { path: 'plain.txt' })).toEqual({ status: 400, body: { error: 'session_id is required' } })
    expect(await post('/api/escape/authorize', { session_id: sid })).toEqual({ status: 400, body: { error: 'path is required' } })
    const big = await post('/api/escape/authorize', { session_id: sid, path: 'x'.repeat(5000) })
    expect(big.status).toBe(400)
    expect(String(big.body.error)).toMatch(/^Request body too large \(\d+ bytes, max 4096\)$/)
    // A chunked body declares no length, so the cap counts the bytes actually read.
    const padded = new TextEncoder().encode(JSON.stringify({ session_id: sid, path: 'plain.txt', pad: 'x'.repeat(5000) }))
    const chunked = await s.get('/api/escape/authorize', { method: 'POST', headers: { 'content-type': 'application/json', origin: s.base }, body: new ReadableStream({ start(c) { c.enqueue(padded); c.close() } }), duplex: 'half' })
    expect(chunked.status).toBe(400)
    expect(String(((await chunked.json()) as Json).error)).toMatch(/^Request body too large \(\d+ bytes, max 4096\)$/)
    expect((await post('/api/escape/authorize', { session_id: 'deadbeef0000', path: 'plain.txt' })).status).toBe(404)
    expect(await authorize('plain.txt')).toEqual({ status: 404, body: { error: 'Path is not an escape-target symlink: plain.txt' } })
    expect(await authorize('inside-link')).toEqual({ status: 404, body: { error: 'Path does not escape workspace: inside-link' } })
    expect(await authorize('dangling')).toEqual({ status: 404, body: { error: 'Path is no longer reachable: dangling' } })
    // Error text passes through the path sanitizer, so absolute spellings never come back.
    expect(await authorize('../outside')).toEqual({ status: 404, body: { error: 'Path traversal blocked: ..<path>' } })
    expect(await authorize('/etc')).toEqual({ status: 404, body: { error: 'Path traversal blocked: <path>' } })
    const system = await authorize('system-link')
    expect(system.status).toBe(404)
    expect(String(system.body.error)).toMatch(/^Path points to a system directory: /)
    expect(String(system.body.error)).not.toContain('/etc')
    expect((await s.get('/api/escape/authorize')).status).toBe(404)
  })

  it('requires session_id and token on the read routes', async () => {
    for (const route of ['/api/escape/list', '/api/escape/file/read', '/api/escape/file/raw']) {
      expect(await getJson(`${route}?${qs({ token: 't', path: '.' })}`), route).toEqual({ status: 400, body: { error: 'session_id is required' } })
      expect(await getJson(`${route}?${qs({ session_id: sid, path: '.' })}`), route).toEqual({ status: 400, body: { error: 'token is required' } })
      expect((await getJson(`${route}?${qs({ session_id: 'deadbeef0000', token: 't', path: '.' })}`)).status, route).toBe(404)
    }
  })

  it('serves raw bytes like /api/file/raw: attachments for dangerous types, sandboxed inline HTML, no-store', async () => {
    const dir = outsideDir('raw')
    writeFileSync(join(dir, 'page.html'), '<p>hi</p>')
    writeFileSync(join(dir, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    symlinkSync(dir, join(ws, 'escape-raw'))
    const t = await token('escape-raw')
    const raw = (path: string, extra: Record<string, string> = {}) => s.get(`/api/escape/file/raw?${qs({ session_id: sid, token: t, path, ...extra })}`)

    let res = await raw('escape-raw/page.html')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    res = await raw('escape-raw/page.html', { inline: '1' })
    expect(res.headers.get('content-disposition')).toMatch(/^inline/)
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox')
    expect(await res.text()).toContain('<base target="_blank">')
    expect((await raw('escape-raw/pic.svg')).headers.get('content-disposition')).toMatch(/^attachment/)
    expect((await raw('escape-raw/pic.svg', { download: '1' })).headers.get('content-disposition')).toMatch(/^attachment/)
    mkdirSync(join(dir, 'sub'))
    for (const path of ['escape-raw/missing.txt', 'escape-raw', 'escape-raw/sub']) {
      for (const extra of [{}, { inline: '1' }]) {
        const r = await raw(path, extra)
        expect(r.status, path).toBe(404)
        expect(await r.json()).toEqual({ error: 'not found' })
      }
    }

    const read = await getJson(`/api/escape/file/read?${qs({ session_id: sid, token: t, path: 'escape-raw/page.html' })}`)
    expect(read.body).toMatchObject({ preview: 'html', preview_url: `api/escape/file/raw?${qs({ session_id: sid, token: t, path: 'escape-raw/page.html', inline: '1' })}` })
    // The query parser decodes keys, so an encoded `token` key still authorizes and must still be masked.
    expect((await s.get(`/api/escape/file/raw?session_id=${sid}&tok%65n=${t}&path=escape-raw/page.html`)).status).toBe(200)
    expect(s.logs.join('\n')).not.toContain(t)
  })
})

/** The per-use re-check and the read are separate steps: a root swapped between them must not redirect the read. */
describe('EscapeGrants root pinning', () => {
  let base: string
  let ws: string
  let dir: string
  let other: string

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-escape-pin-')))
    ws = join(base, 'ws')
    dir = join(base, 'outside')
    other = join(base, 'other')
    mkdirSync(ws)
    mkdirSync(dir)
    mkdirSync(other)
    writeFileSync(join(dir, 'note.txt'), 'granted')
    writeFileSync(join(other, 'note.txt'), 'OTHER-TREE')
    symlinkSync(dir, join(ws, 'escape'))
  })
  afterEach(() => { rmSync(base, { recursive: true, force: true }) })

  const grantFor = (rel: string): [EscapeGrants, EscapeRequest] => {
    const grants = new EscapeGrants(() => Date.now() / 1000)
    const { token } = grants.authorize(ws, 'sid', null, 'escape')
    return [grants, grants.resolve(ws, 'sid', null, token, rel)]
  }

  it('refuses list, read, and raw once the granted root is swapped for a symlink after the re-check', () => {
    const [grants, listReq] = grantFor('escape')
    const readReq = grants.resolve(ws, 'sid', null, grants.authorize(ws, 'sid', null, 'escape').token, 'escape/note.txt')
    renameSync(dir, join(base, 'moved'))
    symlinkSync(other, dir)
    expect(() => grants.list(listReq)).toThrow(NotFoundError)
    expect(() => grants.read(readReq)).toThrow(NotFoundError)
    expect(() => { anchoredAt(readReq, () => { closeSync(openAnchoredFd(readReq.externalRoot, grants.rawTarget(readReq), { wantDir: false })) }) }).toThrow(NotFoundError)
  })

  it('expires the grant when the root is replaced before the re-check', () => {
    const grants = new EscapeGrants(() => Date.now() / 1000)
    const { token } = grants.authorize(ws, 'sid', null, 'escape')
    renameSync(dir, join(base, 'moved'))
    mkdirSync(dir)
    expect(() => grants.resolve(ws, 'sid', null, token, 'escape')).toThrow(EscapeGrantExpired)
  })
})
