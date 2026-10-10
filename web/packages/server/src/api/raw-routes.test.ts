import { spawnSync } from 'node:child_process'
import { readZip } from '../workspace/unzip.js'
import { folderZipMaxBytes, folderZipMaxFiles } from './raw-routes.js'
import { homedir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { appendFileSync, closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { workspaceHash } from '../workspace/rollback.js'

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

  it('serves raw workspace files with ETag, ranges, and download/inline dispositions', async () => {
    let res = await s.get(`/api/file/raw?session_id=${sid}&path=photo.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toContain('inline; filename="photo.png"')
    expect(res.headers.get('cache-control')).toBe('no-store')
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

  it('a file past the ETag snapshot cap streams its bytes and ranges without buffering the whole file', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7)
    writeFileSync(join(ws, 'big.bin'), big)
    let res = await s.get(`/api/file/raw?session_id=${sid}&path=big.bin`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(big.length))
    expect(res.headers.get('etag')).toBeNull()
    expect(Buffer.from(await res.arrayBuffer()).equals(big)).toBe(true)
    res = await s.get(`/api/file/raw?session_id=${sid}&path=big.bin`, { headers: { range: 'bytes=1048576-1048579' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 1048576-1048579/${String(big.length)}`)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([7, 7, 7, 7]))
    res = await s.get(`/api/file/raw?session_id=${sid}&path=big.bin`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(String(big.length))
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
    const capped = await bootTestServer({ env: { HERMES_WEBUI_FOLDER_ZIP_MAX_FILES: '1' } })
    try {
      const cws = realpathSync(join(capped.state, 'workspace'))
      mkdirSync(join(cws, 'd'))
      writeFileSync(join(cws, 'd', '1'), '1')
      writeFileSync(join(cws, 'd', '2'), '2')
      const csid = await newSession(capped, cws)
      res = await capped.get(`/api/folder/download?session_id=${csid}&path=d`)
      expect(res.status).toBe(413)
      expect(await json(res)).toEqual({ error: 'too many files', limit: 1, configure: 'HERMES_WEBUI_FOLDER_ZIP_MAX_FILES' })
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
      expect(entry?.read().toString()).toBe('first\n')
    } finally {
      spy.mockRestore()
    }
  })

  it('honours the configured folder download limits as given, like Python', () => {
    expect(folderZipMaxBytes({ HERMES_WEBUI_FOLDER_ZIP_MAX_MB: '999999' })).toBe(999999 * 1024 * 1024)
    expect(folderZipMaxBytes({ HERMES_WEBUI_FOLDER_ZIP_MAX_MB: '512' })).toBe(512 * 1024 * 1024)
    expect(folderZipMaxFiles({ HERMES_WEBUI_FOLDER_ZIP_MAX_FILES: '1000000' })).toBe(1000000)
    expect(folderZipMaxFiles({})).toBe(50000)
  })

  it('exports the transcript as JSON and self-contained HTML', async () => {
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: 'Hello **world**' }, { role: 'assistant', content: 'Look ![x](https://evil.example/leak.png)\n\n```py\nprint(1)\n```' }]
    s.deps.sessionStore.save(session)
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
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'system', content: 'secret system prompt' }, { role: 'user', content: [{ type: 'text', text: 'Hello **world**' }] }, { role: 'tool', content: 'tool output' }, { role: 'assistant', content: 'silent background reply', _background_silent: true }, { role: 'assistant', content: '<think>private plan</think>Done.' }]
    s.deps.sessionStore.save(session)
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
    const session = s.deps.sessionStore.get(sid)
    session.messages = [{ role: 'user', content: `MEDIA:${join(outside, 'shot.png')}` }]
    s.deps.sessionStore.save(session)
    expect((await s.get(`/api/media?session_id=${sid}&path=${encodeURIComponent(join(outside, 'shot.png'))}`)).status).toBe(403)
    session.messages = [{ role: 'assistant', content: `Here: MEDIA:${join(outside, 'shot.png')}` }]
    s.deps.sessionStore.save(session)
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

  it('lists, diffs, and restores agent checkpoints for a configured workspace', async () => {
    // The default workspace is seeded into the list as 'Home', so it is already a known checkpoint target.
    expect(((await json(await s.get('/api/workspaces'))).workspaces as Json[]).map((w) => w.path)).toContain(ws)
    const ckpt = join(s.state, 'checkpoints', workspaceHash(ws), 'abc123')
    mkdirSync(ckpt, { recursive: true })
    mkdirSync(join(ckpt, 'docs'), { recursive: true })
    writeFileSync(join(ckpt, 'docs', 'a.txt'), 'alpha\ngamma\n')
    writeFileSync(join(ckpt, 'removed.txt'), 'gone\n')
    symlinkSync('/etc/hosts', join(ckpt, 'link'))
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null' }
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'checkpoint before edit']]) expect(spawnSync('git', args, { cwd: ckpt, env }).status).toBe(0)
    let res = await s.get(`/api/rollback/list?workspace=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(200)
    const list = await json(res)
    expect((list.checkpoints as Json[]).map((c) => c.id)).toEqual(['abc123'])
    expect((list.checkpoints as Json[])[0]).toMatchObject({ message: 'checkpoint before edit', files: 3 })
    res = await s.get(`/api/rollback/diff?workspace=${encodeURIComponent(ws)}&id=abc123`)
    expect(res.status).toBe(200)
    const diff = await json(res)
    expect(diff.files_changed).toEqual([{ file: 'docs/a.txt', status: 'modified' }, { file: 'removed.txt', status: 'deleted' }])
    // TAL-571: one line per diff line; each line's own ending is dropped before the '\n' join, so no blank line follows it.
    expect(diff.diff).toContain('--- a/docs/a.txt\n+++ b/docs/a.txt\n@@ -1,2 +1 @@\n alpha\n-gamma\n--- a/removed.txt')
    expect(diff.diff).toContain('--- a/removed.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone')
    expect(diff.diff).not.toContain('link')
    res = await post(s, '/api/rollback/restore', { workspace: ws, id: 'abc123' })
    expect(res.status).toBe(200)
    const restored = await json(res)
    expect((restored.files_restored as string[]).sort()).toEqual(['docs/a.txt', 'removed.txt'])
    expect(readFileSync(join(ws, 'docs', 'a.txt'), 'utf8')).toBe('alpha\ngamma\n')
    expect(readFileSync(join(ws, 'removed.txt'), 'utf8')).toBe('gone\n')
    expect(readdirSync(ws)).not.toContain('link')
    expect((await s.get(`/api/rollback/diff?workspace=${encodeURIComponent(ws)}&checkpoint=../abc123`)).status).toBe(400)
    expect((await s.get(`/api/rollback/list?workspace=${encodeURIComponent(s.state)}`)).status).toBe(400)
    expect((await s.get('/api/rollback/list')).status).toBe(400)
  })

  it('serves checkpoints for a session whose workspace is not a configured one (TAL-571)', async () => {
    // A worktree-backed chat works in a generated directory that is not in the configured workspace list.
    const wt = join(s.state, 'tal571-worktree')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, 'notes.txt'), 'edited\n')
    const wsid = await newSession(s, ws)
    const session = s.deps.sessionStore.get(wsid)
    session.workspace = wt
    s.deps.sessionStore.save(session)
    const ckpt = join(s.state, 'checkpoints', workspaceHash(wt), 'wt1')
    mkdirSync(ckpt, { recursive: true })
    writeFileSync(join(ckpt, 'notes.txt'), 'saved\n')
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null' }
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'worktree checkpoint']]) expect(spawnSync('git', args, { cwd: ckpt, env }).status).toBe(0)
    // By path alone the worktree is still refused; the session vouches for its own workspace and nothing else.
    expect((await s.get(`/api/rollback/list?workspace=${encodeURIComponent(wt)}`)).status).toBe(400)
    let res = await s.get(`/api/rollback/list?session_id=${wsid}`)
    expect(res.status).toBe(200)
    expect(((await json(res)).checkpoints as Json[]).map((c) => c.id)).toEqual(['wt1'])
    res = await s.get(`/api/rollback/diff?session_id=${wsid}&checkpoint=wt1`)
    expect((await json(res)).files_changed).toEqual([{ file: 'notes.txt', status: 'modified' }])
    res = await post(s, '/api/rollback/restore', { session_id: wsid, checkpoint: 'wt1' })
    expect(res.status).toBe(200)
    expect(readFileSync(join(wt, 'notes.txt'), 'utf8')).toBe('saved\n')
    expect((await s.get('/api/rollback/list?session_id=missing-session')).status).toBe(404)
  })

  it('reports worktree status for a worktree-backed session', async () => {
    const res = await s.get(`/api/session/worktree/status?session_id=${sid}`)
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe('Session is not worktree-backed')
    const session = s.deps.sessionStore.get(sid)
    session.worktree_path = join(s.state, 'missing-worktree')
    s.deps.sessionStore.save(session)
    const status = (await json(await s.get(`/api/session/worktree/status?session_id=${sid}`))).status as Json
    expect(status).toMatchObject({ exists: false, dirty: false, listed: false, locked_by_stream: false })
    const remove = await post(s, '/api/session/worktree/remove', { session_id: sid })
    expect(remove.status).toBe(200)
    expect((await json(remove)).warnings).toEqual(['Worktree directory no longer exists on disk.'])
  })
})
