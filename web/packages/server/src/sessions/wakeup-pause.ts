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

const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes(str((error as NodeJS.ErrnoException).code))

/**
 * Python `process_wakeup_credential_state_fingerprint`: auth.json by content shape, the authoritative config file
 * (`AgentConfig.path`, which honours `HERMES_CONFIG_PATH`) and `.env` by stat. Throws when any of them cannot be read:
 * unknown credential state is never a change.
 */
export function credentialStateFingerprint(profileHome: string, configPath = join(profileHome, 'config.yaml')): string {
  const stamp = (path: string): string => { try { const st = statSync(path, { bigint: true }); return `${String(st.mtimeNs)}:${String(st.size)}` } catch (error) { if (missing(error)) return 'missing'; throw error } }
  let text: string | null = null
  try { text = readFileSync(join(profileHome, 'auth.json'), 'utf8') } catch (error) { if (!missing(error)) throw error }
  const auth = text === null ? 'missing' : JSON.stringify(authShape(JSON.parse(text)))
  return createHash('sha256').update(JSON.stringify([auth, stamp(configPath), stamp(join(profileHome, '.env'))])).digest('hex')
}

/**
 * `provider` is the session's own (a switch lifts the pause); `pool_provider` is whose pool ran dry: the provider the
 * Agent resolved for the turn, which a session on the config's implicit provider does not name. Unreadable credential
 * state records no fingerprint, so the first readable one lifts the pause.
 */
export function recordWakeupPause(s: Session, profileHome: string, now: number, runtimeProvider: string, configPath?: string): void {
  const provider = s.model_provider ?? ''
  let fingerprint = ''
  try { fingerprint = credentialStateFingerprint(profileHome, configPath) } catch { /* recorded as unknown */ }
  s.process_wakeup_pause = { paused: true, source: 'process_wakeup', classification: 'credential_pool_empty', provider, pool_provider: runtimeProvider.trim() || provider, paused_at: now, credential_state_fingerprint: fingerprint }
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

  /** Only a missing file is empty: any other read or parse failure throws, so no write replaces what it could not read. */
  private read(): Record<string, HeldWakeup[]> {
    let text: string
    try { text = readFileSync(this.path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
    const raw = JSON.parse(text) as unknown
    if (!isDict(raw)) throw new Error(`${this.path} is not a held wakeup map`)
    const out: Record<string, HeldWakeup[]> = {}
    for (const [sid, entries] of Object.entries(raw)) if (Array.isArray(entries)) out[sid] = entries.filter(isHeld)
    return out
  }

  /** Throws when the file cannot be written. */
  private write(all: Record<string, HeldWakeup[]>): void {
    for (const sid of Object.keys(all)) if (!all[sid]!.length) Reflect.deleteProperty(all, sid)
    atomicWriteText(this.path, JSON.stringify(all))
  }

  /** Throws when the file cannot be read. */
  sessions(): string[] { return Object.keys(this.read()) }

  /** Throws when the file cannot be read. */
  get(sid: string): HeldWakeup[] { return this.read()[sid] ?? [] }

  /** Throws when the file cannot be read or written. */
  hold(sid: string, entries: readonly HeldWakeup[]): void {
    const all = this.read()
    const before = all[sid]?.length ?? 0
    all[sid] = mergeWakeups(all[sid] ?? [], entries)
    if (all[sid].length !== before) this.write(all)
  }

  /** Drops delivered entries, or the whole session with no entries given; throws when the file cannot be read or written. */
  release(sid: string, entries?: readonly HeldWakeup[]): void {
    const all = this.read()
    const held = all[sid]
    if (!held) return
    const done = new Set((entries ?? held).map(heldKey))
    all[sid] = held.filter((e) => !done.has(heldKey(e)))
    if (all[sid].length !== held.length) this.write(all)
  }
}

/**
 * Whether the session's wakeups stay paused; a pause whose provider or credential state changed is cleared (the caller
 * saves). Credential state that cannot be read keeps the pause.
 */
export function wakeupPaused(s: Session, profileHome: string, configPath?: string): boolean {
  const pause = s.process_wakeup_pause
  if (!isDict(pause) || pause.paused !== true) return false
  let changed = str(pause.provider) !== (s.model_provider ?? '')
  if (!changed) { try { changed = str(pause.credential_state_fingerprint) !== credentialStateFingerprint(profileHome, configPath) } catch { return true } }
  if (!changed) return true
  s.process_wakeup_pause = null
  return false
}
