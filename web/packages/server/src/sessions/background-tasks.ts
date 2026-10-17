/**
 * TAL-372: one durable lifecycle for a session's background work: delegated agents (the Agent's ledger), notified or
 * watched processes (the Agent's process registry and completion queue) and `/background` tasks (this server). Each piece
 * of work is one record with a stable id; the server keeps a small receipt per record under
 * `sessions/_background/<sid>.json`, so reloads, restarts and every client read the same history, and reading never
 * consumes anything. The Agent stays authoritative for its own work: a receipt only fills in what it no longer reports.
 */
import type { BackgroundLink, BackgroundTask } from '@maudecode/talaria-web-contracts'
import type { DocumentBackend } from './storage/backend.js'
import { updateDocument } from './storage/document.js'
import type { SidecarLike } from '../sidecar/client.js'
import { str } from '../util.js'
import { isDict, stripToolCallXml } from './merge.js'
import { isSafeSessionId } from './session.js'
import { backgroundEventKind } from './background-events.js'

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
  /** TAL-494: the subagent sessions a delegation ran, kept once seen (the Agent forgets a child's id when it ends). */
  children?: ChildSession[]
  result: string | null
  /** The Agent has the full result (a delegation's ledger row). */
  agent_result: boolean
  /** The `/background` turn running it, while it runs. */
  stream_id: string | null
  dismissed_at: number | null
}

export interface ChildSession { goal: string; session_id: string }
export interface DelegationRow { delegation_id: string; state: string; dispatched_at: number | null; completed_at: number | null; updated_at: number | null; goals: string[]; child_statuses: string[]; has_result: boolean; live_status: string | null; children?: ChildSession[] | undefined }
export interface ProcessRow { process_id: string; command: string; started_at: number | null; exited: boolean; exited_at: number | null; exit_code: number | null; completion_reason: string; watched: boolean }

const RECORD_LIMIT = 200
const RESULT_LIMIT = 64_000
const TITLE_LIMIT = 160
const TERMINAL: ReadonlySet<Status> = new Set(['completed', 'failed', 'cancelled'])
const LIVE: ReadonlySet<Status> = new Set(['running', 'attention', 'unknown'])
const CHILD_DONE = new Set(['completed', 'success'])
const RUNNING_STATES: ReadonlySet<string> = new Set(['running', 'stalling', 'finalizing'])
const RUNNING_LIKE: ReadonlySet<Status> = new Set(['running', 'attention'])
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
  const running = RUNNING_STATES.has(row.state)
  const status: Status = running ? (row.live_status === 'stalling' || row.live_status === 'stalled' || row.state === 'stalling' ? 'attention' : 'running') : unitStatus(row.state, row.child_statuses)
  const goals = row.goals.filter(Boolean)
  return {
    task_id: row.delegation_id, kind: 'delegation', status, title: taskTitle(goals.length > 1 ? `${goals.length} subagents: ${goals.join('; ')}` : goals[0]),
    started_at: row.dispatched_at, completed_at: running ? null : row.completed_at ?? row.updated_at ?? now,
    agents: agentCounts(goals.length, running ? [] : row.child_statuses, running), agent_result: row.has_result,
    ...(row.children?.length ? { children: row.children } : {}),
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
  const kind = backgroundEventKind(evt)
  const id = str(evt.process_id).trim()
  if (!id) return null
  if (kind === 'delegation') {
    const goals = Array.isArray(evt.goals) ? evt.goals.map(str) : []
    const results = Array.isArray(evt.results) ? evt.results.filter(isDict) : []
    // A split unit's results index the call's goals; a whole call or a single task is all of them.
    const unitGoals = results.length && results.every((r) => typeof r.task_index === 'number') ? results.map((r) => goals[Number(r.task_index)] ?? str(r.goal)) : goals.length ? goals : [str(evt.goal)]
    const childStatuses = results.length ? results.map((r) => str(r.status)) : [str(evt.status)]
    return { ...delegationReceipt({ delegation_id: id, state: str(evt.status) || 'completed', dispatched_at: Number(evt.dispatched_at) || null, completed_at: Number(evt.completed_at) || now, updated_at: now, goals: unitGoals, child_statuses: childStatuses, has_result: true, live_status: null }, now), result: prompt ? bounded(prompt) : null }
  }
  if (kind === 'completion') {
    return { ...processReceipt({ process_id: id, command: str(evt.command), started_at: null, exited: true, exited_at: now, exit_code: evt.exit_code === undefined || evt.exit_code === null ? null : Number(evt.exit_code), completion_reason: str(evt.completion_reason) || 'exited', watched: false }), result: prompt ? bounded(prompt) : null }
  }
  if (kind === 'progress') return { task_id: id, kind: 'process', status: 'running', title: taskTitle(evt.command), started_at: typeof evt.started_at === 'number' ? evt.started_at : null, result: bounded(str(evt.output)) || null }
  // A watch match (or watch notice) on a process that keeps running.
  return { task_id: id, kind: 'process', status: 'attention', title: taskTitle(evt.command), result: prompt ? bounded(prompt) : null }
}

/** Children seen so far plus newly reported ones, by session id, first-seen order. */
function mergeChildren(known: ChildSession[] | undefined, reported: ChildSession[] | undefined): ChildSession[] {
  const out = [...(known ?? [])]
  for (const c of reported ?? []) if (!out.some((k) => k.session_id === c.session_id)) out.push(c)
  return out
}

/** Fold an update into a receipt: a terminal record never reopens, and fields an update leaves out are kept. */
export function mergeReceipt(prev: Receipt | undefined, next: Partial<Receipt> & Pick<Receipt, 'task_id' | 'kind'>, now: number): Receipt {
  const base: Receipt = prev ?? { task_id: next.task_id, kind: next.kind, status: 'running', title: '', started_at: null, updated_at: now, completed_at: null, exit_code: null, agents: null, result: null, agent_result: false, stream_id: null, dismissed_at: null }
  const defined = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<Receipt>
  const children = mergeChildren(base.children, defined.children)
  if (isTerminal(base.status)) {
    // Settled once: later reports may add detail (the full result, counts, child sessions) but never change the outcome.
    return { ...base, result: base.result ?? defined.result ?? null, agent_result: base.agent_result || Boolean(defined.agent_result), agents: base.agents ?? defined.agents ?? null, ...(children.length ? { children } : {}), updated_at: base.updated_at }
  }
  // A running report must preserve both a watch alert and the matched output explaining it until the process ends.
  if (base.kind === 'process' && base.status === 'attention' && defined.status === 'running') {
    delete defined.status
    delete defined.result
  }
  const merged: Receipt = { ...base, ...defined, task_id: base.task_id, kind: base.kind, ...(children.length ? { children } : {}), updated_at: now }
  if (isTerminal(merged.status)) { merged.completed_at = merged.completed_at ?? now; merged.stream_id = null }
  return merged
}

function sameReceipt(a: Receipt | undefined, b: Receipt): boolean {
  if (!a) return false
  return JSON.stringify({ ...a, updated_at: 0 }) === JSON.stringify({ ...b, updated_at: 0 })
}

function dismissible(r: Receipt, status: Status): boolean {
  return status === 'unknown' || (r.kind === 'background_command' && isTerminal(r.status))
}

/** The record every client sees; `unconfirmed` shows running work the Agent did not confirm as `unknown`. */
export function taskView(r: Receipt, opts: { unconfirmed?: boolean } = {}): BackgroundTask {
  const status: Status = opts.unconfirmed && LIVE.has(r.status) ? 'unknown' : r.status
  return {
    task_id: r.task_id, kind: r.kind, status, title: r.title, started_at: r.started_at, updated_at: r.updated_at, completed_at: r.completed_at,
    result_available: isTerminal(r.status) || r.status === 'attention' ? Boolean(r.result) || r.agent_result : false,
    child_sessions: (r.children ?? []).filter((c) => isSafeSessionId(c.session_id)).map((c) => ({ goal: c.goal, session_id: c.session_id })), exit_code: r.exit_code, agents: r.agents,
    // Work nobody can confirm (lost in an Agent or server restart) can be dismissed like a finished `/background` result.
    pinned: status === 'running' || status === 'attention' || (dismissible(r, status) && r.dismissed_at === null),
    // Dismissed work nobody can confirm will not settle on its own; clients stop refreshing for it.
    active: LIVE.has(status) && !(status === 'unknown' && r.dismissed_at !== null),
    dismissible: dismissible(r, status) && r.dismissed_at === null,
  }
}

/** The receipts of every session, one small file each, cached after the first read. */
export class BackgroundTaskStore {
  private readonly cache = new Map<string, Receipt[]>()

  constructor(private readonly documents: DocumentBackend, private readonly now: () => number, private readonly onChange?: (sid: string) => void | Promise<void>) {}

  private parse(raw: unknown): Receipt[] { return isDict(raw) && Array.isArray(raw.tasks) ? raw.tasks.filter(isDict) as unknown as Receipt[] : [] }
  private bounded(receipts: Receipt[]): Receipt[] {
    return receipts.length <= RECORD_LIMIT ? receipts : [...receipts.filter((receipt) => !isTerminal(receipt.status)), ...receipts.filter((receipt) => isTerminal(receipt.status)).sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0)).slice(0, RECORD_LIMIT)]
  }

  async list(sid: string): Promise<Receipt[]> {
    if (!isSafeSessionId(sid)) return []
    const cached = this.cache.get(sid)
    if (cached) return cached
    let receipts: Receipt[]
    try { receipts = this.parse((await this.documents.get('background', sid))?.value) } catch { receipts = [] }
    this.cache.set(sid, receipts)
    return receipts
  }

  async get(sid: string, taskId: string): Promise<Receipt | undefined> { return (await this.list(sid)).find((receipt) => receipt.task_id === taskId) }

  private async mutate<T>(sid: string, edit: (receipts: Receipt[]) => T, opts: { skipUnchanged?: boolean } = {}): Promise<T> {
    const committed = await updateDocument(this.documents, 'background', sid, (raw) => {
      const receipts = this.parse(raw)
      const before = JSON.stringify(receipts)
      const result = edit(receipts)
      const tasks = this.bounded(receipts)
      return { value: { version: 1, tasks }, result: { tasks, result }, skip: opts.skipUnchanged === true && before === JSON.stringify(tasks) }
    }, { replaceInvalid: true })
    this.cache.set(sid, committed.tasks)
    return committed.result
  }

  async update(sid: string, updates: (Partial<Receipt> & Pick<Receipt, 'task_id' | 'kind'>)[], opts: { notify?: boolean } = {}): Promise<boolean> {
    if (!isSafeSessionId(sid) || !updates.length) return false
    const now = this.now()
    const changed = await this.mutate(sid, (receipts) => {
      let changed = false
      for (const update of updates) {
        const index = receipts.findIndex((receipt) => receipt.task_id === update.task_id)
        const merged = mergeReceipt(index >= 0 ? receipts[index] : undefined, update, now)
        if (sameReceipt(receipts[index], merged)) continue
        if (index >= 0) receipts[index] = merged
        else receipts.push(merged)
        changed = true
      }
      return changed
    })
    if (changed && opts.notify !== false) void this.onChange?.(sid)
    return changed
  }

  async mark(sid: string, taskId: string, fields: Partial<Pick<Receipt, 'dismissed_at' | 'stream_id'>>): Promise<Receipt | null> {
    const receipt = await this.mutate(sid, (receipts) => {
      const index = receipts.findIndex((receipt) => receipt.task_id === taskId)
      if (index < 0) return null
      receipts[index] = { ...receipts[index]!, ...fields }
      return receipts[index]
    }, { skipUnchanged: true })
    if (receipt && fields.dismissed_at !== undefined) void this.onChange?.(sid)
    return receipt
  }

  evict(sid: string): void { this.cache.delete(sid) }

  async delete(sid: string): Promise<void> {
    this.cache.delete(sid)
    try { await this.documents.delete('background', sid) } catch { /* best effort */ }
  }

  async forget(sid: string, taskId: string): Promise<void> {
    await this.mutate(sid, (receipts) => { const index = receipts.findIndex((receipt) => receipt.task_id === taskId); if (index >= 0) receipts.splice(index, 1) })
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

  async receipts(sid: string): Promise<Receipt[]> { return (await this.deps.store.list(sid)) }

  async trackCommand(sid: string, taskId: string, prompt: string): Promise<void> {
    await this.deps.store.update(sid, [{ task_id: taskId, kind: 'background_command', status: 'running', title: taskTitle(prompt), started_at: this.deps.now() }])
  }

  async setCommandStream(sid: string, taskId: string, streamId: string): Promise<void> { (await this.deps.store.mark(sid, taskId, { stream_id: streamId || null })) }

  /** The `/background` turn finished: its answer, or the failure text old clients showed, is the result. */
  async settleCommand(sid: string, taskId: string, outcome: 'completed' | 'failed', text: string): Promise<void> {
    await this.deps.store.update(sid, [{ task_id: taskId, kind: 'background_command', status: outcome, result: bounded(text) }])
  }

  async forgetCommand(sid: string, taskId: string): Promise<void> { (await this.deps.store.forget(sid, taskId)) }

  /** A drained completion settles (or flags) its record. */
  async recordEvent(sid: string, evt: Dict, prompt: string): Promise<void> {
    const receipt = eventReceipt(evt, prompt, this.deps.now())
    if (receipt) (await this.deps.store.update(sid, [receipt]))
  }

  /** The session's records, refreshed from the Agent; work it cannot confirm right now shows `unknown`. */
  async snapshot(sid: string, profile: string | null): Promise<{ tasks: BackgroundTask[]; agent_available: boolean; agents_working: boolean }> {
    const sidecar = this.deps.sidecar()
    let agent: { delegations: DelegationRow[]; processes: ProcessRow[] } | null = null
    if (sidecar) {
      try { agent = await sidecar.call('process.background_list', { profile_home: this.deps.profileHome(profile), session_ids: [sid] }) } catch (error) { this.deps.log(`[webui] WARNING: background tasks for ${sid} unavailable from the Agent: ${(error as Error).message}`) }
    }
    const now = this.deps.now()
    // A ledger row alone confirms only a settled unit: a running one must still be in the Agent's live registry, else it
    // was lost in an Agent restart.
    const liveDelegations = new Set((agent?.delegations ?? []).filter((r) => r.live_status !== null || !RUNNING_STATES.has(r.state)).map((r) => r.delegation_id))
    const liveProcesses = new Set((agent?.processes ?? []).filter((p) => !p.exited).map((p) => p.process_id))
    const confirmed = (r: Receipt): boolean => r.kind === 'background_command' ? Boolean(r.stream_id) && this.deps.liveStream(r.stream_id!)
      : r.kind === 'delegation' ? liveDelegations.has(r.task_id) : liveProcesses.has(r.task_id)
    if (agent) {
      const reported = [...agent.delegations.map((r) => delegationReceipt(r, now)), ...agent.processes.map(processReceipt)]
      // The Agent answered: running work it no longer has is lost, and its record (the card and the delegation row alike)
      // says unknown until the Agent reports it again.
      const lost = (await this.deps.store.list(sid)).filter((r) => LIVE.has(r.status) && r.status !== 'unknown' && !confirmed(r)).map((r) => ({ task_id: r.task_id, kind: r.kind, status: 'unknown' as const }))
      const reportedIds = new Set(reported.map((r) => r.task_id))
      await this.deps.store.update(sid, [...reported.map((r) => (confirmed(r as Receipt) || !RUNNING_LIKE.has(r.status ?? 'running') ? r : { ...r, status: 'unknown' as const })), ...lost.filter((r) => !reportedIds.has(r.task_id))])
    } else {
      // The Agent cannot be asked: a running delegation's record says unknown too, so its transcript row matches the
      // card; it returns to running once the Agent reports it again.
      await this.deps.store.update(sid, (await this.deps.store.list(sid)).filter((r) => r.kind === 'delegation' && RUNNING_LIKE.has(r.status)).map((r) => ({ task_id: r.task_id, kind: r.kind, status: 'unknown' as const })))
    }
    const tasks = (await this.deps.store.list(sid)).map((r) => taskView(r, { unconfirmed: !agent && !confirmed(r) }))
    tasks.sort((a, b) => (b.started_at ?? b.updated_at) - (a.started_at ?? a.updated_at))
    return { tasks, agent_available: agent !== null, agents_working: tasks.some((t) => t.kind === 'delegation' && (t.status === 'running' || t.status === 'attention')) }
  }

  /**
   * The full result: kept here for `/background` and drained completions, else the Agent's ledger for a delegation.
   * Leaked tool-call XML is removed, as from a transcript reply (TAL-302).
   */
  async result(sid: string, profile: string | null, taskId: string): Promise<string | null> {
    const receipt = (await this.deps.store.get(sid, taskId))
    if (!receipt) return null
    if (receipt.result) return stripToolCallXml(receipt.result)
    const sidecar = this.deps.sidecar()
    if (receipt.kind !== 'delegation' || !receipt.agent_result || !sidecar) return null
    try { return stripToolCallXml((await sidecar.call('process.delegation_result', { profile_home: this.deps.profileHome(profile), session_id: sid, delegation_id: taskId })).text) || null } catch { return null }
  }

  /** Dismissal is read state, separate from the task: the record stays in the history and leaves the tray. */
  async dismiss(sid: string, taskId: string): Promise<BackgroundTask | null> {
    const receipt = (await this.deps.store.mark(sid, taskId, { dismissed_at: this.deps.now() }))
    return receipt ? taskView(receipt) : null
  }
}
