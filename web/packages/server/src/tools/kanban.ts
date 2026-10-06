/** Kanban HTTP shapes over the sidecar `kanban.*` namespace (Python `api/kanban_bridge.py`). */
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
 * the gates mirror the Agent's `kanban_db` transitions (`block_task` takes running/ready, `complete_task` running/ready/blocked,
 * `unblock_task` blocked), so a client never offers a write the Agent refuses. `running` is reachable only through the dispatcher. */
const MOVE_TARGETS: Record<string, string[]> = {
  triage: ['todo', 'ready'], todo: ['triage', 'ready'], ready: ['triage', 'todo'], running: ['triage', 'todo', 'ready'],
  // Ready from blocked is Unblock, which re-gates on parents.
  blocked: ['triage', 'todo'], done: ['triage', 'todo', 'ready'], archived: ['triage', 'todo', 'ready'],
}
/** Every board column except `running`; the sidecar applies each row through the same transitions. */
export const KANBAN_BULK_MOVE_TARGETS = ['triage', 'todo', 'ready', 'blocked', 'done']

export type KanbanTaskActions = { block: boolean; unblock: boolean; complete: boolean; archive: boolean; move_to: string[] }

/** The card actions offered for `status`; an unknown status offers none. */
export function kanbanTaskActions(status: unknown): KanbanTaskActions {
  const s = str(status)
  const known = s in MOVE_TARGETS
  return {
    block: s === 'ready' || s === 'running',
    unblock: s === 'blocked',
    complete: s === 'ready' || s === 'running' || s === 'blocked',
    archive: known && s !== 'archived',
    move_to: [...(MOVE_TARGETS[s] ?? [])],
  }
}

/** One task with its server-owned card policy. */
export function withTaskPolicy(task: unknown): unknown {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return task
  const t = task as Dict
  return { ...t, available_actions: kanbanTaskActions(t.status), requires_running_exit_confirmation: str(t.status) === 'running' }
}

/** Adds the card policy to a payload's `task` and `columns[].tasks`; anything else passes through. */
export function withKanbanPolicy<T>(payload: T): T {
  const p = payload as Dict
  if (!p || typeof p !== 'object' || Array.isArray(p)) return payload
  const out: Dict = { ...p }
  if ('task' in p) out.task = withTaskPolicy(p.task)
  if (Array.isArray(p.columns)) out.columns = p.columns.map((c: unknown) => (c && typeof c === 'object' && Array.isArray((c as Dict).tasks) ? { ...(c as Dict), tasks: ((c as Dict).tasks as unknown[]).map(withTaskPolicy) } : c))
  return out as T
}

export class KanbanService {
  constructor(private readonly deps: { sidecar: () => SidecarLike | null; config: AgentConfig }) {}

  sidecar(): SidecarLike {
    const s = this.deps.sidecar()
    if (!s) throw new HttpFailure(503, 'kanban unavailable: Hermes Agent sidecar is not running')
    return s
  }

  board(home: string, q: { board?: string | undefined; tenant?: string | undefined; assignee?: string | undefined; include_archived?: string | undefined; only_mine?: string | undefined; since?: string | undefined }, activeProfile: string): Promise<Dict> {
    const since = intQuery(q.since, null, 0)
    return this.sidecar().call('kanban.board', { profile_home: home, board: str(q.board).trim() || null, tenant: str(q.tenant).trim() || null, assignee: str(q.assignee).trim() || null, include_archived: truthyQuery(q.include_archived), only_mine: truthyQuery(q.only_mine), since, profile: activeProfile || 'default' }).then((board) => ({ ...withKanbanPolicy(board), bulk_move_targets: [...KANBAN_BULK_MOVE_TARGETS] }), kanbanFailure)
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
