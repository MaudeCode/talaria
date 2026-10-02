/**
 * Sidebar rows for Agent-owned sessions read from `state.db` (Python
 * `models.get_cli_sessions` / `_load_cli_sessions_uncached`): the interactive
 * window plus bounded cron, webhook, and kanban passes, with UI-owned title and
 * archived state from any WebUI sidecar file and the deleted-session tombstone
 * honoured. Results are cached for 5 s per profile keyed on the database stamp.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isCliSessionRow, normalizeAgentSessionSource, readImportableAgentSessionRows, type Dict } from './state-db.js'
import type { SessionStore } from './store.js'
import { str } from '../util.js'

export const CLI_VISIBLE_SESSION_LIMIT = 20
const BACKGROUND_PROJECT_CHIP_LIMIT = 200
const CACHE_TTL_S = 5

export interface CliSessionsDeps {
  store: SessionStore
  profileHome: (profile: string) => string
  lastWorkspace: (profile: string) => string
  /** Python `_state_row_project_id`: the profile's Cron Jobs / Webhooks chip, or null when the profile has not opted into projects. */
  backgroundProjectId?: (kind: 'cron' | 'webhook', profile: string) => string | null
  now: () => number
  log: (line: string) => void
}

export interface CliLoadOptions {
  sourceFilter?: string | null
}

export interface CliSessionRead {
  rows: Dict[]
  truncated: ReadonlySet<string>
}

function dbStamp(path: string): string {
  try { const st = statSync(path, { bigint: true }); return `${st.size.toString()}:${st.mtimeNs.toString()}:${st.ino.toString()}` } catch { return 'missing' }
}

export class CliSessionSource {
  private readonly cache = new Map<string, { key: string; until: number; rows: Dict[]; truncated: ReadonlySet<string> }>()
  constructor(private readonly deps: CliSessionsDeps) {}

  dbPath(profile: string): string { return join(this.deps.profileHome(profile), 'state.db') }

  invalidate(): void { this.cache.clear() }

  /** Python `get_cli_sessions(profile=...)` for one profile; Claude Code imports are not projected here. */
  load(profile: string, opts: CliLoadOptions = {}): Dict[] {
    return this.read(profile, opts).rows
  }

  /** `load` plus the source kinds whose rows stopped at the per-kind window, from the same read (TAL-482). */
  read(profile: string, opts: CliLoadOptions = {}): CliSessionRead {
    const dbPath = this.dbPath(profile)
    const sourceFilter = str(opts.sourceFilter).trim().toLowerCase() || null
    const cacheKey = `${profile}\n${sourceFilter ?? ''}`
    const key = `${dbPath}\n${dbStamp(dbPath)}\n${dbStamp(`${dbPath}-wal`)}`
    const hit = this.cache.get(cacheKey)
    const now = this.deps.now()
    if (hit?.key === key && hit.until > now) return { rows: hit.rows.map((r) => ({ ...r })), truncated: hit.truncated }
    let rows: Dict[]
    const truncated = new Set<string>()
    try {
      rows = this.loadUncached(profile, dbPath, sourceFilter, truncated)
    } catch (error) {
      this.deps.log(`[webui] get_cli_sessions() failed; check state.db schema or path (${dbPath}): ${(error as Error).message}`)
      rows = []
    }
    this.cache.set(cacheKey, { key, until: now + CACHE_TTL_S, rows, truncated })
    return { rows: rows.map((r) => ({ ...r })), truncated }
  }

  private sidecarMeta(sid: string): { title: string | null; archived: boolean } {
    const session = this.deps.store.loadMetadataOnly(sid)
    if (!session) return { title: null, archived: false }
    return { title: str(session.title).trim() || null, archived: session.archived }
  }

  private cronJobNames(home: string): Map<string, string> {
    const names = new Map<string, string>()
    try {
      const path = join(home, 'cron', 'jobs.json')
      if (!existsSync(path)) return names
      const data = JSON.parse(readFileSync(path, 'utf8')) as { jobs?: { id?: unknown; name?: unknown }[] }
      for (const job of data.jobs ?? []) if (job.id && job.name) names.set(str(job.id), str(job.name))
    } catch { /* degrade to the generic title */ }
    return names
  }

  private loadUncached(profile: string, dbPath: string, sourceFilter: string | null, truncated: Set<string>): Dict[] {
    if (!existsSync(dbPath)) return []
    const home = this.deps.profileHome(profile)
    let workspace: string | null = null
    const cliWorkspace = (): string => { workspace ??= this.deps.lastWorkspace(profile); return workspace }
    let cronNames: Map<string, string> | null = null
    const cronTitle = (sid: string): string | null => {
      if (!sid.startsWith('cron_')) return null
      const parts = sid.split('_')
      if (parts.length < 3) return null
      cronNames ??= this.cronJobNames(home)
      return cronNames.get(parts[1] ?? '') ?? null
    }
    const tombstone = this.deps.store.loadDeletedTombstone()
    const out: Dict[] = []
    const seen = new Set<string>()
    // Memoised per scan (Python `_cron_pid` / `_webhook_pid`): one projects.json read per kind, not per row.
    const projectIds = new Map<'cron' | 'webhook', string | null>()
    const projectFor = (kind: 'cron' | 'webhook'): string | null => {
      if (!projectIds.has(kind)) { try { projectIds.set(kind, this.deps.backgroundProjectId?.(kind, profile) ?? null) } catch { projectIds.set(kind, null) } }
      return projectIds.get(kind) ?? null
    }
    const toRow = (row: Dict, sourceTag: string, defaultTitle: string): Dict => {
      const sid = str(row.id)
      const meta = normalizeAgentSessionSource(row.source || sourceTag)
      let title = str(row.title) || null
      if (!title && sourceTag === 'cron') title = cronTitle(sid) ?? title
      const sidecar = this.sidecarMeta(sid)
      if (sidecar.title) title = sidecar.title
      return {
        session_id: sid, title: title ?? defaultTitle, workspace: cliWorkspace(), model: row.model || null,
        message_count: Number(row.message_count) || Number(row.actual_message_count) || 0,
        created_at: row.started_at, updated_at: row.last_activity ?? row.started_at, pinned: false, archived: sidecar.archived,
        project_id: sourceTag === 'cron' || sourceTag === 'webhook' ? projectFor(sourceTag) : null, profile, source_tag: sourceTag, raw_source: row.raw_source ?? meta.raw_source,
        user_id: row.user_id ?? null, chat_id: row.chat_id ?? row.origin_chat_id ?? null, chat_type: row.chat_type ?? null, thread_id: row.thread_id ?? null,
        session_key: row.session_key ?? null, platform: row.platform ?? null,
        session_source: row.session_source ?? meta.session_source, source_label: row.source_label ?? meta.source_label,
        parent_session_id: row.parent_session_id ?? null, parent_title: row.parent_title ?? null, parent_source: row.parent_source ?? null,
        relationship_type: row.relationship_type ?? null, _parent_lineage_root_id: row._parent_lineage_root_id ?? null,
        end_reason: row.end_reason ?? null, actual_message_count: row.actual_message_count ?? null, user_message_count: row.actual_user_message_count ?? null,
        _lineage_root_id: row._lineage_root_id ?? null, _lineage_tip_id: row._lineage_tip_id ?? null, _compression_segment_count: row._compression_segment_count ?? null,
        is_cli_session: isCliSessionRow({ ...row, ...meta }),
      }
    }
    const background = new Set(['cron', 'webhook', 'kanban'])
    const interactiveLimit = sourceFilter === null ? CLI_VISIBLE_SESSION_LIMIT : BACKGROUND_PROJECT_CHIP_LIMIT
    // A filtered read takes one row past its window too, so a single-source list knows more exist (TAL-482).
    const interactive = readImportableAgentSessionRows(dbPath, { limit: sourceFilter === null ? interactiveLimit : interactiveLimit + 1, excludeSources: sourceFilter === null ? ['cron', 'webhook', 'kanban'] : null, includeSources: sourceFilter === null ? null : [sourceFilter], log: this.deps.log })
    if (sourceFilter !== null && interactive.length > interactiveLimit) truncated.add(sourceFilter)
    for (const row of sourceFilter === null ? interactive : interactive.slice(0, interactiveLimit)) {
      const sid = str(row.id)
      const source = str(row.source) || 'cli'
      if (source === 'webui' && tombstone.has(sid) && !existsSync(join(this.deps.store.sessionDir, `${sid}.json`))) continue
      out.push(toRow(row, source, `${source.charAt(0).toUpperCase()}${source.slice(1)} Session`))
      seen.add(sid)
    }
    if (sourceFilter !== null) return out
    for (const kind of background) {
      try {
        // One row past the cap tells the sidebar that more sessions of this kind exist than it lists (TAL-482).
        const rows = readImportableAgentSessionRows(dbPath, { limit: BACKGROUND_PROJECT_CHIP_LIMIT + 1, excludeSources: null, includeSources: [kind], log: this.deps.log })
        if (rows.length > BACKGROUND_PROJECT_CHIP_LIMIT) truncated.add(kind)
        for (const row of rows.slice(0, BACKGROUND_PROJECT_CHIP_LIMIT)) {
          const sid = str(row.id)
          if (seen.has(sid) || (str(row.source) || kind) !== kind) continue
          out.push(toRow(row, kind, `${kind.charAt(0).toUpperCase()}${kind.slice(1)} Session`))
          seen.add(sid)
        }
      } catch (error) {
        this.deps.log(`[webui] ${kind} sidebar second pass failed: ${(error as Error).message}`)
      }
    }
    return out
  }
}
