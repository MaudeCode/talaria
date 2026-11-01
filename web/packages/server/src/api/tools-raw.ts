/** Binary and public raw handlers: `/api/transcribe`, `/api/tts`, `/api/csp-report` (Python `handle_transcribe`, `_handle_tts`, `_handle_csp_report`). */
import { RPC_ERROR_CODES } from '@maudecode/talaria-web-contracts'
import type { RequestContext } from '../http/context.js'
import { activeProfileName } from '../auth/gate.js'
import { sanitizeUploadName } from '../workspace/upload.js'
import { dict } from '../config/agent-config.js'
import { SidecarError } from '../sidecar/client.js'
import { str } from '../util.js'
import { rateLimitClientIp } from './router.js'
import { readUploadForm, uploadFile } from './raw-routes.js'

const CSP_MAX_BODY = 64 * 1024
const TTS_TIMEOUT_MS = 30_000
const TTS_MAX_AUDIO_BYTES = 8 * 1024 * 1024
const TTS_CONTENT_TYPES = new Map([['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['flac', 'audio/flac']])
const SPOKEN_TEXT_TIMEOUT_MS = 10_000
/** The Agent's `prepare_spoken_text` default `max_chars`. */
const SPOKEN_TEXT_MAX_CHARS = 4000

export async function handleTranscribe(ctx: RequestContext): Promise<void> {
  const form = await readUploadForm(ctx)
  if (!form) return
  const file = (await uploadFile(ctx, form))
  if (!file) return
  let suffix = '.webm'
  try {
    const safe = sanitizeUploadName(file.filename)
    const dot = safe.lastIndexOf('.')
    if (dot > 0) suffix = safe.slice(dot)
  } catch (error) {
    await ctx.json({ error: str((error as Error).message) }, { status: 400 })
    return
  }
  const sidecar = ctx.deps.sidecar()
  if (!sidecar) { (await ctx.json({ error: 'Speech-to-text is unavailable on this server' }, { status: 503 })); return }
  try {
    const result = await sidecar.call('stt.transcribe', { profile_home: ctx.deps.profileHome(activeProfileName(ctx)), audio_b64: file.body.toString('base64'), suffix }, { timeoutMs: 120_000 })
    await ctx.json({ ok: true, transcript: result.transcript.trim(), filtered: result.filtered, no_speech: result.no_speech === true })
  } catch (error) {
    if (error instanceof SidecarError) {
      const message = error.message || 'Transcription failed'
      const status = error.condition === 'sidecar_unavailable' || /unavailable|not configured/i.test(message) ? 503 : 400
      await ctx.json({ error: message }, { status })
      return
    }
    ctx.deps.log(`[webui] transcribe error: ${str((error as Error).stack ?? (error as Error).message)}`)
    await ctx.json({ error: 'Transcription failed' }, { status: 500 })
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

/**
 * TAL-906: the Agent's read-aloud script for `text`, which every engine and client speaks; the text as written when the
 * sidecar cannot prepare it. Either way it keeps the Agent's spoken-text cap.
 */
export async function spokenText(ctx: RequestContext, text: string): Promise<string> {
  const sidecar = ctx.deps.sidecar()
  let spoken = text
  if (sidecar) {
    try {
      spoken = (await sidecar.call('text.spoken', { text }, { timeoutMs: SPOKEN_TEXT_TIMEOUT_MS })).spoken_text
    } catch (error) {
      ctx.deps.log(`[tts] spoken text unavailable: ${str((error as Error).message)}`)
    }
  }
  return spoken.slice(0, SPOKEN_TEXT_MAX_CHARS).trimEnd()
}

export async function handleTts(ctx: RequestContext): Promise<void> {
  let body: Record<string, unknown>
  try { body = await ctx.readJsonBody(64 * 1024) } catch { (await ctx.json({ error: 'invalid request body' }, { status: 400 })); return }
  const raw = str(body.text).trim()
  const rate = prosody(body.rate, '%')
  const pitch = prosody(body.pitch, 'Hz')
  if (rate === null) { (await ctx.json({ error: 'invalid rate' }, { status: 400 })); return }
  if (pitch === null) { (await ctx.json({ error: 'invalid pitch' }, { status: 400 })); return }
  if (!raw) { (await ctx.json({ error: 'text is required' }, { status: 400 })); return }
  if (raw.length > 5000) { (await ctx.json({ error: 'text too long (max 5000 characters)' }, { status: 400 })); return }
  // Python `_client_ip_for_rate_limit`: the peer address, or the forwarded client only behind an opted-in trusted proxy.
  if (ctx.deps.ttsLimiter.limited(rateLimitClientIp(ctx) || 'unknown')) { (await ctx.json({ error: 'rate limit exceeded — please wait' }, { status: 429 })); return }
  const profile = activeProfileName(ctx)
  const home = ctx.deps.profileHome(profile)
  // An unreadable config must not degrade to the public defaults: the operator's endpoint, model, and voice are unknown.
  let config: Record<string, unknown>
  try { config = await ctx.deps.agentConfig.read(home) } catch (error) {
    ctx.deps.log(`[tts] config.yaml unavailable: ${str((error as Error).message)}`)
    await ctx.json({ error: 'Agent configuration is unavailable; retry shortly' }, { status: 503 }); return
  }
  const tts = dict(config.tts)
  // A request that names no engine uses the profile's configured `tts.provider`.
  const engine = (str(body.engine).trim() || str(tts.provider).trim()).toLowerCase()
  if (!engine) { (await ctx.json({ error: 'No text-to-speech engine is configured', code: 'tts_unconfigured' }, { status: 503 })); return }
  const text = await spokenText(ctx, raw)
  if (!text) { (await ctx.json({ error: 'text has nothing to speak' }, { status: 400 })); return }
  const sidecar = ctx.deps.sidecar()
  if (!sidecar) {
    await ctx.json({ error: 'Speech synthesis is unavailable on this server', condition: 'sidecar_unavailable' }, { status: 503 }); return
  }
  try {
    const result = await sidecar.call('tts.synthesize', {
      profile_home: home, text, provider: engine,
      ...(rate ? { speed: Math.max(0.5, Math.min(2, 1 + Number.parseFloat(rate) / 100)) } : {}),
    }, { timeoutMs: TTS_TIMEOUT_MS })
    const contentType = TTS_CONTENT_TYPES.get(result.format)
    if (!contentType || result.audio_b64.length > Math.ceil(TTS_MAX_AUDIO_BYTES / 3) * 4) throw new Error('unsupported or oversized audio')
    const audio = Buffer.from(result.audio_b64, 'base64')
    if (!audio.length || audio.length > TTS_MAX_AUDIO_BYTES) throw new Error('empty or oversized audio')
    await ctx.send({ status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' }, body: audio, security: true })
  } catch (error) {
    ctx.deps.log(`[tts] synthesis failed: ${str((error as Error).message)}`)
    if (error instanceof SidecarError) {
      if (error.code === RPC_ERROR_CODES.invalidParams) {
        await ctx.json({ error: `unknown TTS engine ${engine}` }, { status: 400 }); return
      }
      if (error.condition !== 'tts_failed') {
        await ctx.json({ error: 'Speech synthesis is unavailable on this server', condition: error.condition }, { status: 503 }); return
      }
    }
    await ctx.json({ error: 'Text-to-speech generation failed' }, { status: 502 })
  }
}

/** Public sink: always 204, rate limited per client, payload logged. */
export async function handleCspReport(ctx: RequestContext): Promise<void> {
  const peer = ctx.peer || 'unknown'
  if (ctx.deps.cspLimiter.limited(peer)) {
    ctx.deps.log(`[csp-report] dropped report from ${peer}: rate limit exceeded`)
    await ctx.send({ status: 204, body: '' })
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
  await ctx.send({ status: 204, body: '' })
}
