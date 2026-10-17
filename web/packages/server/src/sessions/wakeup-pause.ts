/**
 * TAL-576 (Python `process_wakeup_pause`): a wakeup turn that fails with `credential_pool_empty` pauses automatic
 * wakeups for its session until the profile's credential state or the session's provider changes, or a turn succeeds.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DocumentBackend } from './storage/backend.js'
import { updateDocument } from './storage/document.js'
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

/**
 * A wakeup held while its session is paused. `process_id` is its delivery identity: the process for a completion or an
 * async delegation, and a per-event key for a watch event (TAL-724), so every reader, an older one too, keeps both a
 * watch match and the exit of one process.
 */
export interface HeldWakeup { process_id: string; wakeup_prompt: string; event?: Record<string, unknown> }

/** A completion (an event with no type is one) or an async delegation is delivered once per process; each watch event is its own (TAL-724). */
export const deliveredPerProcess = (evt: Record<string, unknown> | undefined): boolean => ['completion', 'async_delegation'].includes(str(evt?.type ?? 'completion'))

/** A watch event held before TAL-724 carries its bare process id; its prompt keys it, so the exit held after it is kept. */
export const heldKey = (e: HeldWakeup): string => (deliveredPerProcess(e.event) || e.process_id !== str(e.event?.process_id) ? e.process_id : '') || e.wakeup_prompt
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
  constructor(private readonly documents: DocumentBackend) {}

  private validate(raw: unknown): Record<string, HeldWakeup[]> {
    if (raw === undefined) return {}
    if (!isDict(raw)) throw new Error('Stored held wakeups are not a map')
    for (const [sid, entries] of Object.entries(raw)) {
      if (!Array.isArray(entries) || !entries.every(isHeld)) throw new Error(`Malformed held wakeup for session ${sid}`)
    }
    return raw as Record<string, HeldWakeup[]>
  }

  private async read(): Promise<Record<string, HeldWakeup[]>> { return this.validate((await this.documents.get('held-wakeups', 'held'))?.value) }

  async sessions(): Promise<string[]> { return Object.keys(await this.read()) }
  async get(sid: string): Promise<HeldWakeup[]> { return (await this.read())[sid] ?? [] }

  async hold(sid: string, entries: readonly HeldWakeup[]): Promise<void> {
    await updateDocument(this.documents, 'held-wakeups', 'held', (raw) => {
      const all = this.validate(raw)
      const before = all[sid]?.length ?? 0
      all[sid] = mergeWakeups(all[sid] ?? [], entries)
      return { value: all, result: undefined, skip: all[sid].length === before }
    })
  }

  async release(sid: string, entries?: readonly HeldWakeup[]): Promise<void> {
    await updateDocument(this.documents, 'held-wakeups', 'held', (raw) => {
      const all = this.validate(raw)
      const held = all[sid] ?? []
      const done = new Set((entries ?? held).map(heldKey))
      all[sid] = held.filter((entry) => !done.has(heldKey(entry)))
      for (const key of Object.keys(all)) if (!all[key]!.length) Reflect.deleteProperty(all, key)
      return { value: all, result: undefined, skip: (all[sid]?.length ?? 0) === held.length }
    })
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
