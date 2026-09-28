/**
 * TTS, tool-argument cap, and speech-settings regressions.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { writeEnvFile } from '../providers/env-file.js'
import { WindowLimiter } from '../api/tools-router.js'
import { TOOL_ARG_CONTENT_CAP, TOOL_ARG_CONTENT_KEYS, truncateToolArgs } from '../sessions/merge.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

interface Captured { url: string; init: RequestInit | undefined; addresses?: string[] }

/** Hostnames the fake resolver answers; anything else is NXDOMAIN. */
const DNS: Record<string, string[]> = { 'custom.example.com': ['93.184.216.34'], 'api.openai.com': ['104.18.7.192'], 'rebind.example.com': ['93.184.216.34', '10.0.0.5'], 'internal.example.com': ['192.168.1.10'] }

/** Upstream engines keyed by the posted text: `big` streams without end, `json` answers JSON, `redirect` answers 302. */
function ttsFetch(requests: Captured[]): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push({ url, init })
    const body = typeof init?.body === 'string' ? init.body : ''
    const text = (JSON.parse(body || '{}') as { text?: string; input?: string })
    const marker = text.input ?? text.text ?? ''
    if (marker === 'big') return Promise.resolve(new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)) } }), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
    if (marker === 'json') return Promise.resolve(new Response('{"error":"nope"}', { status: 200, headers: { 'content-type': 'application/json' } }))
    if (marker === 'redirect') return Promise.resolve(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }))
    return Promise.resolve(new Response(Buffer.from(url.includes('elevenlabs') ? 'ID3eleven' : 'ID3openai'), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
  }
}

function bootTts(env: Record<string, string> = {}): Promise<{ s: TestServer; sidecar: FakeSidecar; requests: Captured[]; configs: Map<string, Json> }> {
  const sidecar = new FakeSidecar()
  const configs = new Map<string, Json>()
  const requests: Captured[] = []
  sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: configs.get(params.profile_home) ?? {} }))
  return bootTestServer({ sidecar, env, deps: (deps) => {
    const f = ttsFetch(requests)
    deps.fetch = f
    deps.dnsLookup = (hostname) => { const a = DNS[hostname]; return a ? Promise.resolve(a.map((address) => ({ address, family: 4 }))) : Promise.reject(new Error(`ENOTFOUND ${hostname}`)) }
    deps.pinnedFetch = async (url, init, addresses) => { const res = await f(url, init); requests.at(-1)!.addresses = addresses; return res }
  } }).then((s) => { writeFileSync(join(s.state, 'config.yaml'), '# seed\n'); return { s, sidecar, requests, configs } })
}

describe('TTS validation, limits, and engines', () => {
  let s: TestServer
  let requests: Captured[]
  let configs: Map<string, Json>
  let sidecar: FakeSidecar
  beforeAll(async () => { ({ s, requests, configs, sidecar } = await bootTts()) })
  afterAll(() => s.close())
  const setConfig = (cfg: Json): void => { configs.set(s.state, cfg); s.deps.agentConfig.invalidate() }
  const setEnv = (keys: Record<string, string | null>): void => { writeEnvFile(join(s.state, '.env'), keys) }
  const fresh = (): void => { s.deps.ttsLimiter = new WindowLimiter(60, 100); requests.length = 0 }

  it('GET /api/tts answers 405', async () => {
    const res = await s.get('/api/tts')
    expect(res.status).toBe(405)
    expect(String((await json(res)).error)).toContain('POST required')
  })

  it('5001 characters answer 400 too long', async () => {
    fresh()
    const res = await post(s, '/api/tts', { text: 'x'.repeat(5001), engine: 'openai' })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toContain('too long')
    expect(requests).toEqual([])
  })

  it('an invalid rate answers 400 before any engine call', async () => {
    fresh()
    const res = await post(s, '/api/tts', { text: 'hi', rate: '<break/>', engine: 'openai' })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toContain('invalid rate')
    expect(requests).toEqual([])
  })

  it('an invalid pitch answers 400 before any engine call', async () => {
    fresh()
    const res = await post(s, '/api/tts', { text: 'hi', pitch: '+500Hz', engine: 'openai' })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toContain('invalid pitch')
    expect(requests).toEqual([])
  })

  it('X-Forwarded-For does not split the limiter key unless opted in', async () => {
    setEnv({ OPENAI_API_KEY: 'sk-openai-1234' })
    s.deps.ttsLimiter = new WindowLimiter(60, 1)
    expect((await post(s, '/api/tts', { text: 'hi', engine: 'openai' }, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(200)
    expect((await post(s, '/api/tts', { text: 'hi', engine: 'openai' }, { 'x-forwarded-for': '203.0.113.2' })).status).toBe(429)
  })

  it('ElevenLabs without a key answers 503 and calls nothing', async () => {
    fresh()
    setEnv({ ELEVENLABS_API_KEY: null })
    const res = await post(s, '/api/tts', { text: 'hi', engine: 'elevenlabs' })
    expect(res.status).toBe(503)
    expect(String((await json(res)).error)).toContain('ELEVENLABS_API_KEY')
    expect(requests).toEqual([])
  })

  it('a traversal voice_id in config answers 400 before any request', async () => {
    fresh()
    setEnv({ ELEVENLABS_API_KEY: 'el-key-1234' })
    setConfig({ tts: { elevenlabs: { voice_id: '../../etc/passwd' } } })
    const res = await post(s, '/api/tts', { text: 'hi', engine: 'elevenlabs' })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toContain('voice_id')
    expect(requests).toEqual([])
  })

  it('a keyed ElevenLabs request streams audio/mpeg with the voice id, key header, and text', async () => {
    fresh()
    setEnv({ ELEVENLABS_API_KEY: 'el-key-1234' })
    setConfig({ tts: { elevenlabs: { voice_id: 'voiceABC', model_id: 'eleven_turbo' } } })
    const res = await post(s, '/api/tts', { text: 'hello there', engine: 'elevenlabs' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('ID3eleven')
    expect(requests[0]?.url).toContain('/text-to-speech/voiceABC/')
    expect((requests[0]?.init?.headers as Record<string, string>)['xi-api-key']).toBe('el-key-1234')
    expect(JSON.parse(requests[0]?.init?.body as string) as Json).toMatchObject({ text: 'hello there', model_id: 'eleven_turbo', voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
    // Python read `tts.elevenlabs.model` before `model_id`, defaulted the voice to Adam, and defaulted the engine to
    // Edge — which this release answers with the documented 503 rather than running OpenAI on the operator's key.
    fresh()
    setEnv({ ELEVENLABS_API_KEY: 'el-key-1234' })
    setConfig({ tts: { elevenlabs: { model: 'eleven_v3' } } })
    await post(s, '/api/tts', { text: 'again', engine: 'elevenlabs' })
    expect(requests[0]?.url).toContain('/text-to-speech/pNInz6obpgDQGcFmaJgB/')
    expect(JSON.parse(requests[0]?.init?.body as string) as Json).toMatchObject({ model_id: 'eleven_v3' })
    fresh()
    const defaulted = await post(s, '/api/tts', { text: 'no engine' })
    expect(defaulted.status).toBe(503)
    expect(requests).toEqual([])
  })

  it('the 5000-character cap applies to ElevenLabs before any request', async () => {
    fresh()
    setEnv({ ELEVENLABS_API_KEY: 'el-key-1234' })
    const res = await post(s, '/api/tts', { text: 'x'.repeat(5001), engine: 'elevenlabs' })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toContain('too long')
    expect(requests).toEqual([])
  })

  it('oversized ElevenLabs audio answers 502', async () => {
    fresh()
    setEnv({ ELEVENLABS_API_KEY: 'el-key-1234' })
    setConfig({})
    const res = await post(s, '/api/tts', { text: 'big', engine: 'elevenlabs' })
    expect(res.status).toBe(502)
    expect(await json(res)).toEqual({ error: 'ElevenLabs TTS generation failed' })
  })

  it('an ElevenLabs redirect is not followed and answers 502', async () => {
    fresh()
    setEnv({ ELEVENLABS_API_KEY: 'el-key-1234' })
    const res = await post(s, '/api/tts', { text: 'redirect', engine: 'elevenlabs' })
    expect(res.status).toBe(502)
    expect(await json(res)).toEqual({ error: 'ElevenLabs TTS generation failed' })
    expect(requests).toHaveLength(1)
  })

  it('OpenAI TTS posts the default model and voice with the bearer key', async () => {
    fresh()
    setEnv({ OPENAI_API_KEY: 'sk-openai-1234', VOICE_TOOLS_OPENAI_KEY: null })
    setConfig({})
    const res = await post(s, '/api/tts', { text: 'Hello', engine: 'openai' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('ID3openai')
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/audio/speech')
    expect((requests[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai-1234')
    expect(JSON.parse(requests[0]?.init?.body as string)).toEqual({ model: 'gpt-4o-mini-tts', input: 'Hello', voice: 'alloy' })
  })

  it('VOICE_TOOLS_OPENAI_KEY wins over OPENAI_API_KEY', async () => {
    fresh()
    setEnv({ OPENAI_API_KEY: 'sk-openai-1234', VOICE_TOOLS_OPENAI_KEY: 'sk-voice-tools-1234' })
    expect((await post(s, '/api/tts', { text: 'Hello', engine: 'openai' })).status).toBe(200)
    expect((requests[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-voice-tools-1234')
    setEnv({ VOICE_TOOLS_OPENAI_KEY: null })
  })

  it('tts.openai base_url, model, and voice override the request', async () => {
    fresh()
    setEnv({ OPENAI_API_KEY: 'sk-openai-1234' })
    setConfig({ tts: { openai: { base_url: 'https://custom.example.com/v1', model: 'tts-custom', voice: 'nova' } } })
    expect((await post(s, '/api/tts', { text: 'Hello', engine: 'openai' })).status).toBe(200)
    expect(requests[0]?.url).toBe('https://custom.example.com/v1/audio/speech')
    expect(requests[0]?.addresses).toEqual(['93.184.216.34'])
    expect(JSON.parse(requests[0]?.init?.body as string)).toEqual({ model: 'tts-custom', input: 'Hello', voice: 'nova' })
  })

  it('an https base_url whose DNS answers include a private address is refused before the bearer is sent, and an unresolvable one is an upstream failure', async () => {
    fresh()
    setEnv({ OPENAI_API_KEY: 'sk-openai-1234' })
    for (const host of ['rebind.example.com', 'internal.example.com']) {
      setConfig({ tts: { openai: { base_url: `https://${host}/v1` } } })
      const res = await post(s, '/api/tts', { text: 'Hello', engine: 'openai' })
      expect(res.status).toBe(400)
      expect(String((await json(res)).error)).toContain('base_url')
      expect(requests).toEqual([])
    }
    setConfig({ tts: { openai: { base_url: 'https://nxdomain.example.com/v1' } } })
    expect((await post(s, '/api/tts', { text: 'Hello', engine: 'openai' })).status).toBe(502)
    expect(requests).toEqual([])
  })

  it('the ElevenLabs voice comes from the operator config only, never from the request', async () => {
    fresh()
    setConfig({ tts: { elevenlabs: { voice_id: 'voiceCONFIG' } } })
    setEnv({ ELEVENLABS_API_KEY: 'el-key-1234' })
    expect((await post(s, '/api/tts', { text: 'Hello', engine: 'elevenlabs', voice_id: 'voiceATTACKER' })).status).toBe(200)
    expect(requests[0]?.url).toContain('/text-to-speech/voiceCONFIG/')
    setEnv({ ELEVENLABS_API_KEY: null })
  })

  it('a named profile never uses a key the default profile .env put into the process environment', async () => {
    fresh()
    setConfig({})
    setEnv({ OPENAI_API_KEY: null, VOICE_TOOLS_OPENAI_KEY: null })
    const env = s.deps.config.env
    env.OPENAI_API_KEY = 'sk-root-dotenv-1234'
    env.HERMES_WEBUI_HOME_DOTENV_KEYS = 'OPENAI_API_KEY'
    mkdirSync(join(s.state, 'profiles', 'voice'), { recursive: true })
    sidecar.respond('profiles.list', () => ({ profiles: [{ name: 'default', path: s.state, is_default: true, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }, { name: 'voice', path: join(s.state, 'profiles', 'voice'), is_default: false, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }] }))
    s.deps.profiles.invalidate()
    try {
      const switched = await post(s, '/api/profile/switch', { name: 'voice' })
      const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      // The default profile itself still has its key.
      expect((await post(s, '/api/tts', { text: 'Hello', engine: 'openai' })).status).toBe(200)
      expect((requests[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-root-dotenv-1234')
      fresh()
      let res = await post(s, '/api/tts', { text: 'Hello', engine: 'openai' }, { cookie })
      expect(res.status).toBe(503)
      expect(String((await json(res)).error)).toContain('not configured')
      expect(requests).toEqual([])
      // Its own .env key is used, never the root one.
      writeEnvFile(join(s.state, 'profiles', 'voice', '.env'), { OPENAI_API_KEY: 'sk-voice-own-1234' })
      res = await post(s, '/api/tts', { text: 'Hello', engine: 'openai' }, { cookie })
      expect(res.status).toBe(200)
      expect((requests[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-voice-own-1234')
    } finally {
      delete env.OPENAI_API_KEY
      delete env.HERMES_WEBUI_HOME_DOTENV_KEYS
      sidecar.respond('profiles.list', () => ({ profiles: [{ name: 'default', path: s.state, is_default: true, gateway_running: false, model: null, provider: null, has_env: false, visible: true, skill_count: 0, enabled_skills: 0, total_skills: 0 }] }))
      s.deps.profiles.invalidate()
    }
  })

  it('an unreadable profile config answers 503 instead of falling back to the public OpenAI endpoint', async () => {
    fresh()
    setEnv({ OPENAI_API_KEY: 'sk-openai-1234' })
    setConfig({ tts: { openai: { base_url: 'https://custom.example.com/v1' } } })
    // The config read fails between the config change and the request: the operator's endpoint is unknown.
    sidecar.respond('config.get', () => { throw new Error('sidecar restarting') })
    try {
      const res = await post(s, '/api/tts', { text: 'Hello', engine: 'openai' })
      expect(res.status).toBe(503)
      expect(String((await json(res)).error)).toContain('configuration is unavailable')
      expect(requests).toEqual([])
    } finally {
      sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: configs.get(params.profile_home) ?? {} }))
    }
  })

  it('a public http base_url is refused while loopback http is allowed for development', async () => {
    fresh()
    setEnv({ OPENAI_API_KEY: 'sk-openai-1234' })
    setConfig({ tts: { openai: { base_url: 'http://tts.example.com/v1' } } })
    let res = await post(s, '/api/tts', { text: 'Hello', engine: 'openai' })
    expect(res.status).toBe(400)
    expect(requests).toEqual([])
    setConfig({ tts: { openai: { base_url: 'http://localhost:8080/v1' } } })
    res = await post(s, '/api/tts', { text: 'Hello', engine: 'openai' })
    expect(res.status).toBe(200)
    expect(requests[0]?.url).toBe('http://localhost:8080/v1/audio/speech')
  })

  it.each(['http://169.254.169.254/v1', 'https://user:pass@api.example.com/v1', 'http://user:pass@localhost:8080/v1', 'https://169.254.169.254/v1', 'https://10.0.0.5/v1', 'https://192.168.1.10/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1', 'https://[::ffff:7f00:1]/v1', 'https://[64:ff9b::a9fe:a9fe]/v1'])(
    'base_url %s answers 400', async (baseUrl) => {
      fresh()
      setEnv({ OPENAI_API_KEY: 'sk-openai-1234' })
      setConfig({ tts: { openai: { base_url: baseUrl } } })
      const res = await post(s, '/api/tts', { text: 'Hello', engine: 'openai' })
      expect(res.status).toBe(400)
      expect(String((await json(res)).error)).toContain('base_url')
      expect(requests).toEqual([])
    })

  it('a JSON upstream body answers 502', async () => {
    fresh()
    setEnv({ OPENAI_API_KEY: 'sk-openai-1234' })
    setConfig({})
    const res = await post(s, '/api/tts', { text: 'json', engine: 'openai' })
    expect(res.status).toBe(502)
    expect(await json(res)).toEqual({ error: 'OpenAI TTS generation failed' })
  })

  it('an OpenAI redirect is not followed and the bearer is never re-sent', async () => {
    fresh()
    setEnv({ OPENAI_API_KEY: 'sk-openai-1234' })
    const res = await post(s, '/api/tts', { text: 'redirect', engine: 'openai' })
    expect(res.status).toBe(502)
    expect(requests).toHaveLength(1)
    // The pinned client returns 3xx as-is (pinned.test.ts); the loopback http path still passes `redirect: 'error'`.
    expect(requests[0]?.addresses).toEqual(['104.18.7.192'])
  })

  it('the redirect target is never dialled', async () => {
    fresh()
    setEnv({ OPENAI_API_KEY: 'sk-openai-1234' })
    expect((await post(s, '/api/tts', { text: 'redirect', engine: 'openai' })).status).toBe(502)
    expect(requests.map((r) => r.url)).toEqual(['https://api.openai.com/v1/audio/speech'])
  })

  it('oversized OpenAI audio answers 502', async () => {
    fresh()
    setEnv({ OPENAI_API_KEY: 'sk-openai-1234' })
    const res = await post(s, '/api/tts', { text: 'big', engine: 'openai' })
    expect(res.status).toBe(502)
    expect(await json(res)).toEqual({ error: 'OpenAI TTS generation failed' })
  })
})

describe('TTS limiter behind an opted-in trusted proxy', () => {
  let s: TestServer
  beforeAll(async () => { ({ s } = await bootTts({ HERMES_WEBUI_TRUST_FORWARDED_FOR: '1' })); writeEnvFile(join(s.state, '.env'), { OPENAI_API_KEY: 'sk-openai-1234' }) })
  afterAll(() => s.close())

  it('different forwarded clients get separate limiter keys', async () => {
    s.deps.ttsLimiter = new WindowLimiter(60, 1)
    expect((await post(s, '/api/tts', { text: 'hi', engine: 'openai' }, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(200)
    expect((await post(s, '/api/tts', { text: 'hi', engine: 'openai' }, { 'x-forwarded-for': '203.0.113.2' })).status).toBe(200)
    expect((await post(s, '/api/tts', { text: 'hi', engine: 'openai' }, { 'x-forwarded-for': '203.0.113.2' })).status).toBe(429)
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
