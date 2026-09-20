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
    if (error.condition === 'not_found') throw new HttpFailure(404, error.message)
    if (error.condition === 'invalid_params' || error.code === -32602) throw new HttpFailure(400, error.message)
    if (error.condition === 'refused' || error.condition === 'conflict') throw new HttpFailure(409, error.message)
    throw new HttpFailure(400, error.message)
  }
  throw error
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
    return this.sidecar().call('kanban.board', { profile_home: home, board: str(q.board).trim() || null, tenant: str(q.tenant).trim() || null, assignee: str(q.assignee).trim() || null, include_archived: truthyQuery(q.include_archived), only_mine: truthyQuery(q.only_mine), since, profile: activeProfile || 'default' }).catch(kanbanFailure)
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
