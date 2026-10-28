import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { saveRelayConfig } from '../sessions/relay.js'
import { JsonDocuments } from '../test/storage.js'

type Payload = Record<string, unknown>
let s: TestServer
let relay: Server
let url: string
let status: number
let calls: { raw: string; headers: import('node:http').IncomingHttpHeaders; payload: Payload }[]
const input = () => ({ requestId: crypto.randomUUID(), kind: 'bug', title: 'Private title', body: 'Private body', includeDiagnostics: true, client: { platform: 'web' } })
const submit = (body: unknown = input()) => s.get('/api/feedback/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
beforeEach(async () => {
  status = 202
  calls = []
  relay = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8').on('data', (chunk: string) => { raw += chunk }).on('end', () => {
      calls.push({ raw, headers: req.headers, payload: JSON.parse(raw) as Payload })
      res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '42' })
      res.end(JSON.stringify(status === 202 ? { reportId: 'report-1' } : { error: 'private Relay detail' }))
    })
  })
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
  expect(await (await submit(request)).json()).toEqual({ status: 'sent', reportId: 'report-1' })
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
