/**
 * TAL-576 (Python `process_wakeup_pause`): a wakeup turn that fails with `credential_pool_empty` pauses automatic
 * wakeups for its session until the profile's credential state or the session's provider changes, or a turn succeeds.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from './session.js'
import { isDict } from './merge.js'
import { str } from '../util.js'

/** Fields the Agent rewrites on token refresh or per-request telemetry; they never mean a credential was added. */
const ROTATION_KEYS = new Set(['expires_at', 'expires_at_ms', 'expires_in', 'last_status', 'last_status_at', 'last_error_code', 'last_error_reason', 'last_error_message', 'last_error_reset_at', 'request_count', 'updated_at'])
/** Secrets enter the fingerprint only as presence, so a rotated token is no change and no secret is hashed. */
const SECRET_KEYS = new Set(['access_token', 'refresh_token', 'id_token', 'api_key', 'secret', 'client_secret', 'runtime_api_key', 'token'])

function authShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(authShape)
  if (!isDict(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const norm = key.trim().toLowerCase()
    if (ROTATION_KEYS.has(norm)) continue
    out[key] = SECRET_KEYS.has(norm) ? Boolean(str(value[key]).trim()) : authShape(value[key])
  }
  return out
}

/** Python `process_wakeup_credential_state_fingerprint`: auth.json by content shape, config.yaml and `.env` by stat. */
export function credentialStateFingerprint(profileHome: string): string {
  const stamp = (name: string): string => { try { const st = statSync(join(profileHome, name), { bigint: true }); return `${String(st.mtimeNs)}:${String(st.size)}` } catch { return 'missing' } }
  let auth: string
  try { auth = JSON.stringify(authShape(JSON.parse(readFileSync(join(profileHome, 'auth.json'), 'utf8')))) } catch { auth = stamp('auth.json') }
  return createHash('sha256').update(JSON.stringify([auth, stamp('config.yaml'), stamp('config.yml'), stamp('.env')])).digest('hex')
}

export function recordWakeupPause(s: Session, profileHome: string, now: number): void {
  s.process_wakeup_pause = { paused: true, source: 'process_wakeup', classification: 'credential_pool_empty', provider: s.model_provider ?? '', paused_at: now, credential_state_fingerprint: credentialStateFingerprint(profileHome) }
}

/** Whether the session's wakeups stay paused; a pause whose provider or credential state changed is cleared (the caller saves). */
export function wakeupPaused(s: Session, profileHome: string): boolean {
  const pause = s.process_wakeup_pause
  if (!isDict(pause) || pause.paused !== true) return false
  if (str(pause.provider) === (s.model_provider ?? '') && str(pause.credential_state_fingerprint) === credentialStateFingerprint(profileHome)) return true
  s.process_wakeup_pause = null
  return false
}
