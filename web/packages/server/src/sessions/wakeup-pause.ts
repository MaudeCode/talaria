/**
 * TAL-576 (Python `process_wakeup_pause`): a wakeup turn that fails with `credential_pool_empty` pauses automatic
 * wakeups for its session until the profile's credential state or the session's provider changes, or a turn succeeds.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteText } from '../fs/atomic.js'
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

/** The pool's state for a paused session: `true` once an entry is usable, else the earliest retry deadline (epoch s), else null. */
export function poolRecovery(entries: readonly { status: string; retry_after: string | null }[], now: number): true | number | null {
  let earliest: number | null = null
  for (const entry of entries) {
    if (entry.status === 'available') return true
    const at = entry.retry_after ? Date.parse(entry.retry_after) / 1000 : NaN
    if (Number.isFinite(at)) earliest = Math.min(earliest ?? at, at)
  }
  return earliest !== null && earliest <= now ? true : earliest
}

/** A wakeup held while its session is paused. */
export interface HeldWakeup { process_id: string; wakeup_prompt: string; event?: Record<string, unknown> }

const heldKey = (e: HeldWakeup): string => e.process_id || e.wakeup_prompt
const isHeld = (e: unknown): e is HeldWakeup => isDict(e) && typeof e.wakeup_prompt === 'string' && typeof e.process_id === 'string'

/** Adds entries not held yet, so held and in-memory copies of one wakeup merge into one. */
export function mergeWakeups(into: HeldWakeup[], entries: readonly HeldWakeup[]): HeldWakeup[] {
  const keys = new Set(into.map(heldKey))
  for (const entry of entries) if (!keys.has(heldKey(entry))) { keys.add(heldKey(entry)); into.push(entry) }
  return into
}

/**
 * Held wakeups by session in one atomically written file: holding one is a single durable write, it leaves only once a
 * turn admits it, and a restarted server finds every one.
 */
export class HeldWakeups {
  constructor(private readonly path: string) {}

  private read(): Record<string, HeldWakeup[]> {
    let raw: unknown
    try { raw = JSON.parse(readFileSync(this.path, 'utf8')) } catch { return {} }
    if (!isDict(raw)) return {}
    const out: Record<string, HeldWakeup[]> = {}
    for (const [sid, entries] of Object.entries(raw)) if (Array.isArray(entries)) out[sid] = entries.filter(isHeld)
    return out
  }

  /** Throws when the file cannot be written. */
  private write(all: Record<string, HeldWakeup[]>): void {
    for (const sid of Object.keys(all)) if (!all[sid]!.length) Reflect.deleteProperty(all, sid)
    atomicWriteText(this.path, JSON.stringify(all))
  }

  sessions(): string[] { return Object.keys(this.read()) }

  get(sid: string): HeldWakeup[] { return this.read()[sid] ?? [] }

  /** Throws when the entries could not be written. */
  hold(sid: string, entries: readonly HeldWakeup[]): void {
    const all = this.read()
    const before = all[sid]?.length ?? 0
    all[sid] = mergeWakeups(all[sid] ?? [], entries)
    if (all[sid].length !== before) this.write(all)
  }

  /** Drops delivered entries, or the whole session with no entries given; throws when the file cannot be written. */
  release(sid: string, entries?: readonly HeldWakeup[]): void {
    const all = this.read()
    const held = all[sid]
    if (!held) return
    const done = new Set((entries ?? held).map(heldKey))
    all[sid] = held.filter((e) => !done.has(heldKey(e)))
    if (all[sid].length !== held.length) this.write(all)
  }
}

/** Whether the session's wakeups stay paused; a pause whose provider or credential state changed is cleared (the caller saves). */
export function wakeupPaused(s: Session, profileHome: string): boolean {
  const pause = s.process_wakeup_pause
  if (!isDict(pause) || pause.paused !== true) return false
  if (str(pause.provider) === (s.model_provider ?? '') && str(pause.credential_state_fingerprint) === credentialStateFingerprint(profileHome)) return true
  s.process_wakeup_pause = null
  return false
}
