/** Binary and public raw handlers: `/api/transcribe`, `/api/tts`, `/api/csp-report` (Python `handle_transcribe`, `_handle_tts`, `_handle_csp_report`). */
import { join } from 'node:path'
import { homeDotenvKeys } from '../cli/dotenv.js'
import { isIP } from 'node:net'
import { isNonGlobalAddress } from '../http/addresses.js'
import { BlockedAddressError, vettedAddresses } from '../http/pinned.js'
import type { RequestContext } from '../http/context.js'
import { activeProfileName } from '../auth/gate.js'
import { sanitizeUploadName } from '../workspace/upload.js'
import { loadEnvFile } from '../providers/env-file.js'
import { dict } from '../config/agent-config.js'
import { SidecarError } from '../sidecar/client.js'
import { str } from '../util.js'
import { readCapped } from '../http/capped.js'
import { rateLimitClientIp } from './router.js'
import { readUploadForm, uploadFile } from './raw-routes.js'

const CSP_MAX_BODY = 64 * 1024
const TTS_TIMEOUT_MS = 30_000
const TTS_MAX_AUDIO_BYTES = 16 * 1024 * 1024

export async function handleTranscribe(ctx: RequestContext): Promise<void> {
  const form = await readUploadForm(ctx)
  if (!form) return
  const file = uploadFile(ctx, form)
  if (!file) return
  let suffix = '.webm'
  try {
    const safe = sanitizeUploadName(file.filename)
    const dot = safe.lastIndexOf('.')
    if (dot > 0) suffix = safe.slice(dot)
  } catch (error) {
    ctx.json({ error: str((error as Error).message) }, { status: 400 })
    return
  }
  const sidecar = ctx.deps.sidecar()
  if (!sidecar) { ctx.json({ error: 'Speech-to-text is unavailable on this server' }, { status: 503 }); return }
  try {
    const result = await sidecar.call('stt.transcribe', { profile_home: ctx.deps.profileHome(activeProfileName(ctx)), audio_b64: file.body.toString('base64'), suffix }, { timeoutMs: 120_000 })
    ctx.json({ ok: true, transcript: result.transcript.trim() })
  } catch (error) {
    if (error instanceof SidecarError) {
      const message = error.message || 'Transcription failed'
      const status = error.condition === 'sidecar_unavailable' || /unavailable|not configured/i.test(message) ? 503 : 400
      ctx.json({ error: message }, { status })
      return
    }
    ctx.deps.log(`[webui] transcribe error: ${str((error as Error).stack ?? (error as Error).message)}`)
    ctx.json({ error: 'Transcription failed' }, { status: 500 })
  }
}

function prosody(value: unknown, unit: string): string | null {
  if (value === null || value === undefined || value === '') return ''
  const text = str(value).trim()
  const m = /^([+-]?\d+(?:\.\d+)?)(%|Hz)?$/.exec(text)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || Math.abs(n) > 200) return null
  const sign = n >= 0 ? '+' : ''
  return `${sign}${String(n)}${unit}`
}

/** Python `_tts_addr_is_blocked`: `localhost` names and every non-global address (`http/addresses.ts`). */
function blockedTtsAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (!isIP(h)) return false
  return isNonGlobalAddress(h)
}

const TTS_LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Python `_normalized_openai_tts_base_url`: public hosts over HTTPS only (bearer never travels in clear); plain HTTP only to loopback for local development. */
function normalizedOpenAiBase(raw: string): string {
  const u = new URL(raw)
  if (u.username || u.password || u.search || u.hash) throw new Error('invalid base_url')
  const host = u.hostname.toLowerCase()
  if (u.protocol === 'https:') {
    if (blockedTtsAddress(host)) throw new Error('invalid base_url')
  } else if (u.protocol === 'http:') {
    if (!TTS_LOCALHOST_HOSTS.has(host)) throw new Error('invalid base_url')
  } else throw new Error('invalid base_url')
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`
}

/** An upstream engine answered, but not with usable audio (Python answers 502 for these; 500 stays for unexpected faults). */
class UpstreamAudioError extends Error {}

async function bufferAudio(res: Response): Promise<Buffer> {
  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  // A present non-audio Content-Type is rejected; a missing one is tolerated (some OpenAI-compatible servers omit it).
  if (type && !type.startsWith('audio/') && !type.includes('octet-stream')) throw new UpstreamAudioError(`unexpected content-type ${type}`)
  const raw = await readCapped(res, TTS_MAX_AUDIO_BYTES)
  if (!raw) throw new UpstreamAudioError('audio exceeds the proxy limit')
  if (!raw.length) throw new UpstreamAudioError('empty audio')
  return raw
}

/** Redirects (`redirect: 'error'`), non-audio bodies, and oversize bodies are upstream failures (502); anything else is a server fault (500). */
function upstreamFailureStatus(error: unknown): number {
  return error instanceof UpstreamAudioError || (error instanceof TypeError && /redirect/i.test(error.message)) ? 502 : 500
}

export async function handleTts(ctx: RequestContext): Promise<void> {
  let body: Record<string, unknown>
  try { body = await ctx.readJsonBody(64 * 1024) } catch { ctx.json({ error: 'invalid request body' }, { status: 400 }); return }
  const text = str(body.text).trim()
  const rate = prosody(body.rate, '%')
  const pitch = prosody(body.pitch, 'Hz')
  if (rate === null) { ctx.json({ error: 'invalid rate' }, { status: 400 }); return }
  if (pitch === null) { ctx.json({ error: 'invalid pitch' }, { status: 400 }); return }
  if (!text) { ctx.json({ error: 'text is required' }, { status: 400 }); return }
  if (text.length > 5000) { ctx.json({ error: 'text too long (max 5000 characters)' }, { status: 400 }); return }
  // Python `_client_ip_for_rate_limit`: the peer address, or the forwarded client only behind an opted-in trusted proxy.
  if (ctx.deps.ttsLimiter.limited(rateLimitClientIp(ctx) || 'unknown')) { ctx.json({ error: 'rate limit exceeded — please wait' }, { status: 429 }); return }
  const profile = activeProfileName(ctx)
  const home = ctx.deps.profileHome(profile)
  // Process-wide deployment values still apply, but variables the default profile's `.env` put into the process
  // environment at startup are that profile's own and never reach a named profile's request.
  const owned = ctx.deps.isRootProfile(profile) ? new Set<string>() : homeDotenvKeys(ctx.deps.config.env)
  const env = { ...loadEnvFile(join(home, '.env')), ...Object.fromEntries(Object.entries(ctx.deps.config.env).filter(([k]) => !owned.has(k))) }
  // An unreadable config must not degrade to the public defaults: the operator's endpoint, model, and voice are unknown.
  let config: Record<string, unknown>
  try { config = await ctx.deps.agentConfig.read(home) } catch (error) {
    ctx.deps.log(`[tts] config.yaml unavailable: ${str((error as Error).message)}`)
    ctx.json({ error: 'Agent configuration is unavailable; retry shortly' }, { status: 503 }); return
  }
  const tts = dict(config.tts)
  // A request that names no engine uses the profile's configured `tts.provider`.
  const engine = (str(body.engine).trim() || str(tts.provider).trim()).toLowerCase()
  if (!engine) { ctx.json({ error: 'No text-to-speech engine is configured', code: 'tts_unconfigured' }, { status: 503 }); return }
  const f = ctx.deps.fetch
  if (engine === 'elevenlabs') {
    const apiKey = (env.ELEVENLABS_API_KEY ?? '').trim()
    if (!apiKey) { ctx.json({ error: 'ELEVENLABS_API_KEY not configured' }, { status: 503 }); return }
    const el = dict(tts.elevenlabs)
    // The voice comes from the operator's config only (Python parity): a caller may not pick voices on the operator's key.
    // Python defaults: Adam, `tts.elevenlabs.model` before `model_id`, and fixed voice settings.
    const voiceId = str(el.voice_id ?? 'pNInz6obpgDQGcFmaJgB').trim()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(voiceId)) { ctx.json({ error: 'invalid voice_id in config' }, { status: 400 }); return }
    const modelId = str(el.model).trim() || str(el.model_id).trim() || 'eleven_multilingual_v2'
    try {
      const res = await f(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`, { method: 'POST', headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify({ text, model_id: modelId, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }), redirect: 'error', signal: AbortSignal.timeout(TTS_TIMEOUT_MS) })
      if (!res.ok) { ctx.json({ error: 'ElevenLabs TTS generation failed' }, { status: 502 }); return }
      const audio = await bufferAudio(res)
      ctx.send({ status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }, body: audio, security: true })
    } catch (error) {
      ctx.deps.log(`[tts] elevenlabs failed: ${str((error as Error).message)}`)
      ctx.json({ error: 'ElevenLabs TTS generation failed' }, { status: upstreamFailureStatus(error) })
    }
    return
  }
  if (engine === 'openai') {
    // Python: the dedicated voice-tools key wins over the general OpenAI key.
    const apiKey = ((env.VOICE_TOOLS_OPENAI_KEY ?? '').trim() || (env.OPENAI_API_KEY ?? '').trim())
    if (!apiKey) { ctx.json({ error: 'OpenAI API key not configured' }, { status: 503 }); return }
    const oai = dict(tts.openai)
    let base = 'https://api.openai.com/v1'
    try { base = normalizedOpenAiBase(str(oai.base_url) || base) } catch { ctx.json({ error: 'invalid OpenAI base_url in config' }, { status: 400 }); return }
    // The bearer only travels to an address that passed the same check as the hostname, over that very connection.
    let addresses: string[] = []
    if (base.startsWith('https:')) {
      try { addresses = await vettedAddresses(new URL(base).hostname, blockedTtsAddress, ctx.deps.dnsLookup) } catch (error) {
        if (error instanceof BlockedAddressError) { ctx.json({ error: 'invalid OpenAI base_url in config' }, { status: 400 }); return }
        ctx.deps.log(`[tts] openai base_url did not resolve: ${str((error as Error).message)}`)
        ctx.json({ error: 'OpenAI TTS generation failed' }, { status: 502 }); return
      }
    }
    try {
      const init = { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify({ model: str(oai.model) || 'gpt-4o-mini-tts', input: text, voice: str(oai.voice) || 'alloy' }), signal: AbortSignal.timeout(TTS_TIMEOUT_MS) }
      const res = addresses.length ? await ctx.deps.pinnedFetch(`${base}/audio/speech`, init, addresses) : await f(`${base}/audio/speech`, { ...init, redirect: 'error' })
      if (!res.ok) { ctx.json({ error: 'OpenAI TTS generation failed' }, { status: 502 }); return }
      const audio = await bufferAudio(res)
      ctx.send({ status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }, body: audio, security: true })
    } catch (error) {
      ctx.deps.log(`[tts] openai failed: ${str((error as Error).message)}`)
      ctx.json({ error: 'OpenAI TTS generation failed' }, { status: upstreamFailureStatus(error) })
    }
    return
  }
  // The matrix drops Edge TTS with a 503 (the decision's documented outcome); other names stay a 400.
  if (engine === 'edge') { ctx.json({ error: 'Edge TTS is not available in this release; use the browser, openai, or elevenlabs engine' }, { status: 503 }); return }
  ctx.json({ error: `unknown TTS engine ${engine}; Edge TTS was removed, use the browser, openai, or elevenlabs engine` }, { status: 400 })
}

/** Public sink: always 204, rate limited per client, payload logged. */
export async function handleCspReport(ctx: RequestContext): Promise<void> {
  const peer = ctx.peer || 'unknown'
  if (ctx.deps.cspLimiter.limited(peer)) {
    ctx.deps.log(`[csp-report] dropped report from ${peer}: rate limit exceeded`)
    ctx.send({ status: 204, body: '' })
    return
  }
  let payload: unknown
  try {
    const raw = await ctx.readRawBody(CSP_MAX_BODY)
    payload = raw.length ? JSON.parse(raw.toString('utf8')) : {}
  } catch (error) {
    payload = error instanceof Error && /too large/i.test(error.message) ? { discarded: 'body_too_large' } : { invalid: true }
  }
  ctx.deps.log(`[csp-report] from ${peer}: ${JSON.stringify(payload).slice(0, 4096)}`)
  ctx.send({ status: 204, body: '' })
}
