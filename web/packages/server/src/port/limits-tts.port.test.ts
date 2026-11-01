/** TTS routing, tool-argument cap, and speech-settings regressions. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RPC_ERROR_CODES } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { WindowLimiter } from '../api/tools-router.js'
import { TOOL_ARG_CONTENT_CAP, TOOL_ARG_CONTENT_KEYS, truncateToolArgs } from '../sessions/merge.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

async function bootTts(env: Record<string, string> = {}) {
  const sidecar = new FakeSidecar()
  const configs = new Map<string, Json>()
  const requests: unknown[] = []
  sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: configs.get(params.profile_home) ?? {} }))
  const s = await bootTestServer({ sidecar, env, deps: (deps) => {
    const forbidden = vi.fn((...args: unknown[]) => { requests.push(args); return Promise.reject(new Error('TTS must never fetch from Node')) })
    deps.fetch = forbidden
    deps.pinnedFetch = forbidden
    deps.dnsLookup = forbidden
  } })
  writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
  return { s, sidecar, requests, configs }
}

describe('TTS validation, limits, and engines', () => {
  let s: TestServer
  let requests: unknown[]
  let configs: Map<string, Json>
  let sidecar: FakeSidecar
  beforeAll(async () => { ({ s, requests, configs, sidecar } = await bootTts()) })
  afterAll(() => s.close())
  const setConfig = (cfg: Json): void => { configs.set(s.state, cfg); s.deps.agentConfig.invalidate() }
  const ttsCalls = () => sidecar.calls.filter((call) => call.method === 'tts.synthesize') as { params: Record<string, unknown> }[]
  const fresh = (): void => {
    s.deps.ttsLimiter = new WindowLimiter(60, 100)
    requests.length = 0
    sidecar.calls.length = 0
    sidecar.respond('tts.synthesize', undefined)
  }

  it.each([['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['flac', 'audio/flac']])('routes a configured Agent provider and returns %s without Node fetches', async (format, contentType) => {
    fresh()
    setConfig({ tts: { provider: 'piper' } })
    sidecar.respond('tts.synthesize', () => ({ provider: 'piper', format, audio_b64: Buffer.from('synthetic audio').toString('base64') }))
    const res = await post(s, '/api/tts', { text: 'Hello', rate: '+50%', pitch: '+20Hz', voice: 'ignored', voice_id: 'ignored' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(contentType)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('synthetic audio')
    expect(ttsCalls()).toEqual([{ method: 'tts.synthesize', params: { profile_home: s.state, text: 'Hello', provider: 'piper', speed: 1.5 } }])
    expect(requests).toEqual([])
  })

  it.each([['-200%', 0.5], ['+200%', 2], ['', undefined]])('maps rate %s to Agent speed %s', async (rate, speed) => {
    fresh()
    const res = await post(s, '/api/tts', { text: 'Hello', engine: 'openai', rate })
    expect(res.status).toBe(200)
    expect(ttsCalls()[0]?.params.speed).toBe(speed)
    expect(ttsCalls()[0]?.params.provider).toBe('openai')
    expect(requests).toEqual([])
  })

  it('GET /api/tts answers 405', async () => {
    const res = await s.get('/api/tts')
    expect(res.status).toBe(405)
    expect(String((await json(res)).error)).toContain('POST required')
  })

  it.each([
    [{ text: 'x'.repeat(5001), engine: 'openai' }, 'too long'],
    [{ text: 'x'.repeat(5001), engine: 'elevenlabs' }, 'too long'],
    [{ text: '', engine: 'piper' }, 'text is required'],
    [{ text: 'hi', rate: '<break/>' }, 'invalid rate'],
    [{ text: 'hi', pitch: '+500Hz' }, 'invalid pitch'],
  ])('rejects invalid text or prosody before synthesis', async (body, message) => {
    fresh()
    const res = await post(s, '/api/tts', body)
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toContain(message)
    expect(ttsCalls()).toEqual([])
    expect(requests).toEqual([])
  })

  it('X-Forwarded-For does not split the limiter key unless opted in', async () => {
    fresh()
    s.deps.ttsLimiter = new WindowLimiter(60, 1)
    expect((await post(s, '/api/tts', { text: 'hi', engine: 'openai' }, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(200)
    expect((await post(s, '/api/tts', { text: 'hi', engine: 'openai' }, { 'x-forwarded-for': '203.0.113.2' })).status).toBe(429)
    expect(ttsCalls()).toHaveLength(1)
  })

  it('uses configured providers, allows explicit overrides, and preserves the unconfigured fallback', async () => {
    fresh()
    setConfig({ tts: { provider: 'gemini' } })
    expect((await post(s, '/api/tts', { text: 'Hello' })).status).toBe(200)
    expect(ttsCalls()[0]?.params.provider).toBe('gemini')
    fresh()
    expect((await post(s, '/api/tts', { text: 'Hello', engine: 'edge' })).status).toBe(200)
    expect(ttsCalls()[0]?.params.provider).toBe('edge')
    fresh()
    setConfig({ tts: { elevenlabs: { model: 'eleven_v3' } } })
    const res = await post(s, '/api/tts', { text: 'Hello' })
    expect(res.status).toBe(503)
    expect(await json(res)).toMatchObject({ code: 'tts_unconfigured' })
    expect(ttsCalls()).toEqual([])
    expect(requests).toEqual([])
  })

  it.each([
    [new SidecarError('not registered', { code: RPC_ERROR_CODES.invalidParams, condition: 'invalid_params' }), 400, { error: 'unknown TTS engine bogus' }],
    [new SidecarError('private provider detail', { condition: 'tts_failed' }), 502, { error: 'Text-to-speech generation failed' }],
    [new SidecarError('sidecar restarting', { condition: 'sidecar_unavailable' }), 503, { condition: 'sidecar_unavailable' }],
    [new SidecarError('stale Agent', { condition: 'agent_runtime_stale' }), 503, { condition: 'agent_runtime_stale' }],
  ])('maps sidecar errors without disclosing provider failures', async (error, status, body) => {
    fresh()
    setConfig({})
    sidecar.respond('tts.synthesize', () => { throw error })
    const res = await post(s, '/api/tts', { text: 'Hello', engine: 'bogus' })
    expect(res.status).toBe(status)
    expect(await json(res)).toMatchObject(body)
    expect(requests).toEqual([])
  })

  it.each([
    { provider: 'piper', format: 'ogg', audio_b64: 'SUQz' },
    { provider: 'piper', format: 'mp3', audio_b64: '' },
    { provider: 'piper', format: 'mp3', audio_b64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') },
  ])('rejects unsupported, empty, or oversized sidecar audio', async (result) => {
    fresh()
    sidecar.respond('tts.synthesize', () => result)
    const res = await post(s, '/api/tts', { text: 'Hello', engine: 'piper' })
    expect(res.status).toBe(502)
    expect(await json(res)).toEqual({ error: 'Text-to-speech generation failed' })
    expect(requests).toEqual([])
  })

  it('a named profile sends only its own home, never keys or provider configuration', async () => {
    fresh()
    const home = join(s.state, 'profiles', 'voice')
    mkdirSync(home, { recursive: true })
    sidecar.respond('profiles.list', () => ({ profiles: [s.state, home].map((path, i) => ({ name: i ? 'voice' : 'default', path, is_default: !i, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 })) }))
    s.deps.profiles.invalidate()
    try {
      const switched = await post(s, '/api/profile/switch', { name: 'voice' })
      const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      const res = await post(s, '/api/tts', { text: 'Hello', engine: 'elevenlabs', voice_id: 'attacker' }, { cookie })
      expect(res.status).toBe(200)
      expect(ttsCalls()[0]?.params).toEqual({ profile_home: home, text: 'Hello', provider: 'elevenlabs' })
      expect(requests).toEqual([])
    } finally {
      sidecar.respond('profiles.list', undefined)
      s.deps.profiles.invalidate()
    }
  })

  it('an unreadable profile config answers 503 without synthesis', async () => {
    fresh()
    setConfig({})
    sidecar.respond('config.get', () => { throw new Error('sidecar restarting') })
    try {
      const res = await post(s, '/api/tts', { text: 'Hello', engine: 'openai' })
      expect(res.status).toBe(503)
      expect(String((await json(res)).error)).toContain('configuration is unavailable')
      expect(ttsCalls()).toEqual([])
      expect(requests).toEqual([])
    } finally {
      sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: configs.get(params.profile_home) ?? {} }))
    }
  })
  // TAL-906: the Agent's answers for these texts are recorded in contracts/fixtures/sidecar/text.json.
  const CORPUS = 'Saved peyton-sample-20260922.wav to /tmp/out/9f2c1e7a-3b4d-4c2e-8f1a-0b9e2d7c6a51.json, see https://example.com/a/b?x=1 and commit 4bf46b7c8.'
  const PROSE = 'Meet Ana on 2026-10-14 at ana@example.com; the ratio is 3:2, a well-known plan.'

  const expectSpokenCorpus = (spoken: string): void => {
    for (const identifier of ['peyton-sample-20260922.wav', '/tmp/out', '9f2c1e7a-3b4d-4c2e-8f1a-0b9e2d7c6a51', 'https://example.com']) expect(spoken).not.toContain(identifier)
    expect(spoken).toBe('Saved to, see and commit 4bf46b7c8.')
  }

  it('/api/tts sends the engine the Agent spoken text without the filename, path, UUID, or URL', async () => {
    fresh()
    setConfig({})
    const res = await post(s, '/api/tts', { text: CORPUS, engine: 'openai' })
    expect(res.status).toBe(200)
    expectSpokenCorpus(String(ttsCalls()[0]?.params.text))
  })

  it('speech.prepare answers the same spoken text', async () => {
    const res = await post(s, '/api/speech/prepare', { text: CORPUS })
    expect(res.status).toBe(200)
    expectSpokenCorpus(String((await json(res)).spoken_text))
  })

  it('speech.prepare keeps prose, dates, and emails as written', async () => {
    const res = await post(s, '/api/speech/prepare', { text: PROSE })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ spoken_text: PROSE })
  })

  it('a sidecar that cannot prepare the text leaves it as written, and a script with nothing to say calls no engine', async () => {
    fresh()
    setConfig({})
    const recorded = sidecar.responderFor('text.spoken')
    try {
      sidecar.respond('text.spoken', () => { throw new Error('boom') })
      expect(await json(await post(s, '/api/speech/prepare', { text: `  ${CORPUS}\n` }))).toEqual({ spoken_text: CORPUS })
      // The text as written keeps the 4000-character spoken cap.
      expect(await json(await post(s, '/api/speech/prepare', { text: 'word '.repeat(2000) }))).toEqual({ spoken_text: 'word '.repeat(800).trimEnd() })
      sidecar.respond('text.spoken', () => ({ spoken_text: '' }))
      const res = await post(s, '/api/tts', { text: '```\nls\n```', engine: 'openai' })
      expect(res.status).toBe(400)
      expect(String((await json(res)).error)).toContain('nothing to speak')
      expect(requests).toEqual([])
    } finally {
      sidecar.respond('text.spoken', recorded)
    }
  })

})

describe('TTS limiter behind an opted-in trusted proxy', () => {
  let s: TestServer
  beforeAll(async () => { ({ s } = await bootTts({ HERMES_WEBUI_TRUST_FORWARDED_FOR: '1' })) })
  afterAll(() => s.close())

  const tts = async (headers: Record<string, string>): Promise<number> => (await post(s, '/api/tts', { text: 'hi', engine: 'openai' }, headers)).status

  it('implicit loopback trust keys every forwarded client on the peer', async () => {
    s.deps.ttsLimiter = new WindowLimiter(60, 1)
    expect(await tts({ 'x-forwarded-for': '203.0.113.1' })).toBe(200)
    expect(await tts({ 'x-forwarded-for': '203.0.113.2' })).toBe(429)
  })

  it('a listed proxy gives different forwarded clients separate limiter keys', async () => {
    s.deps.config.env.HERMES_WEBUI_TRUSTED_PROXY_CIDRS = '127.0.0.1/32'
    try {
      s.deps.ttsLimiter = new WindowLimiter(60, 1)
      expect(await tts({ 'x-forwarded-for': '203.0.113.1' })).toBe(200)
      expect(await tts({ 'x-forwarded-for': '203.0.113.2' })).toBe(200)
      expect(await tts({ 'x-forwarded-for': '203.0.113.2' })).toBe(429)
      expect(await tts({ 'x-forwarded-for': '203.0.113.3', 'x-real-ip': '192.0.2.99' })).toBe(200)
      expect(await tts({ 'x-forwarded-for': '203.0.113.4', 'x-real-ip': '192.0.2.99' })).toBe(429)
    } finally {
      delete s.deps.config.env.HERMES_WEBUI_TRUSTED_PROXY_CIDRS
    }
  })
})

describe('tool argument content cap', () => {
  it('a long command survives past 120 characters', () => {
    const command = `${'echo start\n'.repeat(30)}echo end`
    expect(command.length).toBeGreaterThan(120)
    const out = truncateToolArgs({ command })
    expect(String(out.command).length).toBeGreaterThan(120)
    expect(String(out.command).endsWith('echo end')).toBe(true)
  })

  it('old_string, new_string, and patch keep their full text', () => {
    const out = truncateToolArgs({ old_string: 'a'.repeat(300), new_string: 'b'.repeat(300), patch: `@@ -1 +1 @@\n${'-x\n+y\n'.repeat(60)}` })
    expect(String(out.old_string).length).toBe(300)
    expect(String(out.new_string).length).toBe(300)
    expect(String(out.patch).startsWith('@@ -1 +1 @@')).toBe(true)
  })

  it('an incidental argument is cut to 120 characters', () => {
    expect(truncateToolArgs({ label: 'z'.repeat(300) }).label).toBe(`${'z'.repeat(120)}...`)
  })

  it('the content cap is at least 4000 and names command and old_string', () => {
    expect(TOOL_ARG_CONTENT_CAP).toBeGreaterThanOrEqual(4000)
    expect(TOOL_ARG_CONTENT_KEYS.has('command')).toBe(true)
    expect(TOOL_ARG_CONTENT_KEYS.has('old_string')).toBe(true)
  })

  it('a command past the cap is bounded to cap + ellipsis', () => {
    const out = truncateToolArgs({ command: 'c'.repeat(TOOL_ARG_CONTENT_CAP + 5000) })
    expect(String(out.command).endsWith('...')).toBe(true)
    expect(String(out.command).length).toBe(TOOL_ARG_CONTENT_CAP + 3)
  })
})

describe('speech settings', () => {
  let s: TestServer
  const SPEECH = { tts_enabled: false, tts_auto_read: false, tts_engine: 'browser', tts_voice: '', tts_rate: 1, tts_pitch: 1, voice_mode_button: false, voice_continuous: false, voice_silence_ms: 1800, raw_audio_mode: false }
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('GET /api/settings carries the speech defaults and no persisted speech keys', async () => {
    const body = await json(await s.get('/api/settings'))
    expect(body).toMatchObject(SPEECH)
    expect(body.persisted_speech_keys).toEqual([])
  })

  it('all speech keys round-trip with string coercion and report as persisted', async () => {
    const payload = { tts_enabled: true, tts_auto_read: true, tts_engine: 'openai', tts_voice: 'nova', tts_rate: '1.4', tts_pitch: '0', voice_mode_button: true, voice_continuous: true, voice_silence_ms: '2400', raw_audio_mode: true }
    const res = await post(s, '/api/settings', payload)
    expect(res.status).toBe(200)
    const expected = { ...payload, tts_rate: 1.4, tts_pitch: 0, voice_silence_ms: 2400 }
    expect(await json(res)).toMatchObject({ ...expected, persisted_speech_keys: Object.keys(payload).sort() })
    expect(await json(await s.get('/api/settings'))).toMatchObject({ ...expected, persisted_speech_keys: Object.keys(payload).sort() })
  })

  it('invalid speech values keep the previous ones while unrelated settings still apply', async () => {
    const res = await post(s, '/api/settings', { tts_engine: '', tts_voice: 'v'.repeat(201), tts_rate: 'nan', tts_pitch: 3, voice_silence_ms: 199, show_tps: true })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toMatchObject({ tts_engine: 'openai', tts_voice: 'nova', tts_rate: 1.4, tts_pitch: 0, voice_silence_ms: 2400, show_tps: true })
  })

  it('only the keys present in settings.json are reported as persisted', async () => {
    const other = await bootTestServer()
    try {
      writeFileSync(join(other.state, 'settings.json'), JSON.stringify({ tts_pitch: 0.5, voice_mode_button: true }))
      const body = await json(await other.get('/api/settings'))
      expect(body.persisted_speech_keys).toEqual(['tts_pitch', 'voice_mode_button'])
      expect(body).toMatchObject({ tts_pitch: 0.5, voice_mode_button: true, tts_enabled: false })
    } finally { await other.close() }
  })
})
