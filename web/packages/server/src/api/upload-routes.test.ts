/**
 * Archive extraction, workspace upload, and copy-path routes (TAL-261): the pre-rewrite status codes and shapes, and
 * every slip, bomb, member-count, symlinked-subpath, and cross-profile case refused before anything lands outside the
 * destination, for each supported archive format.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { ZipWriter } from '../workspace/zip.js'

type Json = Record<string, unknown>
const MB = 1024 * 1024

async function zipOf(members: Record<string, Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = []
  const zip = new ZipWriter(new Writable({ write(chunk: Buffer, _enc, cb) { chunks.push(chunk); cb() } }))
  for (const [name, data] of Object.entries(members)) {
    const bytes = Buffer.from(data)
    await zip.addFile(name, Readable.from([bytes]), bytes.length)
  }
  await zip.finish()
  return Buffer.concat(chunks)
}

interface TarMember { name: string; data?: Buffer | string; type?: string; link?: string }

function tarHeader(name: string, size: number, type: string, link = ''): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  h.write('00000000000\0', 136)
  h.write('        ', 148)
  h.write(type, 156)
  h.write(link, 157, 100)
  h.write('ustar\0', 257)
  h.write('00', 263)
  let sum = 0
  for (const byte of h) sum += byte
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return h
}

function tarOf(members: TarMember[]): Buffer {
  const parts: Buffer[] = []
  for (const m of members) {
    const data = Buffer.from(m.data ?? '')
    parts.push(tarHeader(m.name, data.length, m.type ?? '0', m.link ?? ''), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

function cli(cmd: string, input: Buffer): Buffer {
  const out = spawnSync(cmd, ['-c'], { input, maxBuffer: 256 * MB })
  if (out.status !== 0) throw new Error(`${cmd} failed: ${out.stderr.toString()}`)
  return out.stdout
}

const COMPRESSORS: Record<string, (tar: Buffer) => Buffer> = {
  '.tar': (tar) => tar,
  '.tar.gz': (tar) => gzipSync(tar),
  '.tgz': (tar) => gzipSync(tar),
  '.tar.bz2': (tar) => cli('bzip2', tar),
  '.tbz2': (tar) => cli('bzip2', tar),
  '.tar.xz': (tar) => cli('xz', tar),
  '.txz': (tar) => cli('xz', tar),
}

function multipart(fields: Record<string, string>, files: [string, string, Buffer][]): { body: Buffer; headers: Record<string, string> } {
  const boundary = `b${Math.random().toString(16).slice(2)}`
  const parts: Buffer[] = []
  for (const [name, value] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  for (const [name, filename, data] of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), data, Buffer.from('\r\n'))
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

describe('archive extraction, workspace upload, and copy path', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let ws: string
  let sid: string
  let outside: string
  const configs = new Map<string, Json>()

  const post = (path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  const send = async (path: string, fields: Record<string, string>, files: [string, string, Buffer][]): Promise<{ status: number; body: Json }> => {
    const { body, headers } = multipart(fields, files)
    const res = await s.get(path, { method: 'POST', body, headers })
    return { status: res.status, body: (await res.json()) as Json }
  }
  const wsUpload = (name: string, data: Buffer, path = '', session = sid): Promise<{ status: number; body: Json }> => send('/api/workspace/upload', { session_id: session, path }, [['file', name, data]])
  const extract = (name: string, data: Buffer, session = sid): Promise<{ status: number; body: Json }> => send('/api/upload/extract', { session_id: session }, [['file', name, data]])
  const inbox = (session = sid): string => join(realpathSync(s.state), 'attachments', session)
  const newSession = async (): Promise<string> => {
    const res = await post('/api/session/new', { workspace: ws })
    expect(res.status).toBe(200)
    return String(((await res.json()) as { session: Json }).session.session_id)
  }

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    sidecar.respond('config.get', (params) => {
      const cfg = configs.get(params.profile_home)
      if (!cfg) throw new Error('config unavailable')
      return { path: join(params.profile_home, 'config.yaml'), exists: true, config: cfg }
    })
    // A 1 MB extraction cap keeps every bomb small enough to build in-test.
    s = await bootTestServer({ sidecar, env: { HERMES_WEBUI_MAX_EXTRACTED_MB: '1' } })
    ws = realpathSync(join(s.state, 'workspace'))
    sid = await newSession()
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-upload-outside-')))
  })
  afterAll(async () => {
    await s.close()
    rmSync(outside, { recursive: true, force: true })
  })

  describe('POST /api/file/path', () => {
    it('answers the absolute path of a workspace-relative path, whether or not the file exists', async () => {
      let res = await post('/api/file/path', { session_id: sid, path: '.' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, path: ws })
      res = await post('/api/file/path', { session_id: sid, path: 'docs/definitely-missing-xyz123.tmp' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, path: join(ws, 'docs', 'definitely-missing-xyz123.tmp') })
    })

    it('rejects traversal with 400, a missing session_id with 400, and an unknown session with 404', async () => {
      let res = await post('/api/file/path', { session_id: sid, path: '../../../../../../etc/passwd' })
      expect(res.status).toBe(400)
      expect(String(((await res.json()) as Json).error)).not.toContain('/etc/passwd')
      res = await post('/api/file/path', { path: 'foo.txt' })
      expect(res.status).toBe(400)
      expect(JSON.stringify(await res.json())).toContain('session_id')
      res = await post('/api/file/path', { session_id: 'fake-session-xyz', path: '.' })
      expect(res.status).toBe(404)
      expect(String(((await res.json()) as Json).error).toLowerCase()).toContain('session')
    })
  })

  describe('POST /api/upload/extract', () => {
    it('extracts into <session inbox>/<stem>, reports paths relative to the inbox, and rolls back by receipt', async () => {
      const { status, body } = await extract('demo.zip', await zipOf({ 'hello.txt': 'Hello, world!', 'sub/nested.txt': 'Nested file' }))
      expect(status, JSON.stringify(body)).toBe(200)
      expect(body).toMatchObject({ ok: true, extracted: 2, files: ['demo/hello.txt', 'demo/sub/nested.txt'], dest: join(inbox(), 'demo') })
      expect(readFileSync(join(inbox(), 'demo', 'hello.txt'), 'utf8')).toBe('Hello, world!')
      expect(readFileSync(join(inbox(), 'demo', 'sub', 'nested.txt'), 'utf8')).toBe('Nested file')
      // A second archive with the same stem never merges into the first.
      const again = await extract('demo.zip', await zipOf({ 'hello.txt': 'again' }))
      expect(again.status).toBe(200)
      expect(basename(String(again.body.dest))).toMatch(/^demo_\d{3}$/)
      expect(readFileSync(join(inbox(), 'demo', 'hello.txt'), 'utf8')).toBe('Hello, world!')
      const res = await post('/api/upload/rollback', { session_id: sid, rollback_tokens: [body.rollback_token] })
      expect(await res.json()).toEqual({ ok: true, rolled_back: 1, failed: 0 })
      expect(existsSync(join(inbox(), 'demo'))).toBe(false)
    })

    it('answers 400 for no file, no filename, an unsupported format, a slip, and a bomb, and 500 for an unreadable archive', async () => {
      expect(await send('/api/upload/extract', { session_id: sid }, [])).toEqual({ status: 400, body: { error: 'No file field in request' } })
      expect(await send('/api/upload/extract', { session_id: sid }, [['file', '', Buffer.from('x')]])).toEqual({ status: 400, body: { error: 'No filename in upload' } })
      expect(await extract('notes.rar', Buffer.from('rar'))).toEqual({ status: 400, body: { error: 'Unsupported archive format: notes.rar' } })
      const slip = await extract('evil.zip', await zipOf({ 'ok.txt': 'fine', '../escape.txt': 'escaped' }))
      expect(slip).toEqual({ status: 400, body: { error: 'Zip-slip blocked: ../escape.txt' } })
      expect(existsSync(join(inbox(), 'escape.txt'))).toBe(false)
      expect(existsSync(join(inbox(), 'evil'))).toBe(false)
      const bomb = await extract('bomb.tar.xz', cli('xz', tarOf([{ name: 'zeros.bin', data: Buffer.alloc(32 * MB) }])))
      expect(bomb.status).toBe(400)
      expect(String(bomb.body.error)).toContain('Extraction too large')
      expect(existsSync(join(inbox(), 'bomb.tar'))).toBe(false)
      expect(await extract('corrupt.zip', Buffer.from('this is not a zip file at all'))).toEqual({ status: 500, body: { error: 'Archive extraction failed' } })
    })

    it('answers 404 for an unknown session and for another profile\'s session before anything is written', async () => {
      expect((await extract('a.zip', await zipOf({ 'a.txt': 'a' }), 'deadbeef0000')).status).toBe(404)
      const foreign = await newSession()
      const stored = s.deps.sessionStore.get(foreign)
      stored.profile = 'other'
      s.deps.sessionStore.save(stored)
      const res = await extract('archive.zip', await zipOf({ 'a.txt': 'a' }), foreign)
      expect(res).toEqual({ status: 404, body: { error: 'Session not found' } })
      expect(existsSync(inbox(foreign))).toBe(false)
    })

    it('answers 413 when the body exceeds the upload cap', async () => {
      const res = await extract('big.zip', Buffer.alloc(s.deps.config.maxUploadBytes + 1024))
      expect(res.status).toBe(413)
    })
  })

  describe('POST /api/workspace/upload', () => {
    it('stores one file at the root or in a created subdirectory and answers its metadata', async () => {
      let { status, body } = await wsUpload('hello.txt', Buffer.from('hello workspace'))
      expect(status, JSON.stringify(body)).toBe(200)
      expect(body).toEqual({ filename: 'hello.txt', path: join(ws, 'hello.txt'), size: 15, mime: 'text/plain', is_image: false, extracted: false })
      expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toBe('hello workspace')
      ;({ status, body } = await wsUpload('nested.txt', Buffer.from('nested file'), 'sub/dir'))
      expect(status).toBe(200)
      expect(readFileSync(join(ws, 'sub', 'dir', 'nested.txt'), 'utf8')).toBe('nested file')
      ;({ status, body } = await wsUpload('icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])))
      expect(body).toMatchObject({ is_image: true, mime: 'image/png' })
    })

    it('deduplicates a repeated name with -1, -2 and answers {files, count} for several files', async () => {
      for (const [i, expected] of ['file.txt', 'file-1.txt', 'file-2.txt'].entries()) {
        const { status, body } = await wsUpload('file.txt', Buffer.from(`content ${String(i)}`), 'dedup')
        expect(status).toBe(200)
        expect(body.filename).toBe(expected)
        expect(readFileSync(join(ws, 'dedup', expected), 'utf8')).toBe(`content ${String(i)}`)
      }
      const many = await send('/api/workspace/upload', { session_id: sid, path: 'multi' }, [['a', 'a.txt', Buffer.from('a')], ['b', 'b.txt', Buffer.from('b')]])
      expect(many.status).toBe(200)
      expect(many.body.count).toBe(2)
      expect((many.body.files as Json[]).map((f) => f.filename)).toEqual(['a.txt', 'b.txt'])
      // Repeated `file` parts are each stored, in order.
      const repeated = await send('/api/workspace/upload', { session_id: sid, path: 'repeated' }, [['file', 'one.txt', Buffer.from('1')], ['file', 'two.txt', Buffer.from('2')]])
      expect(repeated.body.count).toBe(2)
      expect(readFileSync(join(ws, 'repeated', 'one.txt'), 'utf8')).toBe('1')
      expect(readFileSync(join(ws, 'repeated', 'two.txt'), 'utf8')).toBe('2')
    })

    it('refuses a zip member whose bytes do not match its CRC-32', async () => {
      const zip = await zipOf({ 'ok.txt': 'intact payload' })
      const central = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
      zip.writeUInt32LE((zip.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16)
      const { body } = await wsUpload('crc.zip', zip, 'crc')
      expect(body).toMatchObject({ extracted: false, extract_error: 'Bad CRC-32 for file ok.txt' })
      expect(readdirSync(join(ws, 'crc'))).toEqual([])
    })

    it('sanitizes a ../ filename into the target and rejects a traversing path with 400', async () => {
      const { status, body } = await wsUpload('../outside.txt', Buffer.from('escape attempt'))
      expect(status).toBe(200)
      expect(String(body.filename)).not.toContain('..')
      expect(existsSync(join(ws, String(body.filename)))).toBe(true)
      for (const path of ['../../etc', 'projects/../../etc/passwd']) {
        const res = await wsUpload('safe.txt', Buffer.from('safe'), path)
        expect(res.status).toBe(400)
        expect(res.body.error).toBeTruthy()
      }
    })

    it('refuses a subpath that is a symlink out of the workspace, writing nothing outside', async () => {
      symlinkSync(outside, join(ws, 'outlink'))
      try {
        for (const path of ['outlink', 'outlink/deeper']) {
          const res = await wsUpload('pwned.txt', Buffer.from('should not land outside'), path)
          expect([400, 403]).toContain(res.status)
        }
        const archive = await wsUpload('pwn.zip', await zipOf({ 'x.txt': 'x' }), 'outlink')
        expect([400, 403]).toContain(archive.status)
        expect(readdirSync(outside)).toEqual([])
      } finally {
        rmSync(join(ws, 'outlink'))
      }
    })

    it('answers 400 for a missing session_id or no files, 404 for unknown and foreign sessions, and 413 over the cap', async () => {
      expect(await send('/api/workspace/upload', { path: '' }, [['file', 'a.txt', Buffer.from('a')]])).toEqual({ status: 400, body: { error: 'Missing session_id' } })
      expect(await send('/api/workspace/upload', { session_id: sid }, [])).toEqual({ status: 400, body: { error: 'No file field in request' } })
      expect((await wsUpload('a.txt', Buffer.from('a'), '', 'deadbeef0000')).status).toBe(404)
      const foreign = await newSession()
      const stored = s.deps.sessionStore.get(foreign)
      stored.profile = 'other'
      s.deps.sessionStore.save(stored)
      expect(await wsUpload('foreign.txt', Buffer.from('x'), '', foreign)).toEqual({ status: 404, body: { error: 'Session not found' } })
      expect(existsSync(join(ws, 'foreign.txt'))).toBe(false)
      expect((await wsUpload('big.bin', Buffer.alloc(s.deps.config.maxUploadBytes + 1024))).status).toBe(413)
      expect(existsSync(join(ws, 'big.bin'))).toBe(false)
    })

    it('answers 409 while a Git operation holds the workspace', async () => {
      let release!: () => void
      const held = s.deps.git.holdWorkspace(ws, () => new Promise<void>((resolve) => { release = resolve }))
      try {
        const res = await wsUpload('busy.txt', Buffer.from('x'))
        expect(res.status).toBe(409)
        expect(existsSync(join(ws, 'busy.txt'))).toBe(false)
      } finally {
        release()
        await held
      }
    })

    it('fails closed with remote_workspace_unsupported for a remote profile and for an unreadable profile config', async () => {
      writeFileSync(join(s.state, 'config.yaml'), 'terminal: {}\n')
      try {
        // Unreadable: the sidecar cannot read config.yaml, so the backend is unknown.
        s.deps.agentConfig.invalidate()
        let res = await wsUpload('must-not-land.txt', Buffer.from('payload'))
        expect(res).toEqual({ status: 400, body: { error: expect.any(String) as unknown, code: 'remote_workspace_unsupported' } })
        configs.set(s.state, { terminal: { backend: 'ssh', cwd: ws } })
        s.deps.agentConfig.invalidate()
        await s.deps.agentConfig.read(s.state)
        res = await wsUpload('must-not-land.txt', Buffer.from('payload'))
        expect(res.status).toBe(400)
        expect(res.body.code).toBe('remote_workspace_unsupported')
        expect(existsSync(join(ws, 'must-not-land.txt'))).toBe(false)
      } finally {
        rmSync(join(s.state, 'config.yaml'))
        configs.clear()
        s.deps.agentConfig.invalidate()
      }
    })

    it('extracts a zip into <path>/<stem> and removes the archive', async () => {
      let { status, body } = await wsUpload('vendor.zip', await zipOf({ 'readme.md': '# Project', 'src/main.py': "print('hello')" }), 'projects')
      expect(status, JSON.stringify(body)).toBe(200)
      expect(body).toEqual({ filename: 'vendor.zip', path: join(ws, 'projects', 'vendor'), size: expect.any(Number) as unknown, is_image: false, extracted: true, extracted_files: ['vendor/readme.md', 'vendor/src/main.py'], extracted_count: 2 })
      expect(readFileSync(join(ws, 'projects', 'vendor', 'src', 'main.py'), 'utf8')).toBe("print('hello')")
      expect(existsSync(join(ws, 'projects', 'vendor.zip'))).toBe(false)
      ;({ status, body } = await wsUpload('notes.zip', await zipOf({ 'notes.txt': 'workspace notes' })))
      expect(body.extracted).toBe(true)
      expect(readFileSync(join(ws, 'notes', 'notes.txt'), 'utf8')).toBe('workspace notes')
    })

    it.each(Object.keys(COMPRESSORS))('extracts a %s archive and skips symlink, hard-link, and device members', async (suffix) => {
      const stem = `bundle-${suffix.replace(/\./g, '')}`
      const tar = tarOf([
        { name: 'docs/readme.txt', data: 'hello from tar' },
        { name: 'docs/', type: '5' },
        { name: 'link', type: '2', link: outside },
        { name: 'hard', type: '1', link: 'docs/readme.txt' },
        { name: 'dev', type: '3' },
        { name: 'link/inside.txt', data: 'real directory' },
      ])
      const { status, body } = await wsUpload(`${stem}${suffix}`, COMPRESSORS[suffix]!(tar), 'formats')
      expect(status, JSON.stringify(body)).toBe(200)
      expect(body.extracted, JSON.stringify(body)).toBe(true)
      const dest = String(body.path)
      expect(body.extracted_count).toBe(2)
      expect(readFileSync(join(dest, 'docs', 'readme.txt'), 'utf8')).toBe('hello from tar')
      // The symlink member was skipped, so `link/` is an ordinary directory inside the destination.
      expect(lstatSync(join(dest, 'link')).isDirectory()).toBe(true)
      expect(existsSync(join(dest, 'hard'))).toBe(false)
      expect(existsSync(join(dest, 'dev'))).toBe(false)
      expect(readdirSync(join(ws, 'formats')).filter((n) => n.endsWith(suffix))).toEqual([])
      expect(readdirSync(outside)).toEqual([])
    })

    it.each(['.zip', ...Object.keys(COMPRESSORS)])('a %s slip, bomb, member-count, or unreadable archive reports extract_error and leaves nothing behind', async (suffix) => {
      const dir = `refused-${suffix.replace(/\./g, '')}`
      const build = async (members: TarMember[]): Promise<Buffer> => suffix === '.zip' ? zipOf(Object.fromEntries(members.map((m) => [m.name, m.data ?? '']))) : COMPRESSORS[suffix]!(tarOf(members))
      const cases: [string, Buffer, RegExp][] = [
        ['slip', await build([{ name: 'ok.txt', data: 'fine' }, { name: '../escape.txt', data: 'escaped' }]), /-slip blocked: \.\.\/escape\.txt/],
        ['absolute', await build([{ name: `${outside}/abs.txt`, data: 'escaped' }]), /-slip blocked/],
        ['files', await build([{ name: 'a.bin', data: Buffer.alloc(700 * 1024) }, { name: 'b.bin', data: Buffer.alloc(700 * 1024) }]), /Extraction too large/],
        ['many', await build(Array.from({ length: 10_001 }, (_, i) => ({ name: `f${String(i)}.txt`, data: 'x' }))), /too many files \(> 10000\)/],
        ['corrupt', suffix === '.tar' ? Buffer.from('x'.repeat(1024)) : Buffer.from('this is not an archive at all'), /./],
      ]
      for (const [label, data, error] of cases) {
        const { status, body } = await wsUpload(`${label}${suffix}`, data, dir)
        expect(status, `${label}: ${JSON.stringify(body)}`).toBe(200)
        expect(body.extracted, label).toBe(false)
        expect(String(body.extract_error), label).toMatch(error)
        expect(readdirSync(join(ws, dir)), label).toEqual([])
      }
      expect(existsSync(join(ws, 'escape.txt'))).toBe(false)
      expect(readdirSync(outside)).toEqual([])
    })

    it('reads pax and GNU long names, and removes partial output when a write fails mid-archive', async () => {
      const long = `${'d'.repeat(120)}/file.txt`
      const record = (key: string, value: string): string => {
        const body = ` ${key}=${value}\n`
        let length = body.length
        while (`${String(length)}${body}`.length !== length) length = `${String(length)}${body}`.length
        return `${String(length)}${body}`
      }
      const pax = record('path', long)
      const named = Buffer.concat([tarHeader('PaxHeader', pax.length, 'x'), Buffer.from(pax), Buffer.alloc((512 - (pax.length % 512)) % 512), tarHeader('ignored', 3, '0'), Buffer.from('pax'), Buffer.alloc(509), tarOf([{ name: '././@LongLink', type: 'L', data: `${long}.gnu\0` }, { name: 'ignored-too', data: 'gnu' }])])
      const ok = await wsUpload('long.tar', named, 'long')
      expect(ok.body.extracted, JSON.stringify(ok.body)).toBe(true)
      expect(readFileSync(join(ws, 'long', 'long', long), 'utf8')).toBe('pax')
      expect(readFileSync(join(ws, 'long', 'long', `${long}.gnu`), 'utf8')).toBe('gnu')
      // The second `a.txt` fails its exclusive create after the first was written; the directory goes with it.
      const dup = await wsUpload('dup.tar', tarOf([{ name: 'a.txt', data: 'one' }, { name: 'a.txt', data: 'two' }]), 'dup')
      expect(dup.body).toMatchObject({ extracted: false, extract_error: 'Archive extraction failed' })
      expect(readdirSync(join(ws, 'dup'))).toEqual([])
      expect(await extract('dup.tar', tarOf([{ name: 'a.txt', data: 'one' }, { name: 'a.txt', data: 'two' }]))).toEqual({ status: 500, body: { error: 'Archive extraction failed' } })
      expect(existsSync(join(inbox(), 'dup'))).toBe(false)
    })

    it.each(['.tar.gz', '.tar.bz2', '.tar.xz'])('a %s stream that decompresses past the cap is aborted mid-stream, even when no file member reaches it', async (suffix) => {
      // A 32 MB extended header carries no file bytes: only the decompression bound can refuse it.
      const tar = Buffer.concat([tarHeader('pax_global_header', 32 * MB, 'g'), Buffer.alloc(32 * MB), tarOf([{ name: 'tiny.txt', data: 'x' }])])
      const { status, body } = await wsUpload(`stream${suffix}`, COMPRESSORS[suffix]!(tar), 'streams')
      expect(status).toBe(200)
      expect(body.extracted).toBe(false)
      expect(String(body.extract_error)).toContain('Extraction too large')
      expect(readdirSync(join(ws, 'streams'))).toEqual([])
    })
  })
})

describe('extracted-bytes cap', () => {
  const cap = (env: Record<string, string>): number => loadConfig({ env: { HERMES_HOME: '/tmp/talaria-cap-test', HERMES_WEBUI_DEFAULT_WORKSPACE: tmpdir(), ...env }, webRoot: '/tmp', warn: () => undefined }).maxExtractedBytes
  it('defaults to ten times the upload cap and tracks it', () => {
    expect(cap({})).toBe(200 * MB)
    expect(cap({ HERMES_WEBUI_MAX_UPLOAD_MB: '7' })).toBe(70 * MB)
  })
  it('honours a positive HERMES_WEBUI_MAX_EXTRACTED_MB, fractional included, and ignores anything else', () => {
    expect(cap({ HERMES_WEBUI_MAX_EXTRACTED_MB: '5' })).toBe(5 * MB)
    expect(cap({ HERMES_WEBUI_MAX_EXTRACTED_MB: '0.5' })).toBe(MB / 2)
    for (const bad of ['0', '-3', 'lots', 'Infinity']) expect(cap({ HERMES_WEBUI_MAX_EXTRACTED_MB: bad })).toBe(200 * MB)
  })
})
