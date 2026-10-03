/**
 * TAL-372: one durable lifecycle for a session's background work: delegated agents (the Agent's ledger), notified or
 * watched processes (the Agent's process registry and completion queue) and `/background` tasks (this server). Each piece
 * of work is one record with a stable id; the server keeps a small receipt per record under
 * `sessions/_background/<sid>.json`, so reloads, restarts and every client read the same history, and reading never
 * consumes anything. The Agent stays authoritative for its own work: a receipt only fills in what it no longer reports.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BackgroundLink, BackgroundTask } from '@maudecode/talaria-web-contracts'
import { atomicWriteText } from '../fs/atomic.js'
import type { SidecarLike } from '../sidecar/client.js'
import { str } from '../util.js'
import { isDict } from './merge.js'
import { isSafeSessionId } from './session.js'

type Dict = Record<string, unknown>
type Status = BackgroundTask['status']
type Kind = BackgroundTask['kind']
type Agents = NonNullable<BackgroundTask['agents']>

/** What the server keeps per record; `result` is the full result text when the Agent will not keep it. */
export interface Receipt {
  task_id: string
  kind: Kind
  status: Status
  title: string
  started_at: number | null
  updated_at: number
  completed_at: number | null
  exit_code: number | null
  agents: Agents | null
  child_session_id: string | null
  result: string | null
  /** The Agent has the full result (a delegation's ledger row). */
  agent_result: boolean
  /** The `/background` turn running it, while it runs. */
  stream_id: string | null
  dismissed_at: number | null
  /** Old clients' `/api/background/status` has returned it once. */
  legacy_reported: boolean
}

export interface DelegationRow { delegation_id: string; state: string; dispatched_at: number | null; completed_at: number | null; updated_at: number | null; goals: string[]; child_statuses: string[]; has_result: boolean; live_status: string | null }
export interface ProcessRow { process_id: string; command: string; started_at: number | null; exited: boolean; exited_at: number | null; exit_code: number | null; completion_reason: string; watched: boolean }

const DIR_NAME = '_background'
const RECORD_LIMIT = 200
const RESULT_LIMIT = 64_000
const TITLE_LIMIT = 160
const TERMINAL: ReadonlySet<Status> = new Set(['completed', 'failed', 'cancelled'])
const LIVE: ReadonlySet<Status> = new Set(['running', 'attention', 'unknown'])
const CHILD_DONE = new Set(['completed', 'success'])
const CHILD_CANCELLED = new Set(['interrupted', 'cancelled'])

export function isTerminal(status: Status): boolean { return TERMINAL.has(status) }

/** One line, never output: the goal, command or prompt a record is about. */
export function taskTitle(text: unknown): string {
  const first = str(text).split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return first.length <= TITLE_LIMIT ? first : `${first.slice(0, TITLE_LIMIT)}…`
}

function bounded(text: string): string { return text.length <= RESULT_LIMIT ? text : `${text.slice(0, RESULT_LIMIT)}\n…(truncated)` }

/** Subagent counts of a delegation unit: finished children by outcome, the rest still running. */
export function agentCounts(total: number, childStatuses: string[], running: boolean): Agents {
  const completed = childStatuses.filter((s) => CHILD_DONE.has(s)).length
  const failed = childStatuses.filter((s) => s && !CHILD_DONE.has(s)).length
  const n = Math.max(total, childStatuses.length, 1)
  return { total: n, completed, failed, running: running ? Math.max(0, n - completed - failed) : 0 }
}

/** A finished unit's status from its children: all cancelled is cancelled, none done is failed, else completed. */
function unitStatus(state: string, childStatuses: string[]): Status {
  if (CHILD_CANCELLED.has(state) || (childStatuses.length && childStatuses.every((s) => CHILD_CANCELLED.has(s)))) return 'cancelled'
  if (childStatuses.length) return childStatuses.some((s) => CHILD_DONE.has(s)) ? 'completed' : 'failed'
  return CHILD_DONE.has(state) ? 'completed' : 'failed'
}

/** The record a ledger row describes; a live `stalling`/`stalled` unit needs attention. */
export function delegationReceipt(row: DelegationRow, now: number): Partial<Receipt> & Pick<Receipt, 'task_id' | 'kind'> {
  const running = ['running', 'stalling', 'finalizing'].includes(row.state)
  const status: Status = running ? (row.live_status === 'stalling' || row.live_status === 'stalled' || row.state === 'stalling' ? 'attention' : 'running') : unitStatus(row.state, row.child_statuses)
  const goals = row.goals.filter(Boolean)
  return {
    task_id: row.delegation_id, kind: 'delegation', status, title: taskTitle(goals.length > 1 ? `${goals.length} subagents: ${goals.join('; ')}` : goals[0]),
    started_at: row.dispatched_at, completed_at: running ? null : row.completed_at ?? row.updated_at ?? now,
    agents: agentCounts(goals.length, running ? [] : row.child_statuses, running), agent_result: row.has_result,
  }
}

/** A notified or watched process as the registry reports it: killed is cancelled, a non-zero exit failed. */
export function processReceipt(row: ProcessRow): Partial<Receipt> & Pick<Receipt, 'task_id' | 'kind'> {
  const exit = row.exit_code ?? null
  const status: Status = !row.exited ? 'running' : row.completion_reason === 'killed' ? 'cancelled' : exit !== null && exit !== 0 ? 'failed' : 'completed'
  return { task_id: row.process_id, kind: 'process', status, title: taskTitle(row.command), started_at: row.started_at, completed_at: row.exited ? row.exited_at : null, exit_code: exit }
}

/** The record one drained completion event settles, with the full result text when the Agent does not keep it. */
export function eventReceipt(evt: Dict, prompt: string, now: number): (Partial<Receipt> & Pick<Receipt, 'task_id' | 'kind'>) | null {
  const type = str(evt.type ?? 'completion')
  const id = str(evt.process_id).trim()
  if (!id) return null
  if (type === 'async_delegation') {
    const goals = Array.isArray(evt.goals) ? evt.goals.map(str) : []
    const results = Array.isArray(evt.results) ? evt.results.filter(isDict) : []
    // A split unit's results index the call's goals; a whole call or a single task is all of them.
    const unitGoals = results.length && results.every((r) => typeof r.task_index === 'number') ? results.map((r) => goals[Number(r.task_index)] ?? str(r.goal)) : goals.length ? goals : [str(evt.goal)]
    const childStatuses = results.length ? results.map((r) => str(r.status)) : [str(evt.status)]
    return { ...delegationReceipt({ delegation_id: id, state: str(evt.status) || 'completed', dispatched_at: Number(evt.dispatched_at) || null, completed_at: Number(evt.completed_at) || now, updated_at: now, goals: unitGoals, child_statuses: childStatuses, has_result: true, live_status: null }, now), result: prompt ? bounded(prompt) : null }
  }
  if (type === 'completion') {
    return { ...processReceipt({ process_id: id, command: str(evt.command), started_at: null, exited: true, exited_at: now, exit_code: evt.exit_code === undefined || evt.exit_code === null ? null : Number(evt.exit_code), completion_reason: str(evt.completion_reason) || 'exited', watched: false }), result: prompt ? bounded(prompt) : null }
  }
  // A watch match (or watch notice) on a process that keeps running.
  return { task_id: id, kind: 'process', status: 'attention', title: taskTitle(evt.command), result: prompt ? bounded(prompt) : null }
}

/** Fold an update into a receipt: a terminal record never reopens, and fields an update leaves out are kept. */
export function mergeReceipt(prev: Receipt | undefined, next: Partial<Receipt> & Pick<Receipt, 'task_id' | 'kind'>, now: number): Receipt {
  const base: Receipt = prev ?? { task_id: next.task_id, kind: next.kind, status: 'running', title: '', started_at: null, updated_at: now, completed_at: null, exit_code: null, agents: null, child_session_id: null, result: null, agent_result: false, stream_id: null, dismissed_at: null, legacy_reported: false }
  const defined = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<Receipt>
  if (isTerminal(base.status)) {
    // Settled once: later reports may add detail (the full result, counts) but never change the outcome.
    return { ...base, result: base.result ?? defined.result ?? null, agent_result: base.agent_result || Boolean(defined.agent_result), agents: base.agents ?? defined.agents ?? null, updated_at: base.updated_at }
  }
  const merged: Receipt = { ...base, ...defined, task_id: base.task_id, kind: base.kind, updated_at: now }
  if (isTerminal(merged.status)) { merged.completed_at = merged.completed_at ?? now; merged.stream_id = null }
  return merged
}

function sameReceipt(a: Receipt | undefined, b: Receipt): boolean {
  if (!a) return false
  return JSON.stringify({ ...a, updated_at: 0 }) === JSON.stringify({ ...b, updated_at: 0 })
}

/** The record every client sees; `live` overrides the status of running work the Agent did not confirm. */
export function taskView(r: Receipt, opts: { unconfirmed?: boolean } = {}): BackgroundTask {
  const status: Status = opts.unconfirmed && LIVE.has(r.status) ? 'unknown' : r.status
  return {
    task_id: r.task_id, kind: r.kind, status, title: r.title, started_at: r.started_at, updated_at: r.updated_at, completed_at: r.completed_at,
    result_available: isTerminal(r.status) || r.status === 'attention' ? Boolean(r.result) || r.agent_result : false,
    child_session_id: r.child_session_id, exit_code: r.exit_code, agents: r.agents,
    pinned: LIVE.has(status) || (r.kind === 'background_command' && isTerminal(r.status) && r.dismissed_at === null),
  }
}

/** The receipts of every session, one small file each, cached after the first read. */
export class BackgroundTaskStore {
  private readonly cache = new Map<string, Receipt[]>()

  constructor(private readonly sessionDir: string, private readonly now: () => number, private readonly onChange?: (sid: string) => void) {}

  private path(sid: string): string { return join(this.sessionDir, DIR_NAME, `${sid}.json`) }

  list(sid: string): Receipt[] {
    if (!isSafeSessionId(sid)) return []
    const cached = this.cache.get(sid)
    if (cached) return cached
    let receipts: Receipt[] = []
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path(sid), 'utf8'))
      // ponytail: receipts are trusted as this server wrote them; validate per field if the file ever comes from elsewhere.
      if (isDict(parsed) && Array.isArray(parsed.tasks)) receipts = parsed.tasks.filter(isDict) as unknown as Receipt[]
    } catch { receipts = [] }
    this.cache.set(sid, receipts)
    return receipts
  }

  get(sid: string, taskId: string): Receipt | undefined { return this.list(sid).find((r) => r.task_id === taskId) }

  /** Apply updates; writes and notifies only when something a client sees changed. */
  update(sid: string, updates: (Partial<Receipt> & Pick<Receipt, 'task_id' | 'kind'>)[], opts: { notify?: boolean } = {}): boolean {
    if (!isSafeSessionId(sid) || !updates.length) return false
    const now = this.now()
    const receipts = [...this.list(sid)]
    let changed = false
    for (const update of updates) {
      const index = receipts.findIndex((r) => r.task_id === update.task_id)
      const merged = mergeReceipt(index >= 0 ? receipts[index] : undefined, update, now)
      if (sameReceipt(receipts[index], merged)) continue
      if (index >= 0) receipts[index] = merged
      else receipts.push(merged)
      changed = true
    }
    if (!changed) return false
    this.write(sid, receipts)
    if (opts.notify !== false) this.onChange?.(sid)
    return true
  }

  /** Flags that are not task state: dismissal, the legacy status read. */
  mark(sid: string, taskId: string, fields: Partial<Pick<Receipt, 'dismissed_at' | 'legacy_reported' | 'stream_id'>>): Receipt | null {
    const receipts = [...this.list(sid)]
    const index = receipts.findIndex((r) => r.task_id === taskId)
    if (index < 0) return null
    receipts[index] = { ...receipts[index]!, ...fields }
    this.write(sid, receipts)
    if (fields.dismissed_at !== undefined) this.onChange?.(sid)
    return receipts[index]
  }

  /** Drop a `/background` task that never started. */
  forget(sid: string, taskId: string): void {
    const receipts = this.list(sid).filter((r) => r.task_id !== taskId)
    this.write(sid, receipts)
  }

  private write(sid: string, receipts: Receipt[]): void {
    // Newest RECORD_LIMIT by start; running work is never pruned.
    const kept = receipts.length <= RECORD_LIMIT ? receipts : [...receipts.filter((r) => !isTerminal(r.status)), ...receipts.filter((r) => isTerminal(r.status)).sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0)).slice(0, RECORD_LIMIT)]
    this.cache.set(sid, kept)
    mkdirSync(join(this.sessionDir, DIR_NAME), { recursive: true })
    atomicWriteText(this.path(sid), JSON.stringify({ version: 1, tasks: kept }))
  }
}

/** Delegation ids a `delegate_task` result names: the call's id (split units extend it as `<id>-<n>`) and any unit ids. */
export function dispatchedDelegationIds(result: unknown): string[] {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '')
  if (!/"status"\s*:\s*"dispatched"/.test(text)) return []
  return [...new Set([...text.matchAll(/"delegation_id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!))]
}

/** The link a delegation tool row shows: its units' records, one combined status, and summed subagent counts. */
export function backgroundLink(ids: string[], receipts: Receipt[]): BackgroundLink | null {
  const linked = receipts.filter((r) => r.kind === 'delegation' && ids.some((id) => r.task_id === id || r.task_id.startsWith(`${id}-`)))
  if (!linked.length) return null
  const agents = linked.reduce<Agents>((sum, r) => {
    const a = r.agents ?? { total: 1, completed: 0, failed: 0, running: isTerminal(r.status) ? 0 : 1 }
    return { total: sum.total + a.total, completed: sum.completed + a.completed, failed: sum.failed + a.failed, running: sum.running + a.running }
  }, { total: 0, completed: 0, failed: 0, running: 0 })
  const statuses = new Set(linked.map((r) => r.status))
  const status: Status = statuses.has('attention') ? 'attention' : statuses.has('running') ? 'running' : statuses.has('unknown') ? 'unknown'
    : statuses.size === 1 ? linked[0]!.status : statuses.has('completed') ? 'completed' : 'failed'
  return { task_ids: linked.map((r) => r.task_id), status, agents }
}

/** Stamps `tool.background` on delegation rows of every turn's scene. Returns copies; stored rows are untouched. */
export function withBackgroundLinks<T>(messages: T[], receipts: Receipt[]): T[] {
  if (!receipts.some((r) => r.kind === 'delegation')) return messages
  return messages.map((m) => {
    if (!isDict(m) || !isDict(m._anchor_activity_scene) || !Array.isArray(m._anchor_activity_scene.activity_rows)) return m
    let touched = false
    const rows = m._anchor_activity_scene.activity_rows.map((row: unknown) => {
      if (!isDict(row) || !isDict(row.tool) || str(row.tool.name) !== 'delegate_task') return row
      const link = backgroundLink(dispatchedDelegationIds(row.tool.result ?? row.tool.preview), receipts)
      if (!link) return row
      touched = true
      return { ...row, tool: { ...row.tool, background: link } }
    })
    return touched ? { ...m, _anchor_activity_scene: { ...m._anchor_activity_scene, activity_rows: rows } } : m
  })
}

export interface BackgroundActivityDeps {
  store: BackgroundTaskStore
  sidecar: () => SidecarLike | null
  profileHome: (profile: string | null) => string
  /** The stream is still running in this server. */
  liveStream: (streamId: string) => boolean
  now: () => number
  log: (line: string) => void
}

/** The session-facing side: `/background` bookkeeping, drained completions, and the snapshot every client reads. */
export class BackgroundActivity {
  constructor(private readonly deps: BackgroundActivityDeps) {}

  receipts(sid: string): Receipt[] { return this.deps.store.list(sid) }

  trackCommand(sid: string, taskId: string, prompt: string): void {
    this.deps.store.update(sid, [{ task_id: taskId, kind: 'background_command', status: 'running', title: taskTitle(prompt), started_at: this.deps.now() }])
  }

  setCommandStream(sid: string, taskId: string, streamId: string): void { this.deps.store.mark(sid, taskId, { stream_id: streamId || null }) }

  /** The `/background` turn finished: its answer, or the failure text old clients showed, is the result. */
  settleCommand(sid: string, taskId: string, outcome: 'completed' | 'failed', text: string): void {
    this.deps.store.update(sid, [{ task_id: taskId, kind: 'background_command', status: outcome, result: bounded(text) }])
  }

  forgetCommand(sid: string, taskId: string): void { this.deps.store.forget(sid, taskId) }

  /** A drained completion settles (or flags) its record. */
  recordEvent(sid: string, evt: Dict, prompt: string): void {
    const receipt = eventReceipt(evt, prompt, this.deps.now())
    if (receipt) this.deps.store.update(sid, [receipt])
  }

  /** The session's records, refreshed from the Agent; work it cannot confirm right now shows `unknown`. */
  async snapshot(sid: string, profile: string | null): Promise<{ tasks: BackgroundTask[]; agent_available: boolean }> {
    const sidecar = this.deps.sidecar()
    let agent: { delegations: DelegationRow[]; processes: ProcessRow[] } | null = null
    if (sidecar) {
      try { agent = await sidecar.call('process.background_list', { profile_home: this.deps.profileHome(profile), session_ids: [sid] }) } catch (error) { this.deps.log(`[webui] WARNING: background tasks for ${sid} unavailable from the Agent: ${(error as Error).message}`) }
    }
    const now = this.deps.now()
    if (agent) this.deps.store.update(sid, [...agent.delegations.map((r) => delegationReceipt(r, now)), ...agent.processes.map(processReceipt)])
    const liveDelegations = new Set((agent?.delegations ?? []).map((r) => r.delegation_id))
    const liveProcesses = new Set((agent?.processes ?? []).filter((p) => !p.exited).map((p) => p.process_id))
    const confirmed = (r: Receipt): boolean => r.kind === 'background_command' ? Boolean(r.stream_id) && this.deps.liveStream(r.stream_id!)
      : r.kind === 'delegation' ? liveDelegations.has(r.task_id) : liveProcesses.has(r.task_id)
    const tasks = this.deps.store.list(sid).map((r) => taskView(r, { unconfirmed: !confirmed(r) }))
    tasks.sort((a, b) => (b.started_at ?? b.updated_at) - (a.started_at ?? a.updated_at))
    return { tasks, agent_available: agent !== null }
  }

  /** The full result: kept here for `/background` and drained completions, else the Agent's ledger for a delegation. */
  async result(sid: string, profile: string | null, taskId: string): Promise<string | null> {
    const receipt = this.deps.store.get(sid, taskId)
    if (!receipt) return null
    if (receipt.result) return receipt.result
    const sidecar = this.deps.sidecar()
    if (receipt.kind !== 'delegation' || !receipt.agent_result || !sidecar) return null
    try { return (await sidecar.call('process.delegation_result', { profile_home: this.deps.profileHome(profile), session_id: sid, delegation_id: taskId })).text || null } catch { return null }
  }

  /** Dismissal is read state, separate from the task: the record stays in the history and leaves the tray. */
  dismiss(sid: string, taskId: string): BackgroundTask | null {
    const receipt = this.deps.store.mark(sid, taskId, { dismissed_at: this.deps.now() })
    return receipt ? taskView(receipt) : null
  }

  /**
   * Old clients' `/api/background/status`: each finished `/background` result once per server, as before. The record and
   * its result stay; the shared `tasks` view is not affected.
   */
  legacyResults(sid: string): Record<string, unknown>[] {
    const done = this.deps.store.list(sid).filter((r) => r.kind === 'background_command' && isTerminal(r.status) && !r.legacy_reported)
    for (const r of done) this.deps.store.mark(sid, r.task_id, { legacy_reported: true })
    return done.map((r) => ({ task_id: r.task_id, prompt: r.title, answer: r.result, completed_at: r.completed_at }))
  }
}

