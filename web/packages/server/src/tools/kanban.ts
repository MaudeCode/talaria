/** Kanban HTTP shapes over the sidecar `kanban.*` namespace (Python `api/kanban_bridge.py`). */
import { createHash } from 'node:crypto'
import type { SidecarLike } from '../sidecar/client.js'
import { SidecarError } from '../sidecar/client.js'
import type { AgentConfig, Dict } from '../config/agent-config.js'
import { dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { str } from '../util.js'
import type { SettingsStore } from '../settings.js'

export const truthyQuery = (v: unknown): boolean => ['1', 'true', 'yes', 'on'].includes(str(v).trim().toLowerCase())

export function intQuery(raw: unknown, fallback: number | null, min?: number, max?: number): number | null {
  const text = str(raw).trim()
  if (!text) return fallback
  const n = Number.parseInt(text, 10)
  if (!Number.isFinite(n)) return fallback
  let v = n
  if (min !== undefined) v = Math.max(min, v)
  if (max !== undefined) v = Math.min(max, v)
  return v
}

/** Sidecar `InvalidParams` → 400, `not_found` → 404, `RuntimeError`-class refusals → 409 (Python dispatcher mapping). */
export function kanbanFailure(error: unknown): never {
  if (error instanceof HttpFailure) throw error
  if (error instanceof SidecarError) {
    if (error.condition === 'sidecar_unavailable') throw new HttpFailure(503, `kanban unavailable: ${error.message}`)
    // Python: `ImportError` (hermes_cli missing) → 503 with the text.
    if (error.condition === 'kanban_unavailable') throw new HttpFailure(503, error.message)
    if (error.condition === 'not_found') throw new HttpFailure(404, error.message)
    if (error.condition === 'invalid_params' || error.code === -32602) throw new HttpFailure(400, error.message)
    if (error.condition === 'refused' || error.condition === 'conflict') throw new HttpFailure(409, error.message)
    if (error.condition === 'kanban_error') throw new HttpFailure(400, error.message)
    // Anything else (sqlite errors, sidecar timeouts) escaped the Python handlers to the dispatcher's opaque 500.
    throw new HttpFailure(500, 'Internal server error')
  }
  // `resolveTrusted` and friends raise plain errors Python reported as 400 `ValueError`s.
  if (error instanceof Error) throw new HttpFailure(400, error.message)
  throw error
}

/** Where a Move may take a task, by its current status (TAL-557): Talaria's policy, narrowed further by the Agent's manual move
 * table (TAL-796). Block, Unblock, Complete, and Archive are separate actions; the gates mirror the Agent's `kanban_db` transitions
 * (`block_task` takes running/ready, `complete_task` running/ready/blocked with stored evidence or review as an approval,
 * `unblock_task` blocked), so a client never offers a write the Agent refuses. `running` is reachable only through the dispatcher,
 * `scheduled` and `review` only through Agent verbs that need a wake time or a reviewer. */
const MOVE_TARGETS: Record<string, string[]> = {
  // Ready from scheduled is the Agent's unblock, which re-gates on parents.
  triage: ['todo', 'ready'], todo: ['triage', 'ready'], scheduled: ['triage', 'todo', 'ready'], ready: ['triage', 'todo'], running: ['triage', 'todo', 'ready'],
  // Ready from blocked is Unblock, which re-gates on parents. Ready from review is the Agent's reopen; the sidecar refuses todo,
  // where that reopen would land in ready anyway.
  blocked: ['triage', 'todo'], review: ['ready'], done: ['triage', 'todo', 'ready'], archived: ['triage', 'todo', 'ready'],
}
/** Every board column except `running`; the sidecar applies each row through the same transitions. */
export const KANBAN_BULK_MOVE_TARGETS = ['triage', 'todo', 'ready', 'blocked', 'done']
/** Where a new task may start: a fresh task carries no result for Complete, and `running`, `scheduled` and `review` need Agent verbs. */
export const KANBAN_CREATE_STATUSES = ['triage', 'todo', 'ready', 'blocked']

export interface KanbanTaskActions { block: boolean; unblock: boolean; complete: boolean; archive: boolean; move_to: string[] }

/** The card actions offered for a sidecar task; an unknown status offers none. */
export function kanbanTaskActions(task: Dict): KanbanTaskActions {
  const s = str(task.status)
  // Block and a direct status change release a live worker's claim without stopping it, and the Agent refuses to complete
  // under a live claim, so such a card offers only Archive, which terminates the worker. Unknown liveness counts as live.
  const live = s === 'running' && task.claim_live !== false
  // The Agent's manual moves from this status; only an Agent before 0.21.6 (`null`) leaves Talaria's policy alone.
  const agent = task.agent_move_targets === null ? null : Array.isArray(task.agent_move_targets) ? task.agent_move_targets : []
  return {
    block: !live && (s === 'ready' || s === 'running'),
    unblock: s === 'blocked',
    complete: !live && (s === 'review' || (task.has_completion_evidence === true && (s === 'ready' || s === 'running' || s === 'blocked'))),
    archive: s in MOVE_TARGETS && s !== 'archived',
    move_to: live ? [] : (MOVE_TARGETS[s] ?? []).filter((t) => !agent || agent.includes(t)),
  }
}

/** One task with its server-owned card policy; the Agent's move table it was computed from stays on the server. */
export function withTaskPolicy(task: unknown): unknown {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return task
  const t: Dict = { ...(task as Dict) }
  const available_actions = kanbanTaskActions(t)
  delete t.agent_move_targets
  return { ...t, available_actions, requires_running_exit_confirmation: str(t.status) === 'running' }
}

/** Agent event kinds a Block or Unblock writes (`block_task` routes a block to `blocked`, or to `triage`/`todo` with its own kind). */
const CARD_ACTION_EVENTS: Record<string, 'block' | 'unblock'> = { blocked: 'block', block_loop_detected: 'block', dependency_wait: 'block', unblocked: 'unblock' }

/** The newest Block or Unblock recorded in a task's events, so a client can confirm its own write landed (TAL-557). */
export function lastCardAction(events: unknown[]): { action: 'block' | 'unblock'; event_id: number } | null {
  let last: { action: 'block' | 'unblock'; event_id: number } | null = null
  for (const e of events) {
    const event = e && typeof e === 'object' ? (e as Dict) : {}
    const action = CARD_ACTION_EVENTS[str(event.kind)]
    if (action && typeof event.id === 'number' && (!last || event.id > last.event_id)) last = { action, event_id: event.id }
  }
  return last
}

/** Shared card policy for tasks, board columns, details and the bounded inspection projection. */
export function withKanbanPolicy<T>(payload: T): T {
  const p = payload as Dict
  if (!p || typeof p !== 'object' || Array.isArray(p)) return payload
  const out: Dict = { ...p }
  if (Array.isArray(p.nodes) && Array.isArray(p.edges)) return inspectionProjection(p) as T
  if ('task' in p) out.task = withTaskPolicy(p.task)
  if ('task' in p && Array.isArray(p.events)) out.last_card_action = lastCardAction(p.events as unknown[])
  if (Array.isArray(p.columns)) out.columns = p.columns.map((c: unknown) => (c && typeof c === 'object' && Array.isArray((c as Dict).tasks) ? { ...(c as Dict), tasks: ((c as Dict).tasks as unknown[]).map(withTaskPolicy) } : c))
  return out as T
}

/**
 * Every node's reachable set over `adj`, holding the node itself only on a cycle. Tarjan's strongly connected components
 * finish successors first, so each component's set is built once from its successors' sets.
 */
function reachability(ids: string[], adj: Map<string, string[]>): Map<string, Set<string>> {
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>(), stack: string[] = []
  const reach = new Map<string, Set<string>>()
  const open = (id: string): void => { index.set(id, index.size); low.set(id, index.get(id)!); stack.push(id); onStack.add(id) }
  for (const root of ids) {
    if (index.has(root)) continue
    open(root)
    const work: [string, number][] = [[root, 0]]
    while (work.length) {
      const frame = work[work.length - 1]!
      const [v, i] = frame
      const next = adj.get(v) ?? []
      if (i < next.length) {
        frame[1] += 1
        const w = next[i]!
        if (!index.has(w)) { open(w); work.push([w, 0]) } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
        continue
      }
      work.pop()
      const parent = work[work.length - 1]?.[0]
      if (parent !== undefined) low.set(parent, Math.min(low.get(parent)!, low.get(v)!))
      if (low.get(v) !== index.get(v)) continue
      const members = new Set<string>()
      for (let w = stack.pop()!; ; w = stack.pop()!) { onStack.delete(w); members.add(w); if (w === v) break }
      const set = new Set<string>()
      let cycle = members.size > 1
      for (const m of members) for (const w of adj.get(m) ?? []) {
        if (members.has(w)) { cycle = true; continue }
        set.add(w)
        for (const x of reach.get(w)!) set.add(x)
      }
      if (cycle) for (const m of members) set.add(m)
      for (const m of members) reach.set(m, set)
    }
  }
  return reach
}

/** Bounded profile snapshot. Traversal sees only visible nodes, never a hidden bridge. The sidecar applies `search` and `assignee`. */
function inspectionProjection(p: Dict): Dict {
  const filters = dict(p.inspection_filters)
  const visible = (p.nodes as Dict[]).filter(n => {
    const t = dict(n.task)
    return (filters.include_archived === true || t.status !== 'archived') && (!filters.tenant || t.tenant === filters.tenant)
  })
  const nodes = visible.slice(0, 500)
  const ids = new Set(nodes.map(n => str(n.key)))
  const validEdges = (p.edges as Dict[]).filter(e => ids.has(str(e.source)) && ids.has(str(e.target)))
  const edges = validEdges.slice(0, 2000)
  const up = new Map<string, string[]>(), down = new Map<string, string[]>()
  const link = (map: Map<string, string[]>, from: string, to: string): void => { const list = map.get(from); if (list) list.push(to); else map.set(from, [to]) }
  for (const e of edges) { const s = str(e.source), t = str(e.target); link(up, t, s); link(down, s, t) }
  const above = reachability([...ids], up), below = reachability([...ids], down)
  const running = new Set(nodes.filter(n => dict(n.task).status === 'running').map(n => str(n.key)))
  const epoch = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
  const now = epoch(p.generated_at) ?? Date.now() / 1000
  let projected = nodes.map(n => {
    const key = str(n.key), task = dict(n.task), ancestors = new Set(above.get(key)), descendants = new Set(below.get(key))
    const cycle = ancestors.delete(key) || descendants.has(key)
    descendants.delete(key)
    const start = epoch(task.status === 'running' ? task.current_run_started_at : task.started_at)
    const end = epoch(task.completed_at)
    const stop = task.status === 'running' ? now : end
    const duration_seconds = start !== null && stop !== null && stop >= start ? stop - start : null
    return { ...n, key, task: withTaskPolicy(task), ancestors: [...ancestors].sort(), descendants: [...descendants].sort(), cycle, running_lineage: running.has(key) || [...ancestors, ...descendants].some(id => running.has(id)), timing: { start, end, duration_seconds, offset: null as number | null, width: null as number | null } }
  })
  if (filters.running_only === true) projected = projected.filter(n => n.running_lineage)
  projected.sort((a, b) => a.key.localeCompare(b.key))
  const starts = projected.flatMap(n => n.timing.start === null ? [] : [n.timing.start])
  const stops = projected.flatMap(n => n.timing.start === null || n.timing.duration_seconds === null ? [] : [n.timing.start + n.timing.duration_seconds])
  const start = starts.length ? Math.min(...starts) : null
  const end = stops.length ? Math.max(...stops, ...starts) : null
  if (start !== null && end !== null) for (const n of projected) {
    if (n.timing.start !== null && n.timing.duration_seconds !== null) {
      n.timing.offset = (n.timing.start - start) / Math.max(1, end - start)
      n.timing.width = n.timing.duration_seconds / Math.max(1, end - start)
    }
  }
  const kept = new Set(projected.map(n => n.key))
  for (const n of projected) { n.ancestors = n.ancestors.filter(id => kept.has(id)); n.descendants = n.descendants.filter(id => kept.has(id)) }
  const rest = { ...p }
  delete rest.inspection_filters
  return { ...rest, nodes: projected, edges: edges.filter(e => kept.has(str(e.source)) && kept.has(str(e.target))), window: { start, end }, truncated: p.truncated === true || visible.length > 500 || validEdges.length > 2000 }
}

interface Column { name: string; tasks: Dict[] }

/** Columns keeping only the tasks whose id, title, body (or description/prompt), assignee or tenant contains `query` (case-insensitive). */
export function searchColumns(columns: Column[], query: string): Column[] {
  const q = query.trim().toLowerCase()
  if (!q) return columns
  return columns.map((c) => ({ ...c, tasks: c.tasks.filter((t) => [t.id, t.title, t.body, t.description, t.prompt, t.assignee, t.tenant].some((v) => typeof v === 'string' && v.toLowerCase().includes(q))) }))
}

/** One lane per assignee in name order, unassigned (`null`) last, each holding every column; never empty. */
export function profileLanes(columns: Column[]): { assignee: string | null; count: number; columns: Column[] }[] {
  const key = (t: Dict): string | null => str(t.assignee).trim() || null
  const named = [...new Set(columns.flatMap((c) => c.tasks.map(key)).filter((a): a is string => a !== null))].sort((a, b) => a.localeCompare(b))
  // With no tasks at all, one empty unassigned lane still carries the columns and their empty states.
  const keys: (string | null)[] = columns.some((c) => c.tasks.some((t) => key(t) === null)) || named.length === 0 ? [...named, null] : named
  return keys.map((assignee) => {
    const laneColumns = columns.map((c) => ({ ...c, tasks: c.tasks.filter((t) => key(t) === assignee) }))
    return { assignee, count: laneColumns.reduce((n, c) => n + c.tasks.length, 0), columns: laneColumns }
  })
}

/** Stats with the total and the per-status counts in the Agent's board-column order (the sidecar's `column_order`), unknown statuses after by name. */
export function withStatsTotals(stats: Dict): Dict {
  const { column_order, ...rest } = stats
  const order = Array.isArray(column_order) ? column_order.map(str) : []
  const byStatus = dict(rest.by_status) as Record<string, unknown>
  const rank = (s: string) => { const i = order.indexOf(s); return i === -1 ? order.length : i }
  const status_counts = Object.entries(byStatus).map(([status, n]) => ({ status, count: Number(n) || 0 })).sort((a, b) => rank(a.status) - rank(b.status) || a.status.localeCompare(b.status))
  return { ...rest, by_status: byStatus, total: status_counts.reduce((n, c) => n + c.count, 0), status_counts }
}

/** A board slug from a display name, within the Agent's `^[a-z0-9][a-z0-9\-_]{0,63}$`. A name with no ASCII letters or digits
 * gets `board-` and a hash of the name, so it is valid and stable; an empty name stays empty for the Agent to refuse. */
export function boardSlug(name: string): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')
  if (ascii || !name.trim()) return ascii
  return `board-${createHash('sha256').update(name.trim()).digest('hex').slice(0, 8)}`
}

const KANBAN_POLL_MS = 1_000
const KANBAN_POLL_MAX_MS = 5_000
/** Empty pages before an idle board's poll starts doubling its interval. */
const KANBAN_IDLE_PAGES = 5

export interface KanbanEventBatch { events: unknown[]; cursor: number }

/** One event stream's place on a shared board poll: its own cursor and at most one undelivered batch. */
export class KanbanSubscription {
  private pending: KanbanEventBatch | null = null
  private wake: (() => void) | null = null

  constructor(public cursor: number, readonly close: () => void) {}

  get busy(): boolean { return this.pending !== null }

  deliver(batch: KanbanEventBatch): void {
    this.pending = batch
    this.cursor = batch.cursor
    this.wake?.()
  }

  /** The next batch, or null after `ms` or the abort. */
  async next(ms: number, signal: AbortSignal): Promise<KanbanEventBatch | null> {
    if (!this.pending && ms > 0 && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); this.wake = null; resolve() }
        const timer = setTimeout(done, ms)
        this.wake = done
        signal.addEventListener('abort', done, { once: true })
      })
    }
    const batch = this.pending
    this.pending = null
    return batch
  }
}

/**
 * One `kanban.events` poll per board for every open stream on it: streams at the same cursor share one read, so a stream
 * replaying history never holds back one already at the head. After five empty polls the interval doubles up to 5 s; any
 * event resets it.
 */
class KanbanBoardPoll {
  readonly subscribers = new Set<KanbanSubscription>()
  private interval = KANBAN_POLL_MS
  private empty = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private due = 0
  private polling = false

  constructor(private readonly read: (since: number) => Promise<Dict>, private readonly stopped: () => void) {}

  join(sub: KanbanSubscription): void {
    this.subscribers.add(sub)
    // A new stream waits at most one base interval for its first page.
    this.interval = KANBAN_POLL_MS
    this.empty = 0
    if (this.polling) return
    if (this.timer === null) this.schedule(0)
    else if (this.due - Date.now() > KANBAN_POLL_MS) this.schedule(KANBAN_POLL_MS)
  }

  leave(sub: KanbanSubscription): void {
    if (!this.subscribers.delete(sub) || this.subscribers.size) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.stopped()
  }

  private schedule(ms: number): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.due = Date.now() + ms
    this.timer = setTimeout(() => { void this.poll() }, ms)
  }

  private async poll(): Promise<void> {
    this.timer = null
    this.polling = true
    // A stream still writing its last batch is skipped and keeps its cursor, so a slow reader never holds back the rest.
    const byCursor = new Map<number, KanbanSubscription[]>()
    for (const sub of this.subscribers) {
      if (sub.busy) continue
      const group = byCursor.get(sub.cursor)
      if (group) group.push(sub); else byCursor.set(sub.cursor, [sub])
    }
    let fresh: boolean | null = null
    if (byCursor.size) {
      const pages = await Promise.all([...byCursor].map(async ([since, group]) => {
        let events: unknown[] = []
        let cursor = since
        try {
          const page = await this.read(since)
          events = Array.isArray(page.events) ? page.events : []
          cursor = Number(page.cursor) || since
        } catch { events = [] }
        if (events.length) for (const sub of group) if (this.subscribers.has(sub)) sub.deliver({ events, cursor })
        return events.length > 0
      }))
      fresh = pages.includes(true)
    }
    this.polling = false
    if (!this.subscribers.size) return
    if (fresh) { this.interval = KANBAN_POLL_MS; this.empty = 0 }
    else if (fresh === false && ++this.empty >= KANBAN_IDLE_PAGES) this.interval = Math.min(KANBAN_POLL_MAX_MS, this.interval * 2)
    this.schedule(this.interval)
  }
}

export class KanbanService {
  private readonly polls = new Map<string, KanbanBoardPoll>()

  constructor(private readonly deps: { sidecar: () => SidecarLike | null; config: AgentConfig; settings: SettingsStore }) {}

  /** A stream's place on the board's shared event poll, which starts with the first stream and stops with the last. */
  subscribe(home: string, board: string | null, cursor: number): KanbanSubscription {
    const key = JSON.stringify([home, board])
    let poll = this.polls.get(key)
    if (!poll) {
      const created = new KanbanBoardPoll((since) => this.events(home, board, since, 200), () => { if (this.polls.get(key) === created) this.polls.delete(key) })
      this.polls.set(key, created)
      poll = created
    }
    const owner = poll
    const sub: KanbanSubscription = new KanbanSubscription(cursor, () => { owner.leave(sub) })
    owner.join(sub)
    return sub
  }

  sidecar(): SidecarLike {
    const s = this.deps.sidecar()
    if (!s) throw new HttpFailure(503, 'kanban unavailable: Hermes Agent sidecar is not running')
    return s
  }

  async boards(home: string, profile: string, includeArchived: boolean): Promise<Dict> {
    const result = await this.sidecar().call('kanban.boards', { profile_home: home, include_archived: includeArchived }).catch(kanbanFailure)
    const active = new Set(result.boards.filter(b => !b.archived).map(b => b.slug))
    const pinned = (await this.deps.settings.kanbanPins(profile)).filter(slug => active.has(slug))
    return { ...result, boards: result.boards.map(b => ({ ...b, removable: b.slug !== 'default' && !b.archived })), pinned }
  }

  async inspection(home: string, q: { board?: string | undefined; search?: string | undefined; assignee?: string | undefined; tenant?: string | undefined; only_mine?: string | undefined; include_archived?: string | undefined; running_only?: string | undefined }, activeProfile: string): Promise<Dict> {
    // Only mine filters by the active profile, so it replaces any chosen assignee.
    const assignee = truthyQuery(q.only_mine) ? activeProfile || 'default' : str(q.assignee).trim() || null
    const snapshot = await this.sidecar().call('kanban.inspection', { profile_home: home, board: str(q.board).trim() || null, include_archived: truthyQuery(q.include_archived), search: str(q.search).trim() || null, assignee }).catch(kanbanFailure)
    return withKanbanPolicy({ ...snapshot, inspection_filters: { tenant: str(q.tenant), include_archived: truthyQuery(q.include_archived), running_only: truthyQuery(q.running_only) } })
  }

  async board(home: string, q: { board?: string | undefined; tenant?: string | undefined; assignee?: string | undefined; include_archived?: string | undefined; only_mine?: string | undefined; since?: string | undefined; search?: string | undefined }, activeProfile: string): Promise<Dict> {
    const since = intQuery(q.since, null, 0)
    // Only mine filters by the active profile, so it replaces any chosen assignee.
    const onlyMine = truthyQuery(q.only_mine)
    const board = await this.sidecar().call('kanban.board', { profile_home: home, board: str(q.board).trim() || null, tenant: str(q.tenant).trim() || null, assignee: onlyMine ? null : str(q.assignee).trim() || null, include_archived: truthyQuery(q.include_archived), only_mine: onlyMine, since, profile: activeProfile || 'default' }).catch(kanbanFailure)
    const lane_by_profile = await this.laneByProfile(home)
    const out: Dict = { ...withKanbanPolicy(board), bulk_move_targets: [...KANBAN_BULK_MOVE_TARGETS], create_statuses: [...KANBAN_CREATE_STATUSES], lane_by_profile }
    if (!Array.isArray(out.columns)) return out
    out.columns = searchColumns(out.columns as Column[], str(q.search))
    if (lane_by_profile) out.lanes = profileLanes(out.columns as Column[])
    return out
  }

  /** `dashboard.kanban.lane_by_profile`, defaulting to lanes like the Agent's own `kanban.config`; an unreadable config keeps that default. */
  private async laneByProfile(home: string): Promise<boolean> {
    const config = await this.deps.config.read(home).catch(() => ({}))
    return dict(dict(dict(config).dashboard).kanban).lane_by_profile !== false
  }

  events(home: string, board: string | null, since: unknown, limit: unknown): Promise<Dict> {
    return this.sidecar().call('kanban.events', { profile_home: home, board, since: intQuery(since, 0, 0) ?? 0, limit: intQuery(limit, 200, 1, 200) ?? 200 }).catch(kanbanFailure)
  }

  async updateConfig(home: string, body: Dict): Promise<Dict> {
    if (!('lane_by_profile' in body)) throw new HttpFailure(400, 'lane_by_profile is required')
    if (typeof body.lane_by_profile !== 'boolean') throw new HttpFailure(400, 'lane_by_profile must be boolean')
    const lane = body.lane_by_profile
    await this.deps.config.update(home, (c) => {
      const dashboard = dict(c.dashboard)
      dashboard.kanban = { ...dict(dashboard.kanban), lane_by_profile: lane }
      c.dashboard = dashboard
    })
    const payload = await this.sidecar().call('kanban.config', { profile_home: home, board: null }).catch(kanbanFailure)
    return { ...payload, lane_by_profile: lane }
  }
}
