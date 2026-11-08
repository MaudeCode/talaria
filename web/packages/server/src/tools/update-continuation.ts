/**
 * TAL-1990: the local chats an Update anyway interrupted continue once Talaria Web is back. Before anything is replaced,
 * the update records each saved chat under the state dir; the server that next owns them (the restarted one on the
 * target revision, or the same one when the install failed) starts one `update_continuation` turn per entry. Each entry
 * is removed before its turn starts, so a crash mid-resume never replays a turn blind.
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteText } from '../fs/atomic.js'
import { turnTerminalState, withTurnIds } from '../sessions/anchor.js'
import type { Session } from '../sessions/session.js'
import { str } from '../util.js'

export const UPDATE_CONTINUATION_PROMPT = 'Continue where you left off.'
export const UPDATE_CONTINUATION_SOURCE = 'update_continuation'
const RECORD_FILE = 'update-continuation.json'

/** One interrupted chat: its session, profile and the interrupted turn (its stream id). */
export interface ContinuationRun { session_id: string; profile: string | null; stream_id: string }
export interface ContinuationRecord { update_id: string; target_revision: string; target_version: string; runs: ContinuationRun[] }

const recordPath = (stateDir: string): string => join(stateDir, RECORD_FILE)

export function writeContinuation(stateDir: string, record: ContinuationRecord): void {
  atomicWriteText(recordPath(stateDir), JSON.stringify(record))
}

/** The pending record; null when there is none or it is unreadable (an unreadable record is removed, never guessed at). */
export function readContinuation(stateDir: string): ContinuationRecord | null {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(recordPath(stateDir), 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') clearContinuation(stateDir)
    return null
  }
  const r = raw as Partial<ContinuationRecord> | null
  if (!r || !Array.isArray(r.runs)) { clearContinuation(stateDir); return null }
  const runs = r.runs.filter((run): run is ContinuationRun => Boolean(run) && typeof run.session_id === 'string' && typeof run.stream_id === 'string')
  return { update_id: str(r.update_id), target_revision: str(r.target_revision), target_version: str(r.target_version), runs: runs.map((run) => ({ ...run, profile: typeof run.profile === 'string' ? run.profile : null })) }
}

export function clearContinuation(stateDir: string): void {
  rmSync(recordPath(stateDir), { force: true })
}

/** Claims one entry: the record without it is written (or removed when empty) before its turn may start. Throws on failure. */
export function claimContinuation(stateDir: string, streamId: string): void {
  const record = readContinuation(stateDir)
  if (!record) return
  const runs = record.runs.filter((run) => run.stream_id !== streamId)
  if (runs.length) writeContinuation(stateDir, { ...record, runs })
  else clearContinuation(stateDir)
}

export interface ContinueChatDeps {
  /** Throws an `HttpFailure` while the Agent runtime cannot take a turn (`ensureAgentRuntimeCurrent`). */
  ensureRuntime: () => Promise<void>
  /** The session, or null when it no longer exists. */
  session: (sessionId: string) => Promise<Session | null>
  readOnlyReason: (session: Session) => Promise<string | null>
  startTurn: (session: Session) => Promise<{ _status?: number; error?: string }>
  log: (line: string) => void
}

/**
 * Continues one recorded chat. `claim` removes its entry first, also for a chat that is skipped (deleted, read-only, with
 * a newer turn than the interrupted one, or whose turn finished on its own before the interrupt). False, with the entry
 * kept, while the Agent runtime is not ready.
 */
export async function continueChat(run: ContinuationRun, claim: () => void, deps: ContinueChatDeps): Promise<boolean> {
  try { await deps.ensureRuntime() } catch { return false }
  const skip = (reason: string): true => {
    claim()
    deps.log(`[updates] not continuing chat ${run.session_id} after the update: ${reason}`)
    return true
  }
  const session = await deps.session(run.session_id)
  if (!session) return skip('it was deleted')
  if (await deps.readOnlyReason(session)) return skip('it is read-only')
  if (session.active_stream_id || str(withTurnIds(session.messages).at(-1)?._turn_id) !== run.stream_id) return skip('it has a newer turn')
  if (turnTerminalState(session.messages, run.stream_id) !== 'interrupted') return skip('its turn finished before the update stopped it')
  claim()
  const started = await deps.startTurn(session)
  if (started._status !== undefined) deps.log(`[updates] could not continue chat ${run.session_id} after the update: ${str(started.error)}`)
  else deps.log(`[updates] continuing chat ${run.session_id} after the update`)
  return true
}
