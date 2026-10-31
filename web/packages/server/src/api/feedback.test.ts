import { createHash, generateKeyPairSync, randomBytes, verify } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { saveRelayConfig } from '../sessions/relay.js'
import { JsonDocuments } from '../test/storage.js'
import { stageFeedbackAttachment, submitFeedback as sendFeedback } from '../feedback.js'
import { FeedbackSubmitSchema } from '@maudecode/talaria-web-contracts'

type Payload = Record<string, unknown>
let s: TestServer
let relay: Server
let url: string
let status: number
let calls: { raw: string; headers: import('node:http').IncomingHttpHeaders; payload: Payload }[]
// Attachment protocol of the fake Relay: one report per requestId, rotating tokens, and recorded PUT bodies.
let admit: (index: number) => Payload
let putAnswer: (index: number, attempt: number) => 'store' | 'store-then-drop' | 'drop' | number
let puts: { index: number; authorization: string | undefined; body: Buffer }[]
let reports: Map<string, { reportId: string; stored: Set<number>; tokens: Map<number, string>; attempts: Map<number, number> }>
const input = () => ({ requestId: crypto.randomUUID(), kind: 'bug', title: 'Private title', body: 'Private body', includeDiagnostics: true, client: { platform: 'web' } })
const submit = (body: unknown = input()) => s.get('/api/feedback/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
beforeEach(async () => {
  status = 202
  calls = []
  puts = []
  reports = new Map()
  admit = () => ({ status: 'accepted' })
  putAnswer = () => 'store'
  relay = createServer((req, res) => {
    const upload = /^\/v1\/feedback\/([^/]+)\/attachments\/(\d)$/.exec(req.url ?? '')
    if (req.method === 'PUT' && upload) { handlePut(req, res, decodeURIComponent(upload[1]!), Number(upload[2])); return }
    // The server under test only sends POST /v1/feedback. Other local processes probe newly opened
    // loopback ports with a bodiless `GET /`; answer those 404 without recording them.
    if (req.method !== 'POST' || req.url !== '/v1/feedback') { req.resume(); res.writeHead(404).end(); return }
    let raw = ''
    req.setEncoding('utf8').on('data', (chunk: string) => { raw += chunk }).on('end', () => {
      let payload: Payload | undefined
      try { payload = JSON.parse(raw) as Payload } catch { /* recorded and refused, so call assertions catch it */ }
      calls.push({ raw, headers: req.headers, payload: payload ?? {} })
      if (!payload) { res.writeHead(400).end(); return }
      res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '42' })
      if (status !== 202) { res.end(JSON.stringify({ error: 'private Relay detail' })); return }
      const manifest = payload.attachments as unknown[] | undefined
      if (!manifest) { res.end(JSON.stringify({ reportId: 'report-1' })); return }
      const key = String(payload.requestId)
      const report = reports.get(key) ?? { reportId: `report-${String(reports.size + 1)}`, stored: new Set<number>(), tokens: new Map<number, string>(), attempts: new Map<number, number>() }
      reports.set(key, report)
      const attachments = manifest.map((_, index) => {
        if (report.stored.has(index)) return { index, status: 'stored' }
        const admission = admit(index)
        if (admission.status !== 'accepted') return { index, ...admission }
        const uploadToken = `token-${String(calls.length)}-${String(index)}`
        report.tokens.set(index, uploadToken)
        return { index, status: 'accepted', uploadToken, expiresAt: Date.now() + 1_800_000 }
      })
      res.end(JSON.stringify({ reportId: report.reportId, attachments }))
    })
  })
  const handlePut = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, reportId: string, index: number) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk)).on('end', () => {
      const report = [...reports.values()].find((row) => row.reportId === reportId)
      if (!report || req.headers.authorization !== `Bearer ${String(report.tokens.get(index))}`) { res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' })); return }
      const attempt = report.attempts.get(index) ?? 0
      report.attempts.set(index, attempt + 1)
      const answer = putAnswer(index, attempt)
      if (answer === 'drop') { req.socket.destroy(); return }
      if (typeof answer === 'number') { res.writeHead(answer, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { 400: 'invalid_attachment', 410: 'upload_expired', 503: 'attachments_disabled' }[answer] ?? 'private' })); return }
      puts.push({ index, authorization: req.headers.authorization, body: Buffer.concat(chunks) })
      report.stored.add(index)
      report.tokens.delete(index)
      if (answer === 'store-then-drop') { req.socket.destroy(); return }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ reportId, index, status: 'stored' }))
    })
  }
  await new Promise<void>((resolve) => { relay.listen(0, '127.0.0.1', resolve) })
  url = `http://127.0.0.1:${(relay.address() as import('node:net').AddressInfo).port}`
  s = await bootTestServer({ env: { HOME: '/synthetic-home', HERMES_WEBUI_TALARIA_RELAY_URL: url } })
  vi.spyOn(s.deps.catalog, 'providers').mockResolvedValue({ providers: [{ id: 'openai', has_key: true, api_key: 'provider-secret', base_url: 'https://private.example', account_id: 'private-account' }, { id: 'disabled', has_key: false }], active_provider: 'openai', availability: { status: 'available', authoritative: true } } as never)
})
afterEach(async () => { vi.restoreAllMocks(); await s.close(); await new Promise<void>((resolve, reject) => { relay.close((e) => { if (e) reject(e); else resolve() }) }) })

it('previews exactly the bounded, redacted diagnostics attached to unsigned feedback', async () => {
  for (let i = 0; i < 12; i++) s.deps.log(`[webui] ERROR error-${i} API_KEY=sk-syntheticsecret${i} Authorization: Bearer bearer-secret-${i} /synthetic-home/private/file`)
  s.deps.log('[webui] ordinary info must not be included')
  const preview = await s.get('/api/feedback/diagnostics')
  expect(preview.status).toBe(200)
  const diagnostics = await preview.json() as { text: string; bytes: number }
  expect(diagnostics.bytes).toBe(Buffer.byteLength(diagnostics.text))
  expect(diagnostics.bytes).toBeLessThanOrEqual(16384)
  expect(diagnostics.text).toContain('error-11')
  expect(diagnostics.text).not.toMatch(/error-0\b|error-1\b|sk-synthetic|bearer-secret|synthetic-home|private\/file|provider-secret|private-account|private.example|ordinary info|disabled/)
  const request = input()
  expect(await (await submit(request)).json()).toEqual({ status: 'sent', reportId: 'report-1', attachments: [] })
  expect(calls[0]!.payload).toMatchObject({ requestId: request.requestId, diagnostics: diagnostics.text, server: { webVersion: s.deps.version }, installId: expect.any(String) as string })
  expect(calls[0]!.headers['x-talaria-signature']).toBeUndefined()
  expect(s.logs.filter((line) => line.startsWith('[feedback]'))).toEqual([`[feedback] ${request.requestId} sent`])
})

it('omits diagnostics on opt-out and validates closed inputs before forwarding', async () => {
  expect((await submit({ ...input(), includeDiagnostics: false })).status).toBe(200)
  expect(calls[0]!.payload).not.toHaveProperty('diagnostics')
  for (const change of [{ requestId: 'bad' }, { title: '' }, { title: '   ' }, { client: { platform: 'web', appVersion: '' } }, { title: 'x'.repeat(121) }, { body: 'x'.repeat(8001) }, { kind: 'secret' }, { client: { platform: 'android' } }, { client: { platform: 'web', account: 'private' } }, { unexpected: true }]) {
    const response = await submit({ ...input(), ...change })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid' })
  }
  expect(calls).toHaveLength(1)
})

it('signs with the persisted publisher key and fresh nonces for retries', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  await s.deps.sessionStore.deps.storage.documents.put('relay-keys', '0123456789abcdef', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), null)
  await saveRelayConfig(s.deps.sessionStore.deps.storage.documents, { url, publisher_id: 'https://publisher.example', key_id: 'key-1', private_key_path: '', private_key_document: '0123456789abcdef', profiles: { default: { identity: 'pfi_test', profile_id: 'profile-1' } } })
  status = 503
  expect((await submit()).status).toBe(502)
  expect(calls).toHaveLength(2)
  for (const call of calls) {
    const signed = ['POST', '/v1/feedback', call.headers['x-talaria-timestamp'], call.headers['x-talaria-nonce'], createHash('sha256').update(call.raw).digest('base64url')].join('\n')
    expect(verify(null, Buffer.from(signed), publicKey, Buffer.from(String(call.headers['x-talaria-signature']), 'base64url'))).toBe(true)
  }
  expect(calls[0]!.raw).toBe(calls[1]!.raw)
  expect(calls[0]!.headers['x-talaria-nonce']).not.toBe(calls[1]!.headers['x-talaria-nonce'])
})

it.each([[429, 429, 'rate_limited'], [404, 503, 'feedback_unavailable'], [400, 400, 'invalid'], [503, 502, 'relay_unreachable']])('maps Relay %s without disclosing its response', async (relayStatus, httpStatus, code) => {
  status = relayStatus
  const response = await submit()
  expect(response.status).toBe(httpStatus)
  expect(await response.json()).toMatchObject({ error: code, ...(code === 'rate_limited' ? { retryAfterSeconds: 42 } : {}) })
  expect(calls).toHaveLength(relayStatus === 503 ? 2 : 1)
})

it('retries connection refusal exactly once with the same requestId', async () => {
  const request = input()
  const fake = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'))
  s.deps.fetch = fake
  expect(await (await submit(request)).json()).toMatchObject({ error: 'relay_unreachable' })
  expect(fake).toHaveBeenCalledTimes(2)
  for (const [, init] of fake.mock.calls) expect(JSON.parse(typeof init?.body === 'string' ? init.body : '{}')).toMatchObject({ requestId: request.requestId })
})

it('keeps install identity across backend restarts and separates fresh homes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'feedback-state-'))
  const original = s.deps.sessionStore.deps.storage.documents
  try {
    const ids: unknown[] = []
    for (const home of ['one', 'one', 'two']) {
      Object.defineProperty(s.deps.sessionStore.deps.storage, 'documents', { value: new JsonDocuments(join(root, home)), configurable: true })
      expect((await submit({ ...input(), includeDiagnostics: false })).status).toBe(200)
      ids.push(calls.at(-1)!.payload.installId)
    }
    expect(ids[0]).toBe(ids[1])
    expect(ids[0]).not.toBe(ids[2])
  } finally { Object.defineProperty(s.deps.sessionStore.deps.storage, 'documents', { value: original }); rmSync(root, { recursive: true, force: true }) }
})

it('keeps retry payloads stable across changed logs and versions', async () => {
  const request = input()
  status = 503
  expect((await submit(request)).status).toBe(502)
  const first = calls[0]!.raw
  s.deps.log('[webui] ERROR newer error')
  s.deps.version = 'new-version'
  status = 202
  expect((await submit(request)).status).toBe(200)
  expect(calls.at(-1)!.raw).toBe(first)
  expect((await submit({ ...request, title: 'Changed' })).status).toBe(400)
  expect(calls).toHaveLength(3)
})

it('redacts content and caps every selected error before building diagnostics', async () => {
  s.deps.log('[webui] ERROR prompt: confidential conversation')
  s.deps.log('[webui] ERROR '.concat('界'.repeat(12000)))
  const preview = await (await s.get('/api/feedback/diagnostics')).json() as { text: string; bytes: number }
  expect(preview.text).not.toContain('confidential conversation')
  expect(preview.bytes).toBeLessThanOrEqual(16384)
  expect(preview.text.split('\n').every((line) => line.length <= 300)).toBe(true)
})

it('does not downgrade a registered publisher when its key is unavailable', async () => {
  await saveRelayConfig(s.deps.sessionStore.deps.storage.documents, { url, publisher_id: 'https://publisher.example', key_id: 'key-1', private_key_path: '', private_key_document: '0123456789abcdef', profiles: { default: { identity: 'pfi_test', profile_id: 'profile-1' } } })
  expect(await (await submit()).json()).toEqual({ error: 'feedback_unavailable' })
  expect(calls).toHaveLength(0)
})

it('enforces the total Relay byte limit and authenticates both routes', async () => {
  expect((await submit({ ...input(), body: '\\'.repeat(8000), client: { platform: 'web', deviceModel: '\\'.repeat(64) } })).status).toBe(200)
  expect((await submit({ ...input(), body: '界'.repeat(8000), client: { platform: 'web' } })).status).toBe(200)
  // JSON escaping makes otherwise field-valid input exceed the Relay's byte envelope.
  expect((await submit({ ...input(), body: '\u0000'.repeat(8000) })).status).toBe(400)
  const protectedServer = await bootTestServer({ env: { HOME: '/synthetic-home', HERMES_WEBUI_PASSWORD: 'synthetic-password-only' } })
  try {
    expect((await protectedServer.get('/api/feedback/diagnostics')).status).toBe(401)
    expect((await protectedServer.get('/api/feedback/submit', { method: 'POST', body: JSON.stringify(input()), headers: { 'Content-Type': 'application/json' } })).status).toBe(401)
  } finally { await protectedServer.close() }
})

it('removes arbitrary absolute and quoted filesystem paths from the whole feedback flow', async () => {
  s.deps.log('ERROR could not open /mnt/customer-merger/secret.wav or "/opt/customer project/private notes.txt" or C:\\Customer\\private.wav or "D:\\Customer Project\\private notes.txt"')
  const preview = await (await s.get('/api/feedback/diagnostics')).json() as { text: string }
  expect(preview.text).not.toMatch(/customer|private|secret\.wav|Customer/i)
  expect(preview.text).toContain('<path>')
  const request = input()
  expect((await submit(request)).status).toBe(200)
  expect(calls[0]!.payload.diagnostics).toBe(preview.text)
  const snapshot = await s.deps.sessionStore.deps.storage.documents.get('feedback', 'state')
  expect(JSON.stringify(snapshot?.value)).not.toMatch(/customer|private|secret\.wav/i)
})

it.each(['"', "'"])('redacts a complete long %s-quoted environment assignment before caching', async (quote) => {
  s.deps.log(`ERROR DATA=${quote}firstword private second word ${'synthetic '.repeat(1600)}${quote} end`)
  const preview = await (await s.get('/api/feedback/diagnostics')).json() as { text: string }
  expect(preview.text).not.toMatch(/firstword|private second word|synthetic/)
  expect(s.deps.recentErrors().join('\n')).not.toMatch(/firstword|private second word|synthetic/)
  expect((await submit()).status).toBe(200)
  expect(calls[0]!.payload.diagnostics).toBe(preview.text)
})

it('fails closed for lowercase environment assignments with adjacent quoted pieces', async () => {
  s.deps.log("ERROR data='firstword''private second word' tail")
  const preview = await (await s.get('/api/feedback/diagnostics')).json() as { text: string }
  expect(preview.text).not.toMatch(/firstword|private second word/)
})

it('rejects oversized feedback before creating any durable feedback state', async () => {
  for (let i = 0; i < 3; i++) expect((await submit({ ...input(), body: '\u0000'.repeat(8000) })).status).toBe(400)
  expect(await s.deps.sessionStore.deps.storage.documents.list('feedback')).toEqual([])
  expect(calls).toHaveLength(0)
})

it('limits each principal to twenty fresh request IDs per hour without blocking retries', async () => {
  const request = { ...input(), includeDiagnostics: false }
  for (let i = 0; i < 20; i++) expect((await submit({ ...request, requestId: i === 0 ? request.requestId : crypto.randomUUID() })).status).toBe(200)
  const limited = await submit({ ...request, requestId: crypto.randomUUID() })
  expect(limited.status).toBe(429)
  expect(await limited.json()).toMatchObject({ error: 'rate_limited', retryAfterSeconds: expect.any(Number) as number })
  expect((await submit(request)).status).toBe(200)
  expect(calls).toHaveLength(20)
  const other = await s.deps.requestScope.run({ requestProfile: 'default', notificationOwner: 'synthetic-other-member' }, () => sendFeedback(s.deps, s.state, FeedbackSubmitSchema.parse({ ...request, requestId: crypto.randomUUID() })))
  expect(other.status).toBe('sent')
  expect(calls).toHaveLength(21)
})

it('compacts definitive snapshots and expires receipts under a synthetic clock', async () => {
  const start = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
  const backend = s.deps.sessionStore.deps.storage.documents
  expect((await submit()).status).toBe(200)
  let state = (await backend.get('feedback', 'state'))?.value as { entries: Record<string, unknown>[] }
  expect(state.entries).toHaveLength(1)
  expect(state.entries[0]).not.toHaveProperty('snapshot')
  expect(state.entries[0]?.reportId).toBe('report-1')
  status = 429
  expect((await submit()).status).toBe(429)
  state = (await backend.get('feedback', 'state'))?.value as typeof state
  expect(state.entries).toHaveLength(2)
  expect(state.entries[1]).not.toHaveProperty('snapshot')
  clock.mockReturnValue(start + 3601 * 1000)
  status = 202
  expect((await submit()).status).toBe(200)
  state = (await backend.get('feedback', 'state'))?.value as typeof state
  expect(state.entries).toHaveLength(2)
  clock.mockReturnValue(start + (30 * 86400 + 3602) * 1000)
  expect((await submit()).status).toBe(200)
  state = (await backend.get('feedback', 'state'))?.value as typeof state
  expect(state.entries).toHaveLength(1)
})

it('bounds the whole durable ledger while allowing an existing receipt to be recovered', async () => {
  const request = { ...input(), includeDiagnostics: false }
  expect((await submit(request)).status).toBe(200)
  const backend = s.deps.sessionStore.deps.storage.documents
  const doc = (await backend.get('feedback', 'state'))!
  const state = doc.value as { entries: Record<string, unknown>[] }
  const original = state.entries[0]!
  state.entries = [original, ...Array.from({ length: 1023 }, (_, i) => ({ ...original, requestId: crypto.randomUUID(), owner: createHash('sha256').update(`synthetic-member-${i}`).digest('hex') }))]
  await backend.put('feedback', 'state', state, doc.revision)
  expect((await submit({ ...request, requestId: crypto.randomUUID() })).status).toBe(429)
  expect((await submit(request)).status).toBe(200)
  expect(calls).toHaveLength(1)
  expect(await backend.list('feedback')).toHaveLength(1)
})

it('serializes concurrent submissions of one request ID before compacting its snapshot', async () => {
  const request = input()
  const results = await Promise.all([submit(request), submit(request)])
  expect(results.map((response) => response.status)).toEqual([200, 200])
  expect(calls).toHaveLength(1)
})

it('ignores a bodiless loopback probe of the fake Relay port', async () => {
  // Local dev tools probe newly opened loopback ports with `GET /`; the server under test never sends one.
  const probe = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) })
  expect(probe.status).toBe(404)
  expect(calls).toHaveLength(0)
  expect((await submit()).status).toBe(200)
  expect(calls).toHaveLength(1)
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const png = (n = 64) => Buffer.concat([PNG, randomBytes(n)])
const jpeg = (n = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(n)])
const mp4 = (n = 64) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), randomBytes(n)])
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const stagingFiles = () => (existsSync(join(s.deps.config.stateDir, 'feedback-attachments')) ? readdirSync(join(s.deps.config.stateDir, 'feedback-attachments')) : [])
async function register(): Promise<void> {
  const { privateKey } = generateKeyPairSync('ed25519')
  await s.deps.sessionStore.deps.storage.documents.put('relay-keys', '0123456789abcdef', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), null)
  await saveRelayConfig(s.deps.sessionStore.deps.storage.documents, { url, publisher_id: 'https://publisher.example', key_id: 'key-1', private_key_path: '', private_key_document: '0123456789abcdef', profiles: { default: { identity: 'pfi_test', profile_id: 'profile-1' } } })
}
async function stage(contentType: string, data: Buffer, extra?: (form: FormData) => void): Promise<Response> {
  const form = new FormData()
  form.append('contentType', contentType)
  form.append('file', new Blob([data]), 'capture')
  extra?.(form)
  return s.get('/api/feedback/attachments', { method: 'POST', body: form })
}
async function staged(contentType: string, data: Buffer): Promise<string> {
  const response = await stage(contentType, data)
  expect(response.status).toBe(200)
  const body = await response.json() as { attachmentId: string; contentType: string; bytes: number }
  expect(body).toEqual({ attachmentId: expect.any(String) as string, contentType, bytes: data.length })
  return body.attachmentId
}
const other = <T>(run: () => Promise<T>) => s.deps.requestScope.run({ requestProfile: 'default', notificationOwner: 'synthetic-other-member' }, run)

it('publishes attachment options from this server\'s Relay tier', async () => {
  expect(await (await s.get('/api/feedback/options')).json()).toEqual({ attachments: { enabled: false, videoAllowed: false, maxCount: 5, maxImageBytes: 10_000_000, maxVideoBytes: 20_000_000, maxVideoSeconds: 120, acceptedTypes: [] } })
  expect((await stage('image/png', png())).status).toBe(403)
  expect(stagingFiles()).toEqual([])
  await register()
  expect(await (await s.get('/api/feedback/options')).json()).toEqual({ attachments: { enabled: true, videoAllowed: true, maxCount: 5, maxImageBytes: 10_000_000, maxVideoBytes: 20_000_000, maxVideoSeconds: 120, acceptedTypes: ['image/png', 'image/jpeg', 'image/heic', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'] } })
})

it('forwards staged files to Relay as the manifest and byte-identical uploads, then removes them', async () => {
  await register()
  const files = [png(), mp4(4096)]
  const ids = [await staged('image/png', files[0]!), await staged('video/mp4', files[1]!)]
  const request = { ...input(), attachmentIds: ids }
  const response = await submit(request)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: 'sent', reportId: 'report-1', attachments: ids.map((attachmentId) => ({ attachmentId, status: 'sent' })) })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.payload.attachments).toEqual([{ contentType: 'image/png', bytes: files[0]!.length, sha256: sha(files[0]!) }, { contentType: 'video/mp4', bytes: files[1]!.length, sha256: sha(files[1]!) }])
  expect(puts.map((put) => [put.index, put.authorization])).toEqual([[0, 'Bearer token-1-0'], [1, 'Bearer token-1-1']])
  expect(puts.map((put) => put.body.equals(files[put.index]!))).toEqual([true, true])
  expect(stagingFiles()).toEqual([])
  // A settled retry answers from its receipt without the released files.
  expect(await (await submit(request)).json()).toEqual({ status: 'sent', reportId: 'report-1', attachments: ids.map((attachmentId) => ({ attachmentId, status: 'sent' })) })
  expect(calls).toHaveLength(1)
})

it('reports each Relay refusal with its reason while the report is sent', async () => {
  await register()
  const ids = [await staged('image/png', png()), await staged('image/jpeg', jpeg()), await staged('image/png', png())]
  const reasons = ['tier', 'quota', 'disabled']
  admit = (index) => ({ status: 'refused', reason: reasons[index] })
  expect(await (await submit({ ...input(), attachmentIds: ids })).json()).toEqual({ status: 'sent', reportId: 'report-1', attachments: ids.map((attachmentId, index) => ({ attachmentId, status: 'refused', reason: reasons[index] })) })
  expect(puts).toEqual([])
  expect(stagingFiles()).toEqual([])
})

it('marks definitive upload refusals per file', async () => {
  await register()
  const ids = [await staged('image/png', png()), await staged('image/png', png()), await staged('image/png', png())]
  const answers = [400, 410, 503]
  putAnswer = (index) => answers[index]!
  expect(await (await submit({ ...input(), attachmentIds: ids })).json()).toMatchObject({ status: 'sent', attachments: ids.map((attachmentId, index) => ({ attachmentId, status: 'refused', reason: ['invalid', 'expired', 'disabled'][index] })) })
  expect(calls).toHaveLength(1)
})

it('rejects invalid files, references and staging floods before anything is forwarded', async () => {
  await register()
  const rejected = async (response: Promise<Response>, code: number) => { const answer = await response; expect(answer.status).toBe(code); return answer.json() }
  expect(await rejected(stage('image/png', jpeg()), 400)).toEqual({ error: 'invalid' })
  expect(await rejected(stage('image/png', Buffer.from('<html><script>alert(1)</script></html>')), 400)).toEqual({ error: 'invalid' })
  expect(await rejected(stage('video/quicktime', mp4()), 400)).toEqual({ error: 'invalid' })
  expect(await rejected(stage('image/svg+xml', png()), 400)).toEqual({ error: 'invalid' })
  expect(await rejected(stage('image/png', Buffer.concat([PNG, Buffer.alloc(10_000_000 - PNG.length + 1)])), 400)).toEqual({ error: 'invalid' })
  expect(await rejected(stage('image/png', png(), (form) => { form.append('file', new Blob([png()]), 'second') }), 400)).toEqual({ error: 'invalid' })
  // An undeclared (chunked) length stops at the cap with 400; a declared one is refused with 413 before reading.
  expect(await rejected(stage('video/mp4', Buffer.concat([mp4(), Buffer.alloc(20_000_000)])), 400)).toEqual({ error: 'invalid' })
  const oversized = await stage('video/mp4', Buffer.concat([mp4(), Buffer.alloc(20_100_000)]))
  expect([400, 413]).toContain(oversized.status)
  expect(await oversized.json()).toMatchObject({ error: expect.stringMatching(/too large/i) as string })
  expect(stagingFiles()).toEqual([])
  const mine = await staged('image/png', png())
  const theirs = await other(() => stageFeedbackAttachment(s.deps, 'image/png', png()))
  for (const attachmentIds of [[theirs.attachmentId], [mine, crypto.randomUUID()], [mine, ...Array.from({ length: 5 }, () => crypto.randomUUID())], [mine, mine], [await staged('video/mp4', mp4()), await staged('video/webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), randomBytes(32)]))]]) {
    expect(await rejected(submit({ ...input(), attachmentIds }), 400)).toEqual({ error: 'invalid' })
  }
  expect(calls).toHaveLength(0)
  // Fifteen files per member, then 100 MB; the other member's file is unaffected.
  for (let i = 0; i < 12; i++) await staged('image/png', png())
  expect(await rejected(stage('image/png', png()), 429)).toEqual({ error: 'rate_limited', retryAfterSeconds: expect.any(Number) as number })
  const bulky = Buffer.concat([PNG, Buffer.alloc(10_000_000 - PNG.length)])
  for (let i = 0; i < 10; i++) await other(() => stageFeedbackAttachment(s.deps, 'image/png', i < 9 ? bulky : Buffer.concat([PNG, Buffer.alloc(9_999_000)])))
  await expect(other(() => stageFeedbackAttachment(s.deps, 'image/png', Buffer.concat([PNG, Buffer.alloc(1_000)])))).rejects.toMatchObject({ status: 429, message: 'rate_limited' })
})

it('resends the same manifest and files after relay_unreachable', async () => {
  await register()
  const file = png()
  const request = { ...input(), attachmentIds: [await staged('image/png', file)] }
  status = 503
  expect((await submit(request)).status).toBe(502)
  expect(puts).toEqual([])
  expect(stagingFiles()).toHaveLength(1)
  status = 202
  expect(await (await submit(request)).json()).toMatchObject({ status: 'sent', attachments: [{ status: 'sent' }] })
  expect(new Set(calls.map((call) => call.raw)).size).toBe(1)
  expect(puts.map((put) => put.body.equals(file))).toEqual([true])
  expect(stagingFiles()).toEqual([])
})

it('recovers an interrupted upload by resubmitting the same report', async () => {
  await register()
  const files = [png(), png()]
  const request = { ...input(), attachmentIds: [await staged('image/png', files[0]!), await staged('image/png', files[1]!)] }
  // The first file is stored but its answer is lost; the second never arrives on the first attempt.
  putAnswer = (index, attempt) => (attempt > 0 ? 'store' : index === 0 ? 'store-then-drop' : 'drop')
  expect(await (await submit(request)).json()).toMatchObject({ status: 'sent', reportId: 'report-1', attachments: [{ status: 'sent' }, { status: 'sent' }] })
  expect(calls).toHaveLength(2)
  expect(calls[1]!.raw).toBe(calls[0]!.raw)
  expect(reports.size).toBe(1)
  expect(puts.map((put) => [put.index, put.body.equals(files[put.index]!)])).toEqual([[0, true], [1, true]])
  expect(stagingFiles()).toEqual([])
})

it('leaves an upload that stays unknown for the client to retry', async () => {
  await register()
  const request = { ...input(), attachmentIds: [await staged('image/png', png())] }
  putAnswer = (_, attempt) => (attempt < 2 ? 'drop' : 'store')
  expect(await (await submit(request)).json()).toEqual({ error: 'relay_unreachable' })
  expect(stagingFiles()).toHaveLength(1)
  expect(await (await submit(request)).json()).toMatchObject({ status: 'sent', attachments: [{ status: 'sent' }] })
  expect(reports.size).toBe(1)
  expect(stagingFiles()).toEqual([])
})

it('expires unreferenced staged files after an hour', async () => {
  await register()
  const start = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
  const stale = await staged('image/png', png())
  clock.mockReturnValue(start + 3601 * 1000)
  const fresh = await staged('image/png', png())
  expect(stagingFiles()).toEqual([fresh])
  const index = (await s.deps.sessionStore.deps.storage.documents.get('feedback', 'attachments'))?.value as { entries: { attachmentId: string }[] }
  expect(index.entries.map((row) => row.attachmentId)).toEqual([fresh])
  expect(await (await submit({ ...input(), attachmentIds: [stale] })).json()).toEqual({ error: 'invalid' })
  expect(calls).toHaveLength(0)
})

it('authenticates attachment staging and options', async () => {
  const protectedServer = await bootTestServer({ env: { HOME: '/synthetic-home', HERMES_WEBUI_PASSWORD: 'synthetic-password-only' } })
  try {
    expect((await protectedServer.get('/api/feedback/options')).status).toBe(401)
    const form = new FormData()
    form.append('contentType', 'image/png')
    form.append('file', new Blob([png()]), 'capture')
    expect((await protectedServer.get('/api/feedback/attachments', { method: 'POST', body: form })).status).toBe(401)
  } finally { await protectedServer.close() }
})

it('keeps staged files across a Relay refusal so the same request can still send them', async () => {
  await register()
  const file = png()
  const request = { ...input(), attachmentIds: [await staged('image/png', file)] }
  status = 429
  expect((await submit(request)).status).toBe(429)
  expect(stagingFiles()).toHaveLength(1)
  status = 202
  expect(await (await submit(request)).json()).toMatchObject({ status: 'sent', attachments: [{ status: 'sent' }] })
  expect(puts.map((put) => put.body.equals(file))).toEqual([true])
  expect(stagingFiles()).toEqual([])
})

it('lets one request claim a staged file and returns the claim when admission refuses the report', async () => {
  await register()
  const shared = await staged('image/png', png())
  // Two different request IDs race for one file: exactly one report may carry it.
  const raced = await Promise.all([submit({ ...input(), attachmentIds: [shared] }), submit({ ...input(), attachmentIds: [shared] })])
  expect(raced.map((response) => response.status).sort()).toEqual([200, 400])
  expect(calls).toHaveLength(1)
  expect(puts).toHaveLength(1)
  const spare = await staged('image/png', png())
  expect((await submit({ ...input(), body: '\u0000'.repeat(8000), attachmentIds: [spare] })).status).toBe(400)
  expect(await (await submit({ ...input(), attachmentIds: [spare] })).json()).toMatchObject({ status: 'sent', attachments: [{ attachmentId: spare, status: 'sent' }] })
})
