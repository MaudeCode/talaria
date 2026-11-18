import { spawnSync } from 'node:child_process'
import { readZip } from '../workspace/unzip.js'
import { collectFolder, folderZipMaxBytes, folderZipMaxFiles } from './raw-routes.js'
import { loopTurnsDuring } from '../test/sync-fs.js'
import { homedir, tmpdir } from 'node:os'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { appendFileSync, chmodSync, closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { WORKTREE_RETAIN_RETRY_MS } from '../sessions/service.js'
import { useJsonStorage } from '../test/storage.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

async function newSession(s: TestServer, workspace: string): Promise<string> {
  const res = await post(s, '/api/session/new', { workspace })
  expect(res.status).toBe(200)
  return String(((await json(res)).session as Json).session_id)
}

describe('raw byte routes', () => {
  let s: TestServer
  let ws: string
  let sid: string
  beforeAll(async () => {
    s = await bootTestServer()
    ws = realpathSync(join(s.state, 'workspace'))
    sid = await newSession(s, ws)
    writeFileSync(join(ws, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]))
    writeFileSync(join(ws, 'page.html'), '<!doctype html><html><head><title>t</title></head><body>hi</body></html>')
    mkdirSync(join(ws, 'docs'))
    writeFileSync(join(ws, 'docs', 'a.txt'), 'alpha\n')
    writeFileSync(join(ws, 'docs', 'b.txt'), 'beta\n')
  })
  const outsideDirs: string[] = []
  afterAll(async () => {
    await s.close()
    for (const d of outsideDirs) rmSync(d, { recursive: true, force: true })
  })

  it('serves raw workspace files uncached and unvalidated, with ranges and download/inline dispositions', async () => {
    let res = await s.get(`/api/file/raw?session_id=${sid}&path=photo.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toContain('inline; filename="photo.png"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('etag')).toBeNull()
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer())).toHaveLength(10)

    res = await s.get(`/api/file/raw?session_id=${sid}&path=photo.png`, { headers: { range: 'bytes=2-4' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([0x4e, 0x47, 1]))
    res = await s.get(`/api/file/raw?session_id=${sid}&path=photo.png`, { headers: { range: 'bytes=50-60' } })
    expect(res.status).toBe(416)

    res = await s.get(`/api/file/raw?session_id=${sid}&path=page.html`)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    // TAL-586: an HTML file past the preview buffering cap downloads as an attachment instead of a 413.
    const hugeSize = 11 * 1024 * 1024
    const hugeFd = openSync(join(ws, 'huge.html'), 'w')
    ftruncateSync(hugeFd, hugeSize)
    closeSync(hugeFd)
    res = await s.get(`/api/file/raw?session_id=${sid}&path=huge.html&inline=1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment; filename="huge.html"')
    expect(res.headers.get('content-security-policy')).not.toContain('sandbox')
    expect(res.headers.get('content-length')).toBe(String(hugeSize))
    expect(Buffer.from(await res.arrayBuffer())).toHaveLength(hugeSize)
    res = await s.get(`/api/file/raw?session_id=${sid}&path=page.html&inline=1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox')
    expect(res.headers.get('x-frame-options')).toBeNull()
    // TAL-566: the default policy's report-only twin (`frame-ancestors 'none'`) would report every framed preview.
    expect(res.headers.get('content-security-policy-report-only')).toBeNull()
    expect(await res.text()).toContain('<head><base target="_blank">')
    res = await s.get(`/api/file/raw?session_id=${sid}&path=photo.png&inline=1`)
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.get('content-security-policy-report-only')).toBeNull()
    res = await s.get(`/api/file/raw?session_id=${sid}&path=photo.png`)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy-report-only')).toContain("frame-ancestors 'none'")
    res = await s.get(`/api/file/raw?session_id=${sid}&path=photo.png&download=1`)
    expect(res.headers.get('content-disposition')).toContain('attachment')

    expect((await s.get(`/api/file/raw?session_id=${sid}&path=../settings.json`)).status).toBe(404)
    expect((await s.get(`/api/file/raw?session_id=${sid}&path=missing.txt`)).status).toBe(404)
    expect((await s.get('/api/file/raw?path=photo.png')).status).toBe(400)
  })

  it('serves a multi-megabyte file whole, by range, and by HEAD', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7)
    writeFileSync(join(ws, 'big.bin'), big)
    let res = await s.get(`/api/file/raw?session_id=${sid}&path=big.bin`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(big.length))
    expect(Buffer.from(await res.arrayBuffer()).equals(big)).toBe(true)
    res = await s.get(`/api/file/raw?session_id=${sid}&path=big.bin`, { headers: { range: 'bytes=1048576-1048579' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 1048576-1048579/${String(big.length)}`)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([7, 7, 7, 7]))
    res = await s.get(`/api/file/raw?session_id=${sid}&path=big.bin`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(big.length))
  })

  it('serves cold media ranges under the full response validator and revalidates it', async () => {
    const path = join(ws, 'range-cache.png')
    const bytes = Buffer.from([10, 20, 30, 40])
    writeFileSync(path, bytes)
    const url = `/api/media?path=${encodeURIComponent(path)}`
    let res = await s.get(url, { headers: { range: 'bytes=1-2' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 1-2/4')
    const rangeEtag = res.headers.get('etag')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes.subarray(1, 3))
    res = await s.get(url)
    const etag = res.headers.get('etag')!
    expect(res.status).toBe(200)
    expect(etag).toMatch(/^W\/"/)
    expect(rangeEtag).toBe(etag)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes)
    res = await s.get(url, { headers: { 'if-none-match': etag, range: 'bytes=0-0' } })
    expect(res.status).toBe(304)
    expect(await res.text()).toBe('')
    writeFileSync(path, Buffer.from([50, 60, 70, 80]))
    res = await s.get(url, { headers: { 'if-none-match': etag } })
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).not.toBe(etag)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([50, 60, 70, 80]))
    res = await s.get(url, { headers: { range: 'bytes=4-' } })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */4')
    writeFileSync(path, '')
    res = await s.get(url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('streams a folder as a zip and enforces the caps', async () => {
    let res = await s.get(`/api/folder/download?session_id=${sid}&path=docs`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toContain('filename="docs.zip"')
    const zip = Buffer.from(await res.arrayBuffer())
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(zip.readUInt16LE(zip.length - 12)).toBe(2)
    expect(zip.toString('latin1')).toContain('a.txt')
    expect(zip.toString('latin1')).toContain('b.txt')
    // An independent reader must extract it: Python's zipfile checks the local header (filename length, sizes) against the central directory.
    const zipPath = join(s.state, 'docs.zip')
    writeFileSync(zipPath, zip)
    const listing = spawnSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(",".join(sorted(z.namelist())));print(z.read("a.txt").decode())', zipPath])
    expect(listing.status, listing.stderr.toString()).toBe(0)
    expect(listing.stdout.toString()).toBe('a.txt,b.txt\nalpha\n\n')
    // Every local header carries its filename length (bytes 26–27) so the name is not parsed as data.
    const local = zip.readUInt16LE(26)
    expect(zip.subarray(30, 30 + local).toString()).toMatch(/^[ab]\.txt$/)
    expect((await s.get(`/api/folder/download?session_id=${sid}&path=docs/a.txt`)).status).toBe(400)
    expect((await s.get(`/api/folder/download?session_id=${sid}&path=nope`)).status).toBe(404)
    const capped = await bootTestServer({ env: { TALARIA_WEB_FOLDER_ZIP_MAX_FILES: '1' } })
    try {
      const cws = realpathSync(join(capped.state, 'workspace'))
      mkdirSync(join(cws, 'd'))
      writeFileSync(join(cws, 'd', '1'), '1')
      writeFileSync(join(cws, 'd', '2'), '2')
      const csid = await newSession(capped, cws)
      res = await capped.get(`/api/folder/download?session_id=${csid}&path=d`)
      expect(res.status).toBe(413)
      expect(await json(res)).toEqual({ error: 'too many files', limit: 1, configure: 'TALARIA_WEB_FOLDER_ZIP_MAX_FILES' })
    } finally {
      await capped.close()
    }
  })

  // The descriptor platform never chdirs; this exercises the size cap through the cwd anchor used on macOS.
  it.runIf(process.platform !== 'linux')('a file that grows after the preflight contributes only its admitted bytes to the archive', async () => {
    mkdirSync(join(ws, 'grow'), { recursive: true })
    writeFileSync(join(ws, 'grow', 'log.txt'), 'first\n')
    const realChdir = process.chdir.bind(process)
    let grown = false
    const spy = vi.spyOn(process, 'chdir').mockImplementation((dir: string) => {
      realChdir(dir)
      if (!grown && dir === join(ws, 'grow')) { grown = true; appendFileSync(join(ws, 'grow', 'log.txt'), 'x'.repeat(64 * 1024)) }
    })
    try {
      const res = await s.get(`/api/folder/download?session_id=${sid}&path=grow`)
      expect(res.status).toBe(200)
      const zip = Buffer.from(await res.arrayBuffer())
      expect(grown).toBe(true)
      const entry = readZip(zip).find((e) => e.name === 'log.txt')
      expect((await entry?.read())?.toString()).toBe('first\n')
    } finally {
      spy.mockRestore()
    }
  })

  it('honours the configured folder download limits as given, like Python', () => {
    expect(folderZipMaxBytes({ TALARIA_WEB_FOLDER_ZIP_MAX_MB: '999999' })).toBe(999999 * 1024 * 1024)
    expect(folderZipMaxBytes({ TALARIA_WEB_FOLDER_ZIP_MAX_MB: '512' })).toBe(512 * 1024 * 1024)
    expect(folderZipMaxFiles({ TALARIA_WEB_FOLDER_ZIP_MAX_FILES: '1000000' })).toBe(1000000)
    expect(folderZipMaxFiles({})).toBe(50000)
  })

  it('exports the transcript as JSON and self-contained HTML', async () => {
    const session = (await s.deps.sessionStore.get(sid))
    session.messages = [{ role: 'user', content: 'Hello **world**' }, { role: 'assistant', content: 'Look ![x](https://evil.example/leak.png)\n\n```py\nprint(1)\n```' }]
    await s.deps.sessionStore.save(session)
    let res = await s.get(`/api/session/export?session_id=${sid}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="hermes-${sid}.json"`)
    const doc = JSON.parse(await res.text()) as Json
    expect(doc.session_id).toBe(sid)
    expect((doc.messages as Json[]).map((m) => m.role)).toEqual(['user', 'assistant'])
    res = await s.get(`/api/session/export?session_id=${sid}&format=html&theme=light&palette=${Buffer.from(JSON.stringify({ '--bg': '#fff', bad: 'expression(1)' })).toString('base64')}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await res.text()
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('Exported from Talaria Web on ')
    expect(html).toContain('<strong>world</strong>')
    expect(html).toContain('<code>[image: https://evil.example/leak.png]</code>')
    expect(html).not.toContain('<img src="https://evil.example')
    expect(html).toContain('<pre><code class="language-py">print(1)')
    expect(html).toContain(':root,:root.dark{--bg:#fff;}')
    expect(html).not.toContain('expression(')
    expect((await s.get('/api/session/export?session_id=deadbeef0000')).status).toBe(404)
  })

  it('exports the shown transcript rows as Markdown (TAL-607)', async () => {
    const session = (await s.deps.sessionStore.get(sid))
    session.messages = [{ role: 'system', content: 'secret system prompt' }, { role: 'user', content: [{ type: 'text', text: 'Hello **world**' }] }, { role: 'tool', content: 'tool output' }, { role: 'assistant', content: 'silent background reply', _background_silent: true }, { role: 'assistant', content: '<think>private plan</think>Done.' }]
    await s.deps.sessionStore.save(session)
    const res = await s.get(`/api/session/export?session_id=${sid}&format=markdown`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="hermes-${sid}.md"`)
    const md = await res.text()
    expect(md).toContain(`Session: ${sid}`)
    expect(md).toContain('## You\n\nHello **world**\n\n## Assistant\n\nDone.\n')
    expect(md).not.toContain('secret system prompt')
    expect(md).not.toContain('tool output')
    // Only rows the server shows as their own row, with the reply's prose and not its inline thinking.
    expect(md).not.toContain('silent background reply')
    expect(md).not.toContain('private plan')
  })

  it.each(['md', 'legacy-unknown'])('preserves the direct JSON fallback for format %s', async (format) => {
    const session = await s.deps.sessionStore.get(sid)
    session.title = 'Legacy export content'
    await s.deps.sessionStore.save(session)
    const res = await s.get(`/api/session/export?session_id=${sid}&format=${format}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toMatchObject({ session_id: sid, title: 'Legacy export content' })
  })

  it('accepts multipart uploads into the session inbox and rolls them back by receipt', async () => {
    const boundary = 'xyz'
    const body = [`--${boundary}`, 'Content-Disposition: form-data; name="session_id"', '', sid, `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="../evil name.txt"', 'Content-Type: text/plain', '', 'payload', `--${boundary}--`, ''].join('\r\n')
    let res = await s.get('/api/upload', { method: 'POST', body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })
    expect(res.status).toBe(200)
    const upload = await json(res)
    expect(upload.filename).toBe('evil_name.txt')
    expect(upload.mime).toBe('text/plain')
    expect(upload.is_image).toBe(false)
    // The server names every attached file in the prompt and keeps at most 20 per message, so clients send
    // the bare draft and stage no more (TAL-635).
    expect(upload.named_in_prompt).toBe(true)
    expect(upload.max_attachments_per_message).toBe(20)
    expect(String(upload.path)).toBe(join(realpathSync(s.state), 'attachments', sid, 'evil_name.txt'))
    expect(readFileSync(String(upload.path), 'utf8')).toBe('payload')
    // A second upload with the same name is stored as `name-1.ext` and the response reports the stored name.
    res = await s.get('/api/upload', { method: 'POST', body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })
    expect(res.status).toBe(200)
    const second = await json(res)
    expect(second.filename).toBe('evil_name-1.txt')
    expect(String(second.path)).toBe(join(realpathSync(s.state), 'attachments', sid, 'evil_name-1.txt'))
    expect(readFileSync(String(upload.path), 'utf8')).toBe('payload')
    expect(readFileSync(String(second.path), 'utf8')).toBe('payload')
    // The inbox also backs /api/file/raw for the session.
    res = await s.get(`/api/file/raw?session_id=${sid}&path=evil_name.txt`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('payload')

    res = await post(s, '/api/upload/rollback', { session_id: sid, rollback_tokens: [upload.rollback_token] })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, rolled_back: 1, failed: 0 })
    expect(existsSync(String(upload.path))).toBe(false)
    res = await post(s, '/api/upload/rollback', { session_id: sid, rollback_tokens: [upload.rollback_token] })
    expect(await json(res)).toEqual({ ok: false, rolled_back: 0, failed: 1 })
    expect((await post(s, '/api/upload/rollback', { session_id: sid, rollback_tokens: [] })).status).toBe(400)
    const noFile = [`--${boundary}`, 'Content-Disposition: form-data; name="session_id"', '', sid, `--${boundary}--`, ''].join('\r\n')
    res = await s.get('/api/upload', { method: 'POST', body: noFile, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })
    expect(res.status).toBe(400)
    expect(await json(res)).toEqual({ error: 'No file field in request' })
  })

  // The descriptor platform never resolves the leaf by pathname; this exercises the cwd anchor used on macOS.
  it.runIf(process.platform !== 'linux')('a media file swapped for a symlink after the containment checks is not followed', async () => {
    writeFileSync(join(ws, 'late.png'), 'png-bytes')
    writeFileSync(join(s.state, 'settings.json'), '{"secret":true}')
    const realChdir = process.chdir.bind(process)
    let swapped = false
    const spy = vi.spyOn(process, 'chdir').mockImplementation((dir: string) => {
      realChdir(dir)
      if (!swapped && dir === ws) {
        swapped = true
        rmSync(join(ws, 'late.png'))
        symlinkSync(join(s.state, 'settings.json'), join(ws, 'late.png'))
      }
    })
    try {
      const res = await s.get(`/api/media?path=${encodeURIComponent(join(ws, 'late.png'))}`)
      expect(swapped).toBe(true)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('secret')
    } finally {
      spy.mockRestore()
      rmSync(join(ws, 'late.png'), { force: true })
    }
  })

  it.runIf(process.platform !== 'linux')('a media file swapped for a hard link to a state file after the policy check is refused on the opened inode', async () => {
    writeFileSync(join(ws, 'late-link.png'), 'png-bytes')
    writeFileSync(join(s.state, 'settings.json'), '{"secret":true}')
    const realChdir = process.chdir.bind(process)
    let swapped = false
    const spy = vi.spyOn(process, 'chdir').mockImplementation((dir: string) => {
      realChdir(dir)
      if (!swapped && dir === ws) {
        swapped = true
        rmSync(join(ws, 'late-link.png'))
        linkSync(join(s.state, 'settings.json'), join(ws, 'late-link.png'))
      }
    })
    try {
      const res = await s.get(`/api/media?path=${encodeURIComponent(join(ws, 'late-link.png'))}`)
      expect(swapped).toBe(true)
      expect(res.status).toBe(403)
      expect(await res.text()).not.toContain('secret')
    } finally {
      spy.mockRestore()
      rmSync(join(ws, 'late-link.png'), { force: true })
    }
  })

  it('serves media only from allowed roots and denies Hermes state files', async () => {
    let res = await s.get(`/api/media?path=${encodeURIComponent(join(ws, 'photo.png'))}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('private, no-cache')
    const etag = res.headers.get('etag')
    expect(etag).toMatch(/^W\/"/)
    res = await s.get(`/api/media?path=${encodeURIComponent(join(ws, 'photo.png'))}`, { headers: { 'if-none-match': etag ?? '' } })
    expect(res.status).toBe(304)
    // Hermes home is allowed, but its state files are hard-denied.
    writeFileSync(join(s.state, 'settings.json'), '{}')
    res = await s.get(`/api/media?path=${encodeURIComponent(join(s.state, 'settings.json'))}`)
    expect(res.status).toBe(403)
    expect(await json(res)).toEqual({ error: 'Path not in allowed location' })
    mkdirSync(join(s.state, 'sessions'), { recursive: true })
    writeFileSync(join(s.state, 'sessions', 'x.png'), 'x')
    expect((await s.get(`/api/media?path=${encodeURIComponent(join(s.state, 'sessions', 'x.png'))}`)).status).toBe(403)
    expect((await s.get('/api/media?path=/etc/hosts')).status).toBe(403)
    expect((await s.get('/api/media')).status).toBe(400)
    expect((await s.get(`/api/media?path=${encodeURIComponent(join(ws, 'missing.png'))}`)).status).toBe(404)
    // A session's assistant MEDIA: token grants a path outside the roots (but never a user-authored one).
    // Anything under HERMES_HOME or the private temp root is already allowed; ~/.cache is outside every root.
    mkdirSync(join(homedir(), '.cache'), { recursive: true })
    const outside = mkdtempSync(join(homedir(), '.cache', 'talaria-media-test-'))
    outsideDirs.push(outside)
    writeFileSync(join(outside, 'shot.png'), 'png')
    const session = (await s.deps.sessionStore.get(sid))
    session.messages = [{ role: 'user', content: `MEDIA:${join(outside, 'shot.png')}` }]
    await s.deps.sessionStore.save(session)
    expect((await s.get(`/api/media?session_id=${sid}&path=${encodeURIComponent(join(outside, 'shot.png'))}`)).status).toBe(403)
    session.messages = [{ role: 'assistant', content: `Here: MEDIA:${join(outside, 'shot.png')}` }]
    await s.deps.sessionStore.save(session)
    expect((await s.get(`/api/media?session_id=${sid}&path=${encodeURIComponent(join(outside, 'shot.png'))}`)).status).toBe(200)
    // There is no snapshot store: a `snap=` digest is ignored and the live file is served.
    res = await s.get(`/api/media?path=${encodeURIComponent(join(ws, 'photo.png'))}&snap=${'a'.repeat(64)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-cache')
    // A leading tilde is not expanded (Python `Path(raw).resolve()`), so it never reaches an allowed root.
    expect((await s.get(`/api/media?path=${encodeURIComponent('~/photo.png')}`)).status).not.toBe(200)
    expect((await s.get(`/api/media?path=${encodeURIComponent(join(ws, 'page.html'))}`)).headers.get('content-disposition')).toContain('attachment')
    expect((await s.get(`/api/media?path=${encodeURIComponent(join(ws, 'page.html'))}&inline=1`)).headers.get('content-security-policy')).toBe('sandbox allow-scripts')
  })

  describe('/api/media session reads (TAL-1730)', () => {
    afterEach(() => { vi.restoreAllMocks() })
    const store = () => s.deps.sessionStore
    const backend = () => store().deps.storage.sessions
    const media = (id: string, path: string): Promise<Response> => s.get(`/api/media?session_id=${id}&path=${encodeURIComponent(path)}`)

    /** A saved session that is not resident, so the next request has to read it from storage. */
    async function coldSession(content: string): Promise<string> {
      const id = await newSession(s, ws)
      const session = await store().get(id)
      session.messages = [{ role: 'assistant', content }]
      await store().save(session)
      store().sessions.delete(id)
      return id
    }
    function outsideFiles(...names: string[]): string[] {
      mkdirSync(join(homedir(), '.cache'), { recursive: true })
      const dir = mkdtempSync(join(homedir(), '.cache', 'talaria-media-test-'))
      outsideDirs.push(dir)
      return names.map((name) => { writeFileSync(join(dir, name), 'png'); return join(dir, name) })
    }
    /** Whether each storage read of `id` from here on was metadata-only. */
    function storageReads(id: string): () => boolean[] {
      const spy = vi.spyOn(backend(), 'readDocument')
      return () => spy.mock.calls.filter(([sid]) => sid === id).map(([, opts]) => opts?.metadataOnly ?? false)
    }

    it('authorizes a path under a root from the session metadata alone', async () => {
      const id = await coldSession('no references')
      const get = vi.spyOn(store(), 'get')
      const reads = storageReads(id)
      expect((await media(id, join(ws, 'photo.png'))).status).toBe(200)
      expect(get.mock.calls.filter(([sid]) => sid === id).map(([, opts]) => opts)).toEqual([{ metadataOnly: true }])
      expect(reads()).not.toContain(false)
    })

    it('reads the transcript once for two paths only its MEDIA references authorize', async () => {
      const [first, second] = outsideFiles('first.png', 'second.png') as [string, string]
      const id = await coldSession(`MEDIA:${first} MEDIA:${second}`)
      const reads = storageReads(id)
      expect((await media(id, first)).status).toBe(200)
      expect((await media(id, second)).status).toBe(200)
      expect(reads().filter((metadataOnly) => !metadataOnly)).toHaveLength(1)
    })

    it('refuses a denied path or a type no reference can grant without reading the transcript', async () => {
      writeFileSync(join(s.state, 'settings.json'), '{}')
      const [notes] = outsideFiles('notes.txt') as [string]
      const id = await coldSession(`MEDIA:${notes}`)
      const reads = storageReads(id)
      expect((await media(id, join(s.state, 'settings.json'))).status).toBe(403)
      expect((await media(id, notes)).status).toBe(403)
      expect(reads()).not.toContain(false)
    })

    it('gives no grant from a transcript whose full read shows a profile without local IO', async () => {
      const [shot] = outsideFiles('shot.png') as [string]
      const id = await coldSession(`MEDIA:${shot}`)
      const read = backend().readDocument.bind(backend())
      // A legacy document keeps its profile past the transcript, where a metadata read stops.
      vi.spyOn(backend(), 'readDocument').mockImplementation(async (sid, opts) => {
        const stored = await read(sid)
        if (!stored || !opts?.metadataOnly) return stored
        const { profile: _late, ...doc } = stored.doc
        return { ...stored, doc, messages: [], metadataOnly: true }
      })
      vi.spyOn(s.deps.workspaces, 'profileSupportsLocalIo').mockImplementation((profile) => profile !== 'default')
      expect((await media(id, shot)).status).toBe(403)
    })
  })

  it('reports worktree status for a worktree-backed session', async () => {
    const res = await s.get(`/api/session/worktree/status?session_id=${sid}`)
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Session is not worktree-backed')
    const session = (await s.deps.sessionStore.get(sid))
    session.worktree_path = join(s.state, 'missing-worktree')
    await s.deps.sessionStore.save(session)
    const status = (await json(await s.get(`/api/session/worktree/status?session_id=${sid}`))).status as Json
    expect(status).toMatchObject({ exists: false, dirty: false, listed: false, locked_by_stream: false })
    const remove = await post(s, '/api/session/worktree/remove', { session_id: sid })
    expect(remove.status).toBe(200)
    expect((await json(remove)).warnings).toEqual(['Worktree directory no longer exists on disk.'])
  })
})

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

/** A clone with an upstream plus one linked worktree, the shape `worktree_status_for_session` was written against. */
function gitFixture(root: string): { repo: string; worktree: string } {
  const upstream = join(root, 'upstream.git')
  mkdirSync(upstream, { recursive: true })
  git(upstream, 'init', '--bare', '--quiet', '-b', 'main')
  const repo = join(root, 'repo')
  git(root, 'clone', '--quiet', upstream, repo)
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'init')
  git(repo, 'push', '--quiet', '-u', 'origin', 'main')
  const worktree = join(root, 'wt')
  git(repo, 'worktree', 'add', '--quiet', '-b', 'hermes/wt', worktree)
  git(worktree, 'push', '--quiet', '-u', 'origin', 'hermes/wt')
  return { repo, worktree }
}

describe('worktree-backed sessions', () => {
  useJsonStorage()
  let s: TestServer
  let sidecar: FakeSidecar
  let ws: string
  let configs: Map<string, Json>
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    configs = new Map()
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: configs.get(params.profile_home) ?? {} }))
    sidecar.respond('worktree.create', (params) => {
      if (!existsSync(join(params.repo_root, '.git'))) throw new SidecarError(`${params.repo_root} is not inside a git repository`, { condition: 'not_a_repo' })
      const path = join(params.repo_root, '.worktrees', 'hermes-wt')
      mkdirSync(path, { recursive: true })
      return { path, branch: 'hermes/wt', repo_root: params.repo_root, base: null }
    })
    s = await bootTestServer({ sidecar })
    ws = realpathSync(join(s.state, 'workspace'))
    mkdirSync(join(ws, '.git'), { recursive: true })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
  })
  afterAll(() => s.close())
  const setConfig = (cfg: Json): void => { configs.set(s.state, cfg); s.deps.agentConfig.invalidate() }

  it('session/new with worktree:true answers the worktree as the workspace', async () => {
    const res = await post(s, '/api/session/new', { workspace: ws, worktree: true, profile: 'default' })
    expect(res.status).toBe(200)
    const session = (await json(res)).session as Json
    expect(session.worktree_path).toBe(join(ws, '.worktrees', 'hermes-wt'))
    expect(session.workspace).toBe(session.worktree_path)
    expect(session.worktree_branch).toBe('hermes/wt')
  })

  it('the four worktree keys persist in the session file and reload through the API', async () => {
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    const sid = String(created.session_id)
    const raw = JSON.parse(readFileSync(join(s.state, 'sessions', `${sid}.json`), 'utf8')) as Json
    expect(raw).toMatchObject({ worktree_path: created.worktree_path, worktree_branch: 'hermes/wt', worktree_repo_root: ws })
    expect(typeof raw.worktree_created_at).toBe('number')
    const detail = (await json(await s.get(`/api/session?session_id=${sid}`))).session as Json
    expect(detail).toMatchObject({ worktree_path: created.worktree_path, worktree_branch: 'hermes/wt', worktree_repo_root: ws })
  })

  it('a worktree session is written at creation, not on first message', async () => {
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    expect(existsSync(join(s.state, 'sessions', `${String(created.session_id)}.json`))).toBe(true)
    const plain = (await json(await post(s, '/api/session/new', { workspace: ws }))).session as Json
    expect(existsSync(join(s.state, 'sessions', `${String(plain.session_id)}.json`))).toBe(false)
  })

  it('the HTTP sidebar list shows a zero-message worktree session, which owns a directory on disk (TAL-605)', async () => {
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    const plain = (await json(await post(s, '/api/session/new', { workspace: ws }))).session as Json
    const rows = (await json(await s.get('/api/sessions'))).sessions as Json[]
    expect(rows.find((r) => r.session_id === created.session_id)).toMatchObject({ worktree_branch: 'hermes/wt' })
    expect(rows.map((r) => r.session_id)).not.toContain(plain.session_id)
  })

  it('worktree:true without a workspace falls back to the last workspace', async () => {
    await post(s, '/api/session/new', { workspace: ws })
    const res = await post(s, '/api/session/new', { worktree: true })
    expect(res.status).toBe(200)
    const session = (await json(res)).session as Json
    expect(session.worktree_repo_root).toBe(ws)
    expect(session.workspace).toBe(join(ws, '.worktrees', 'hermes-wt'))
  })

  it('no worktree key and config off is a plain session without worktree_skipped', async () => {
    setConfig({})
    const body = await json(await post(s, '/api/session/new', { workspace: ws, profile: 'default' }))
    expect((body.session as Json).worktree_path ?? null).toBeNull()
    expect('worktree_skipped' in body).toBe(false)
  })

  it('config worktree:true creates a worktree when the key is absent', async () => {
    setConfig({ worktree: true })
    const session = (await json(await post(s, '/api/session/new', { workspace: ws, profile: 'default' }))).session as Json
    expect(session.worktree_path).toBe(join(ws, '.worktrees', 'hermes-wt'))
    expect(session.workspace).toBe(session.worktree_path)
    expect(session.worktree_branch).toBe('hermes/wt')
  })

  it('worktree:false wins over the config default', async () => {
    setConfig({ worktree: true })
    const before = sidecar.calls.filter((c) => c.method === 'worktree.create').length
    const session = (await json(await post(s, '/api/session/new', { workspace: ws, profile: 'default', worktree: false }))).session as Json
    expect(session.worktree_path ?? null).toBeNull()
    expect(sidecar.calls.filter((c) => c.method === 'worktree.create').length).toBe(before)
  })

  it('sending worktree:null is explicit and never falls through to the config', async () => {
    setConfig({ worktree: true })
    const session = (await json(await post(s, '/api/session/new', { workspace: ws, profile: 'default', worktree: null }))).session as Json
    expect(session.worktree_path ?? null).toBeNull()
  })

  it('worktree:true wins over a config default of off', async () => {
    setConfig({ worktree: false })
    const session = (await json(await post(s, '/api/session/new', { workspace: ws, profile: 'default', worktree: true }))).session as Json
    expect(session.worktree_path).toBe(join(ws, '.worktrees', 'hermes-wt'))
  })

  it('the config default degrades to a plain session with worktree_skipped outside git', async () => {
    setConfig({ worktree: true })
    const plainDir = join(ws, 'plain-ws')
    mkdirSync(plainDir, { recursive: true })
    const body = await json(await post(s, '/api/session/new', { workspace: plainDir, profile: 'default' }))
    expect((body.session as Json).worktree_path ?? null).toBeNull()
    expect(String(body.worktree_skipped)).toContain('not inside a git repository')
  })

  it('an explicit worktree request outside git is a hard 400', async () => {
    setConfig({})
    const plainDir = join(ws, 'plain-ws2')
    mkdirSync(plainDir, { recursive: true })
    const res = await post(s, '/api/session/new', { workspace: plainDir, worktree: true })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toContain('not inside a git repository')
  })

  it('a remote-terminal profile skips the host worktree and reports worktree_skipped', async () => {
    setConfig({ worktree: true, terminal: { backend: 'remote', cwd: ws } })
    const res = await post(s, '/api/session/new', { workspace: ws, profile: 'default' })
    const body = await json(res)
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect((body.session as Json).worktree_path ?? null).toBeNull()
    expect(body.worktree_skipped).toBeTruthy()
    setConfig({})
  })

  it('an explicit worktree on a remote-terminal profile answers 400 remote_workspace_unsupported', async () => {
    setConfig({ terminal: { backend: 'remote', cwd: ws } })
    const before = sidecar.calls.filter((c) => c.method === 'worktree.create').length
    const res = await post(s, '/api/session/new', { workspace: ws, profile: 'default', worktree: true })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('remote_workspace_unsupported')
    expect(sidecar.calls.filter((c) => c.method === 'worktree.create').length).toBe(before)
    setConfig({})
  })

  it('deleting a worktree session keeps the worktree and reports it', async () => {
    setConfig({})
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    const sid = String(created.session_id)
    const res = await post(s, '/api/session/delete', { session_id: sid })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body, JSON.stringify(body)).toMatchObject({ ok: true, state_db_cleanup_failed: false, worktree_retained: true, worktree_path: created.worktree_path, worktree_branch: 'hermes/wt' })
    expect(existsSync(join(s.state, 'sessions', `${sid}.json`))).toBe(false)
    expect(existsSync(String(created.worktree_path))).toBe(true)
  })

  it('archiving a worktree session keeps the worktree and reports it', async () => {
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    const res = await post(s, '/api/session/archive', { session_id: created.session_id, archived: true })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toMatchObject({ ok: true, worktree_retained: true, worktree_path: created.worktree_path })
    expect((body.session as Json).archived).toBe(true)
    expect(existsSync(String(created.worktree_path))).toBe(true)
  })

  it('delete answers 409 while a run is live and leaves the files alone', async () => {
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    const sid = String(created.session_id)
    s.deps.registry.registerActiveRun({ stream_id: 'live-run-1', session_id: sid, phase: 'cancelling', started_at: Date.now() / 1000 } as never)
    try {
      const res = await post(s, '/api/session/delete', { session_id: sid })
      expect(res.status).toBe(409)
      expect(String((await json(res)).error)).toContain('active run')
      expect(existsSync(join(s.state, 'sessions', `${sid}.json`))).toBe(true)
      expect(readFileSync(join(s.state, 'sessions', '_index.json'), 'utf8')).toContain(sid)
    } finally {
      s.deps.registry.activeRuns.delete('live-run-1')
    }
    expect((await post(s, '/api/session/delete', { session_id: sid })).status).toBe(200)
  })

  it('an unlink failure answers 500 and prunes nothing', async () => {
    const created = (await json(await post(s, '/api/session/new', { workspace: ws, worktree: true }))).session as Json
    const sid = String(created.session_id)
    const dir = join(s.state, 'sessions')
    // Let the creation's index flush commit before the directory turns read-only.
    await s.deps.sessionStore.index()
    chmodSync(dir, 0o500)
    try {
      const res = await post(s, '/api/session/delete', { session_id: sid })
      expect(res.status).toBe(500)
      expect(await json(res)).toEqual({ error: 'Failed to delete session data' })
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(existsSync(join(s.state, 'sessions', `${sid}.json`))).toBe(true)
    expect(readFileSync(join(s.state, 'sessions', '_index.json'), 'utf8')).toContain(sid)
    expect((await s.get(`/api/session?session_id=${sid}`)).status).toBe(200)
  })
})

describe('worktree status against a real git worktree', () => {
  useJsonStorage()
  let s: TestServer
  let repo = ''
  let worktree = ''
  let sid = ''
  beforeAll(async () => {
    s = await bootTestServer()
    const fixture = gitFixture(join(realpathSync(join(s.state, 'workspace')), 'git'))
    repo = fixture.repo
    worktree = fixture.worktree
    sid = String(((await json(await post(s, '/api/session/new', { workspace: repo }))).session as Json).session_id)
    const session = (await s.deps.sessionStore.get(sid))
    session.worktree_path = worktree
    session.worktree_repo_root = repo
    session.worktree_branch = 'hermes/wt'
    await s.deps.sessionStore.save(session)
  })
  afterAll(() => s.close())
  const status = async (): Promise<Json> => (await json(await s.get(`/api/session/worktree/status?session_id=${sid}`))).status as Json

  it('locked_by_stream follows the live stream registry', async () => {
    const session = (await s.deps.sessionStore.get(sid))
    session.active_stream_id = 'stream-live'
    await s.deps.sessionStore.save(session)
    s.deps.registry.liveIds.add('stream-live')
    expect(await status()).toMatchObject({ locked_by_stream: true, removable: false })
    s.deps.registry.liveIds.delete('stream-live')
    expect(await status()).toMatchObject({ locked_by_stream: false, removable: true })
  })
})

describe('TAL-1254: a restarted sidecar retains the worktree chats before it is ready', () => {
  useJsonStorage()
  let s: TestServer
  let sidecar: FakeSidecar
  let ws: string
  const retained: { status: string; paths: string[] }[] = []
  let missing = new Set<string>()
  let unconfirmed = new Set<string>()
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    let created = 0
    sidecar.respond('worktree.create', (params) => {
      const path = join(params.repo_root, '.worktrees', `hermes-${++created}`)
      mkdirSync(path, { recursive: true })
      return { path, branch: `hermes/${created}`, repo_root: params.repo_root, base: null }
    })
    sidecar.respond('worktree.retain', (params) => {
      retained.push({ status: sidecar.status, paths: [...params.paths].sort() })
      return { results: Object.fromEntries(params.paths.filter((p) => !unconfirmed.has(p)).map((p) => [p, missing.has(p) ? 'missing' as const : 'retained' as const])) }
    })
    s = await bootTestServer({ sidecar })
    ws = realpathSync(join(s.state, 'workspace'))
    mkdirSync(join(ws, '.git'), { recursive: true })
  })
  afterAll(() => s.close())
  const create = async (body: Json = { workspace: ws, worktree: true }): Promise<Json> => (await json(await post(s, '/api/session/new', body))).session as Json
  const detail = async (sid: unknown): Promise<Json> => (await json(await s.get(`/api/session?session_id=${String(sid)}`))).session as Json

  it('retains exactly the unarchived worktree paths and flags a missing one as retained', async () => {
    const [kept, gone, archived] = [await create(), await create(), await create()]
    await create({ workspace: ws })
    await post(s, '/api/session/archive', { session_id: archived.session_id, archived: true })
    missing = new Set([String(gone.worktree_path)])
    retained.length = 0

    await sidecar.restart()

    expect(retained).toEqual([{ status: 'starting', paths: [String(kept.worktree_path), String(gone.worktree_path)].sort() }])
    expect(await detail(gone.session_id)).toMatchObject({ worktree_retained: true, worktree_path: gone.worktree_path, worktree_branch: gone.worktree_branch })
    expect((await detail(kept.session_id)).worktree_retained).toBeUndefined()

    missing = new Set()
    retained.length = 0
    await post(s, '/api/session/archive', { session_id: archived.session_id, archived: false })
    s.deps.sessionStore.sessions.delete(String(gone.session_id)) // read back from its file, as after a Web restart
    await sidecar.restart()
    expect(retained).toEqual([{ status: 'ready', paths: [String(archived.worktree_path)] }, { status: 'starting', paths: [String(kept.worktree_path), String(gone.worktree_path), String(archived.worktree_path)].sort() }])
    expect((await detail(gone.session_id)).worktree_retained).toBeUndefined()
  })

  it('retains a worktree chat the session index lost or still lists as archived', async () => {
    const [lost, unarchived] = [await create(), await create()]
    await s.deps.sessionStore.pruneFromIndex(String(lost.session_id))
    const row = (await s.deps.sessionStore.readIndexEntries()).find((r) => r.session_id === unarchived.session_id)
    await s.deps.sessionStore.writeIndex([{ ...row, archived: true }])
    retained.length = 0

    await sidecar.restart()

    expect(retained.flatMap((call) => call.paths)).toEqual(expect.arrayContaining([String(lost.worktree_path), String(unarchived.worktree_path)]))
  })

  it('retains an unreadable worktree chat from its index row and retries until its file reads', async () => {
    const unreadable = await create()
    const file = join(s.state, 'sessions', `${String(unreadable.session_id)}.json`)
    s.deps.sessionStore.sessions.delete(String(unreadable.session_id))
    chmodSync(file, 0)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      retained.length = 0
      await sidecar.restart()
      expect(retained.flatMap((call) => call.paths)).toContain(String(unreadable.worktree_path))
      chmodSync(file, 0o644)
      retained.length = 0
      await vi.advanceTimersByTimeAsync(WORKTREE_RETAIN_RETRY_MS)
      await vi.waitFor(() => { expect(retained.flatMap((call) => call.paths)).toContain(String(unreadable.worktree_path)) })
    } finally {
      chmodSync(file, 0o644)
      vi.useRealTimers()
    }
  })

  it('keeps retrying while the session directory cannot be listed', async () => {
    const listed = await create()
    const dir = join(s.state, 'sessions')
    chmodSync(dir, 0)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      retained.length = 0
      await sidecar.restart()
      chmodSync(dir, 0o755)
      await vi.advanceTimersByTimeAsync(WORKTREE_RETAIN_RETRY_MS)
      await vi.waitFor(() => { expect(retained.flatMap((call) => call.paths)).toContain(String(listed.worktree_path)) })
    } finally {
      chmodSync(dir, 0o755)
      vi.useRealTimers()
    }
  })

  it('retries a worktree the sidecar could not lock until it confirms it', async () => {
    const pending = await create()
    unconfirmed = new Set([String(pending.worktree_path)])
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await sidecar.restart()
      retained.length = 0
      unconfirmed = new Set()
      await vi.advanceTimersByTimeAsync(WORKTREE_RETAIN_RETRY_MS)
      await vi.waitFor(() => { expect(retained.flatMap((call) => call.paths)).toContain(String(pending.worktree_path)) })
      retained.length = 0
      await vi.advanceTimersByTimeAsync(WORKTREE_RETAIN_RETRY_MS)
      expect(retained).toEqual([])
    } finally { vi.useRealTimers() }
  })
})

describe('folder download walk (TAL-1699)', () => {
  it('yields the event loop while walking a 5,000-file folder and lists the files in walk order', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-folder-walk-')))
    try {
      for (let d = 0; d < 50; d += 1) {
        mkdirSync(join(root, `d${String(d)}`, 'nested'), { recursive: true })
        for (let f = 0; f < 50; f += 1) {
          writeFileSync(join(root, `d${String(d)}`, `f${String(f)}.txt`), 'x'.repeat(f))
          writeFileSync(join(root, `d${String(d)}`, 'nested', `n${String(f)}.txt`), 'y')
        }
      }
      // Each directory lists its files in directory order, then descends into its subdirectories in that order.
      const expected: [string, string, number][] = []
      const walk = (dir: string): void => {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const e of entries) if (e.isFile()) expected.push([join(dir, e.name), relative(root, join(dir, e.name)), readFileSync(join(dir, e.name)).length])
        for (const e of entries) if (e.isDirectory()) walk(join(dir, e.name))
      }
      walk(root)
      expect(expected).toHaveLength(5000)
      const { value, turns } = await loopTurnsDuring(() => collectFolder(root, root, 1024 * 1024 * 1024, 50_000))
      expect(turns).toBeGreaterThan(10)
      expect(value).toEqual({ files: expected, total: expected.reduce((sum, [, , size]) => sum + size, 0), limit: null })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
