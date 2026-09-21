/** Binary and public raw handlers: `/api/transcribe`, `/api/tts`, `/api/csp-report` (Python `handle_transcribe`, `_handle_tts`, `_handle_csp_report`). */
import { join } from 'node:path'
import { isIPv4, isIPv6 } from 'node:net'
import type { RequestContext } from '../http/context.js'
import { activeProfileName } from '../auth/gate.js'
import { parseMultipart, sanitizeUploadName } from '../workspace/upload.js'
import { loadEnvFile } from '../providers/env-file.js'
import { dict } from '../config/agent-config.js'
import { SidecarError } from '../sidecar/client.js'
import { str } from '../util.js'
import { readCapped } from '../http/capped.js'
import { rateLimitClientIp } from './router.js'

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const CSP_MAX_BODY = 64 * 1024
const TTS_TIMEOUT_MS = 30_000
const TTS_MAX_AUDIO_BYTES = 16 * 1024 * 1024

export async function handleTranscribe(ctx: RequestContext): Promise<void> {
  const contentType = ctx.header('content-type') ?? ''
  const length = Number(ctx.header('content-length') ?? 0)
  if (length > MAX_UPLOAD_BYTES) { ctx.json({ error: `File too large (max ${String(MAX_UPLOAD_BYTES / 1024 / 1024)}MB)` }, { status: 413 }); return }
  let parsed: ReturnType<typeof parseMultipart>
  try {
    parsed = parseMultipart(await ctx.readRawBody(MAX_UPLOAD_BYTES), contentType)
  } catch (error) {
    ctx.json({ error: str((error as Error).message) }, { status: 400 })
    return
  }
  const file = parsed.files.file
  if (!file) { ctx.json({ error: 'No file field in request' }, { status: 400 }); return }
  if (!file.filename) { ctx.json({ error: 'No filename in upload' }, { status: 400 }); return }
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

/** Python `_tts_addr_is_blocked`: every non-global range (loopback, private, link-local, CGNAT, benchmarking, documentation, multicast, reserved). */
function blockedTtsAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const v4 = (ip: string): boolean => {
    const p = ip.split('.').map(Number)
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
    const [a, b] = p as [number, number, number, number]
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224
  }
  if (isIPv4(h)) return v4(h)
  if (isIPv6(h)) {
    if (h.startsWith('::ffff:')) { const tail = h.slice(7); return isIPv4(tail) ? v4(tail) : true }
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('2001:db8')
  }
  return false
}

function normalizedOpenAiBase(raw: string): string {
  const u = new URL(raw)
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('invalid base_url')
  if (blockedTtsAddress(u.hostname)) throw new Error('invalid base_url')
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
  const engine = (str(body.engine) || 'openai').trim().toLowerCase()
  if (rate === null) { ctx.json({ error: 'invalid rate' }, { status: 400 }); return }
  if (pitch === null) { ctx.json({ error: 'invalid pitch' }, { status: 400 }); return }
  if (!text) { ctx.json({ error: 'text is required' }, { status: 400 }); return }
  if (text.length > 5000) { ctx.json({ error: 'text too long (max 5000 characters)' }, { status: 400 }); return }
  // Python `_client_ip_for_rate_limit`: the peer address, or the forwarded client only behind an opted-in trusted proxy.
  if (ctx.deps.ttsLimiter.limited(rateLimitClientIp(ctx) || 'unknown')) { ctx.json({ error: 'rate limit exceeded — please wait' }, { status: 429 }); return }
  const home = ctx.deps.profileHome(activeProfileName(ctx))
  const env = { ...loadEnvFile(join(home, '.env')), ...ctx.deps.config.env }
  const config: Record<string, unknown> = await ctx.deps.agentConfig.read(home).catch(() => ({}))
  const tts = dict(config.tts)
  const f = ctx.deps.fetch
  if (engine === 'elevenlabs') {
    const apiKey = (env.ELEVENLABS_API_KEY ?? '').trim()
    if (!apiKey) { ctx.json({ error: 'ELEVENLABS_API_KEY not configured' }, { status: 503 }); return }
    const el = dict(tts.elevenlabs)
    const voiceId = str(body.voice_id ?? el.voice_id ?? '21m00Tcm4TlvDq8ikWAM').trim()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(voiceId)) { ctx.json({ error: 'invalid voice_id in config' }, { status: 400 }); return }
    try {
      const res = await f(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`, { method: 'POST', headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify({ text, model_id: str(el.model_id) || 'eleven_multilingual_v2' }), redirect: 'error', signal: AbortSignal.timeout(TTS_TIMEOUT_MS) })
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
    try {
      const res = await f(`${base}/audio/speech`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify({ model: str(oai.model) || 'gpt-4o-mini-tts', input: text, voice: str(oai.voice) || 'alloy' }), redirect: 'error', signal: AbortSignal.timeout(TTS_TIMEOUT_MS) })
      if (!res.ok) { ctx.json({ error: 'OpenAI TTS generation failed' }, { status: 502 }); return }
      const audio = await bufferAudio(res)
      ctx.send({ status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }, body: audio, security: true })
    } catch (error) {
      ctx.deps.log(`[tts] openai failed: ${str((error as Error).message)}`)
      ctx.json({ error: 'OpenAI TTS generation failed' }, { status: upstreamFailureStatus(error) })
    }
    return
  }
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
