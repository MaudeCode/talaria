/** Kanban HTTP shapes over the sidecar `kanban.*` namespace (Python `api/kanban_bridge.py`). */
import { createHash } from 'node:crypto'
import type { SidecarLike } from '../sidecar/client.js'
import { SidecarError } from '../sidecar/client.js'
import type { AgentConfig, Dict } from '../config/agent-config.js'
import { dict } from '../config/agent-config.js'
import { HttpFailure } from '../sessions/service.js'
import { str } from '../util.js'

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

/** Where a Move may take a task, by its current status (TAL-557). Block, Unblock, Complete, and Archive are separate actions;
 * the gates mirror the Agent's `kanban_db` transitions (`block_task` takes running/ready, `complete_task` running/ready/blocked
 * with stored evidence, `unblock_task` blocked), so a client never offers a write the Agent refuses. `running` is reachable only
 * through the dispatcher. */
const MOVE_TARGETS: Record<string, string[]> = {
  triage: ['todo', 'ready'], todo: ['triage', 'ready'], ready: ['triage', 'todo'], running: ['triage', 'todo', 'ready'],
  // Ready from blocked is Unblock, which re-gates on parents.
  blocked: ['triage', 'todo'], done: ['triage', 'todo', 'ready'], archived: ['triage', 'todo', 'ready'],
}
/** Every board column except `running`; the sidecar applies each row through the same transitions. */
export const KANBAN_BULK_MOVE_TARGETS = ['triage', 'todo', 'ready', 'blocked', 'done']

export interface KanbanTaskActions { block: boolean; unblock: boolean; complete: boolean; archive: boolean; move_to: string[] }

/** The card actions offered for a sidecar task; an unknown status offers none. */
export function kanbanTaskActions(task: Dict): KanbanTaskActions {
  const s = str(task.status)
  // Block and a direct status change release a live worker's claim without stopping it, and the Agent refuses to complete
  // under a live claim, so such a card offers only Archive, which terminates the worker. Unknown liveness counts as live.
  const live = s === 'running' && task.claim_live !== false
  return {
    block: !live && (s === 'ready' || s === 'running'),
    unblock: s === 'blocked',
    complete: !live && task.has_completion_evidence === true && (s === 'ready' || s === 'running' || s === 'blocked'),
    archive: s in MOVE_TARGETS && s !== 'archived',
    move_to: live ? [] : [...(MOVE_TARGETS[s] ?? [])],
  }
}

/** One task with its server-owned card policy. */
export function withTaskPolicy(task: unknown): unknown {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return task
  const t = task as Dict
  return { ...t, available_actions: kanbanTaskActions(t), requires_running_exit_confirmation: str(t.status) === 'running' }
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

/** Adds the card policy to a payload's `task` and `columns[].tasks`, and a detail's `last_card_action`; anything else passes through. */
export function withKanbanPolicy<T>(payload: T): T {
  const p = payload as Dict
  if (!p || typeof p !== 'object' || Array.isArray(p)) return payload
  const out: Dict = { ...p }
  if ('task' in p) out.task = withTaskPolicy(p.task)
  if ('task' in p && Array.isArray(p.events)) out.last_card_action = lastCardAction(p.events as unknown[])
  if (Array.isArray(p.columns)) out.columns = p.columns.map((c: unknown) => (c && typeof c === 'object' && Array.isArray((c as Dict).tasks) ? { ...(c as Dict), tasks: ((c as Dict).tasks as unknown[]).map(withTaskPolicy) } : c))
  return out as T
}

/** The Agent's board columns (`kanban_db.BOARD_COLUMNS`), the order stats and lanes follow. */
const BOARD_COLUMNS = ['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived']

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

/** Stats with the total and the per-status counts in board-column order, unknown statuses after by name. */
export function withStatsTotals(stats: Dict): Dict {
  const byStatus = dict(stats.by_status) as Record<string, unknown>
  const rank = (s: string) => { const i = BOARD_COLUMNS.indexOf(s); return i === -1 ? BOARD_COLUMNS.length : i }
  const status_counts = Object.entries(byStatus).map(([status, n]) => ({ status, count: Number(n) || 0 })).sort((a, b) => rank(a.status) - rank(b.status) || a.status.localeCompare(b.status))
  return { ...stats, by_status: byStatus, total: status_counts.reduce((n, c) => n + c.count, 0), status_counts }
}

/** A board slug from a display name, within the Agent's `^[a-z0-9][a-z0-9\-_]{0,63}$`. A name with no ASCII letters or digits
 * gets `board-` and a hash of the name, so it is valid and stable; an empty name stays empty for the Agent to refuse. */
export function boardSlug(name: string): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')
  if (ascii || !name.trim()) return ascii
  return `board-${createHash('sha256').update(name.trim()).digest('hex').slice(0, 8)}`
}

export class KanbanService {
  constructor(private readonly deps: { sidecar: () => SidecarLike | null; config: AgentConfig }) {}

  sidecar(): SidecarLike {
    const s = this.deps.sidecar()
    if (!s) throw new HttpFailure(503, 'kanban unavailable: Hermes Agent sidecar is not running')
    return s
  }

  async board(home: string, q: { board?: string | undefined; tenant?: string | undefined; assignee?: string | undefined; include_archived?: string | undefined; only_mine?: string | undefined; since?: string | undefined; search?: string | undefined }, activeProfile: string): Promise<Dict> {
    const since = intQuery(q.since, null, 0)
    // Only mine filters by the active profile, so it replaces any chosen assignee.
    const onlyMine = truthyQuery(q.only_mine)
    const board = await this.sidecar().call('kanban.board', { profile_home: home, board: str(q.board).trim() || null, tenant: str(q.tenant).trim() || null, assignee: onlyMine ? null : str(q.assignee).trim() || null, include_archived: truthyQuery(q.include_archived), only_mine: onlyMine, since, profile: activeProfile || 'default' }).catch(kanbanFailure)
    const lane_by_profile = await this.laneByProfile(home)
    const out: Dict = { ...withKanbanPolicy(board), bulk_move_targets: [...KANBAN_BULK_MOVE_TARGETS], lane_by_profile }
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
