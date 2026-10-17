/**
 * Sidebar rows for Agent-owned sessions read from `state.db` (Python
 * `models.get_cli_sessions` / `_load_cli_sessions_uncached`): the interactive
 * window plus bounded cron, webhook, and kanban passes, with UI-owned title and
 * archived state from any WebUI sidecar file and the deleted-session tombstone
 * honoured. Results are cached for 5 s per profile keyed on the database stamp.
 * `read` queries `state.db` on the listing worker so the event loop stays free
 * (TAL-920); `readSync` serves single-session lookups that are still synchronous.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_STORAGE_OK, isCliSessionRow, normalizeAgentSessionSource, readImportableAgentSessionRows, readImportableAgentSessionRowsAsync, stateDbReadFailure, stateDbStorage, stateDbStorageAsync, type Dict, type ReadRowsOptions } from './state-db.js'
import type { AgentStorage } from '@maudecode/talaria-web-contracts'
import { latestLineageSidecar, sanitizeSessionRow, type ListParams } from './list.js'
import type { SessionStore } from './store.js'
import { str } from '../util.js'
import { looksLikeDefaultCliTitle } from './titles.js'

export const CLI_VISIBLE_SESSION_LIMIT = 20
const BACKGROUND_PROJECT_CHIP_LIMIT = 200
const CACHE_TTL_S = 5
const BACKGROUND_KINDS = ['cron', 'webhook', 'kanban'] as const

export interface CliSessionsDeps {
  store: SessionStore
  profileHome: (profile: string) => string
  lastWorkspace: (profile: string) => string | Promise<string>
  profilesMatch: ListParams['profilesMatch']
  /** Python `_state_row_project_id`: the profile's Cron Jobs / Webhooks chip, or null when the profile has not opted into projects. */
  backgroundProjectId?: (kind: 'cron' | 'webhook', profile: string) => string | null | Promise<string | null>
  now: () => number
  log: (line: string) => void
}

export interface CliLoadOptions {
  sourceFilter?: string | null
  sessionIds?: readonly string[]
}

export interface CliSessionRead {
  rows: Dict[]
  truncated: ReadonlySet<string>
  /** TAL-785: whether state.db could serve the rows; a corrupt or outdated one explains an empty Agent list. */
  storage: AgentStorage
}

function dbStamp(path: string): string {
  try { const st = statSync(path, { bigint: true }); return `${st.size.toString()}:${st.mtimeNs.toString()}:${st.ino.toString()}` } catch { return 'missing' }
}

interface CacheSlot { cacheKey: string; key: string; dbPath: string; sourceFilter: string | null; sessionIds: readonly string[] | null }
/** One sidebar build's state.db reads: the interactive window (`kind` null), then each background kind when unfiltered. */
interface ListingQuery { kind: string | null; opts: ReadRowsOptions }
/** A query's rows, or the error a background kind's read failed with. */
type QueryResult = Dict[] | Error
/** Every query's result in `queries` order; null when there is no state.db, an Error when the interactive read failed. */
type QueryResults = QueryResult[] | null | Error

/** A background kind's failed read is kept as its result; the interactive read's failure fails the build. */
function backgroundFailure(query: ListingQuery, error: unknown): Error {
  if (query.kind === null) throw error
  return error as Error
}

export class CliSessionSource {
  private readonly cache = new Map<string, { key: string; until: number; rows: Dict[]; truncated: ReadonlySet<string>; storage: AgentStorage }>()
  constructor(private readonly deps: CliSessionsDeps) {}

  dbPath(profile: string): string { return join(this.deps.profileHome(profile), 'state.db') }

  invalidate(): void { this.cache.clear() }

  /** Python `get_cli_sessions(profile=...)` for one profile; Claude Code imports are not projected here. */
  async load(profile: string, opts: CliLoadOptions = {}): Promise<Dict[]> {
    return (await this.read(profile, opts)).rows
  }

  /** `load` plus the source kinds whose rows stopped at the per-kind window, from the same read (TAL-482). */
  async read(profile: string, opts: CliLoadOptions = {}): Promise<CliSessionRead> {
    const slot = await this.slot(profile, opts)
    const hit = this.cached(slot)
    if (hit) return hit
    const now = this.deps.now()
    let results: QueryResults = null
    let storage = AGENT_STORAGE_OK
    try {
      if (existsSync(slot.dbPath)) {
        const settled: QueryResult[] = []
        for (const query of this.queries(slot)) settled.push(await readImportableAgentSessionRowsAsync(slot.dbPath, query.opts).catch((error: unknown) => backgroundFailure(query, error)))
        results = settled
        storage = await stateDbStorageAsync(slot.dbPath)
      }
    } catch (error) {
      results = error as Error
    }
    return (await this.store(slot, now, profile, results, storage))
  }

  /** `read` with the state.db queries on this thread, for single-session lookups whose callers are synchronous. */
  async readSync(profile: string, opts: CliLoadOptions = {}): Promise<CliSessionRead> {
    const slot = await this.slot(profile, opts)
    const hit = this.cached(slot)
    if (hit) return hit
    const now = this.deps.now()
    const storage = stateDbStorage(slot.dbPath)
    let results: QueryResults
    try {
      results = existsSync(slot.dbPath) ? this.queries(slot).map((query) => { try { return readImportableAgentSessionRows(slot.dbPath, query.opts) } catch (error) { return backgroundFailure(query, error) } }) : null
    } catch (error) {
      results = error as Error
    }
    return (await this.store(slot, now, profile, results, storage))
  }

  private async slot(profile: string, opts: CliLoadOptions): Promise<CacheSlot> {
    const dbPath = this.dbPath(profile)
    const sourceFilter = str(opts.sourceFilter).trim().toLowerCase() || null
    const sessionIds = opts.sessionIds ?? null
    return { cacheKey: `${profile}\n${sourceFilter ?? ''}`, key: `${dbPath}\n${dbStamp(dbPath)}\n${dbStamp(`${dbPath}-wal`)}\n${await this.deps.store.index().then((index) => index.revision, () => '')}`, dbPath, sourceFilter, sessionIds }
  }

  private cached(slot: CacheSlot): CliSessionRead | null {
    if (slot.sessionIds !== null) return null
    const hit = this.cache.get(slot.cacheKey)
    if (hit?.key !== slot.key || hit.until <= this.deps.now()) return null
    return { rows: hit.rows.map((r) => ({ ...r })), truncated: hit.truncated, storage: hit.storage }
  }

  /**
   * Build the rows, degrade a failed read or build to none with the Python log line, and cache the outcome. A failed
   * read, interactive or background, decides the storage state (`corrupt` first, else `unavailable`), since it can reach
   * a damaged page the probe never touched; a probe that alone could not read says nothing about rows that were served.
   */
  private async store(slot: CacheSlot, now: number, profile: string, results: QueryResults, probed: AgentStorage): Promise<CliSessionRead> {
    let rows: Dict[]
    const truncated = new Set<string>()
    const failures = results instanceof Error ? [results] : (results ?? []).filter((r): r is Error => r instanceof Error)
    const failed = failures.map(stateDbReadFailure)
    const storage = failed.find((s) => s.state === 'corrupt') ?? failed[0] ?? (probed.state === 'unavailable' ? AGENT_STORAGE_OK : probed)
    try {
      if (results instanceof Error) throw results
      rows = results ? (await this.build(profile, slot, results, truncated)) : []
    } catch (error) {
      this.deps.log(`[webui] get_cli_sessions() failed; check state.db schema or path (${slot.dbPath}): ${(error as Error).message}`)
      rows = []
    }
    if (slot.sessionIds === null) this.cache.set(slot.cacheKey, { key: slot.key, until: now + CACHE_TTL_S, rows, truncated, storage })
    return { rows: rows.map((r) => ({ ...r })), truncated, storage }
  }

  private queries(slot: CacheSlot): ListingQuery[] {
    const { sourceFilter } = slot
    const log = this.deps.log
    if (slot.sessionIds !== null) return [{ kind: null, opts: { sessionIds: slot.sessionIds, limit: null, excludeSources: ['webui'], log } }]
    const interactiveLimit = sourceFilter === null ? CLI_VISIBLE_SESSION_LIMIT : BACKGROUND_PROJECT_CHIP_LIMIT
    // A filtered read takes one row past its window too, so a single-source list knows more exist (TAL-482).
    const out: ListingQuery[] = [{ kind: null, opts: { limit: sourceFilter === null ? interactiveLimit : interactiveLimit + 1, excludeSources: sourceFilter === null ? [...BACKGROUND_KINDS] : null, includeSources: sourceFilter === null ? null : [sourceFilter], log } }]
    // One row past the cap tells the sidebar that more sessions of this kind exist than it lists (TAL-482).
    if (sourceFilter === null) for (const kind of BACKGROUND_KINDS) out.push({ kind, opts: { limit: BACKGROUND_PROJECT_CHIP_LIMIT + 1, excludeSources: null, includeSources: [kind], log } })
    return out
  }

  /**
   * UI-owned metadata of saved WebUI sidecars, from the session index parsed once per
   * build; only a sidecar file the index does not list is read (TAL-920).
   */
  private sidecarMetaLookup(): (sid: string) => Promise<Dict | undefined> {
    const store = this.deps.store
    let persisted: Set<string> | null = null
    let indexed: Map<string, Dict> | null = null
    return async (sid) => {
      persisted ??= (await store.persistedIds())
      if (!persisted.has(sid)) return undefined
      if (indexed === null) {
        let entries: Dict[] = []
        try { entries = (await store.readIndexEntries()) } catch { /* every sidecar falls back to its file */ }
        indexed = new Map(entries.flatMap((entry) => { const row = sanitizeSessionRow(entry, store, 'index'); return row ? [[str(row.session_id), row] as const] : [] }))
      }
      const entry = indexed.get(sid)
      if (entry) return entry
      const session = (await store.loadMetadataOnly(sid))
      return session?.compact()
    }
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

  private async build(profile: string, slot: CacheSlot, results: QueryResult[], truncated: Set<string>): Promise<Dict[]> {
    const { sourceFilter } = slot
    const home = this.deps.profileHome(profile)
    let workspace: string | null = null
    const cliWorkspace = async (): Promise<string> => { workspace ??= (await this.deps.lastWorkspace(profile)); return workspace }
    let cronNames: Map<string, string> | null = null
    const cronTitle = (sid: string): string | null => {
      if (!sid.startsWith('cron_')) return null
      const parts = sid.split('_')
      if (parts.length < 3) return null
      cronNames ??= this.cronJobNames(home)
      return cronNames.get(parts[1] ?? '') ?? null
    }
    const sidecarMeta = this.sidecarMetaLookup()
    const tombstone = (await this.deps.store.loadDeletedTombstone())
    const out: Dict[] = []
    const seen = new Set<string>()
    // Memoised per scan (Python `_cron_pid` / `_webhook_pid`): one projects.json read per kind, not per row.
    const projectIds = new Map<'cron' | 'webhook', string | null>()
    const projectFor = async (kind: 'cron' | 'webhook'): Promise<string | null> => {
      if (!projectIds.has(kind)) { try { projectIds.set(kind, (await this.deps.backgroundProjectId?.(kind, profile)) ?? null) } catch { projectIds.set(kind, null) } }
      return projectIds.get(kind) ?? null
    }
    const toRow = async (row: Dict, sourceTag: string, defaultTitle: string): Promise<Dict> => {
      const sid = str(row.id)
      const meta = normalizeAgentSessionSource(row.source || sourceTag)
      let title = str(row.title) || null
      if (!title && sourceTag === 'cron') title = cronTitle(sid) ?? title
      const lineage = Array.isArray(row._lineage_ids) ? row._lineage_ids.filter((id): id is string => typeof id === 'string') : null
      const lineageIds = lineage ?? [sid]
      const metadata = new Map(await Promise.all(lineageIds.map(async (id) => [id, await sidecarMeta(id)] as const)))
      const sidecar = latestLineageSidecar(lineageIds, profile, (id) => metadata.get(id), this.deps.profilesMatch)
      if (sidecar?.title && (!lineage || !title || !looksLikeDefaultCliTitle(sidecar))) title = str(sidecar.title)
      return {
        session_id: sid, title: title ?? defaultTitle, workspace: (lineage && str(sidecar?.workspace)) || (await cliWorkspace()), model: row.model || null,
        message_count: Number(row.message_count) || Number(row.actual_message_count) || 0,
        created_at: row.started_at, updated_at: row.last_activity ?? row.started_at, pinned: Boolean(sidecar?.pinned), archived: Boolean(sidecar?.archived),
        project_id: sourceTag === 'cron' || sourceTag === 'webhook' ? await projectFor(sourceTag) : lineage ? str(sidecar?.project_id) || null : null, profile, source_tag: sourceTag, raw_source: row.raw_source ?? meta.raw_source,
        user_id: row.user_id ?? null, chat_id: row.chat_id ?? row.origin_chat_id ?? null, chat_type: row.chat_type ?? null, thread_id: row.thread_id ?? null,
        session_key: row.session_key ?? null, platform: row.platform ?? null,
        session_source: row.session_source ?? meta.session_source, source_label: row.source_label ?? meta.source_label,
        parent_session_id: row.parent_session_id ?? null, parent_title: row.parent_title ?? null, parent_source: row.parent_source ?? null,
        relationship_type: row.relationship_type ?? null, _parent_lineage_root_id: row._parent_lineage_root_id ?? null,
        end_reason: row.end_reason ?? null, actual_message_count: row.actual_message_count ?? null, user_message_count: row.actual_user_message_count ?? null,
        _lineage_root_id: row._lineage_root_id ?? null, _lineage_tip_id: row._lineage_tip_id ?? null, _compression_segment_count: row._compression_segment_count ?? null,
        _lineage_ids: row._lineage_ids ?? null,
        is_cli_session: isCliSessionRow({ ...row, ...meta }),
      }
    }
    const interactiveLimit = sourceFilter === null ? CLI_VISIBLE_SESSION_LIMIT : BACKGROUND_PROJECT_CHIP_LIMIT
    const interactive = results[0] as Dict[]
    if (sourceFilter !== null && interactive.length > interactiveLimit) truncated.add(sourceFilter)
    for (const row of sourceFilter === null ? interactive : interactive.slice(0, interactiveLimit)) {
      const sid = str(row.id)
      const source = str(row.source) || 'cli'
      if (source === 'webui' && tombstone.has(sid) && !await this.deps.store.exists(sid)) continue
      out.push(await toRow(row, source, `${source.charAt(0).toUpperCase()}${source.slice(1)} Session`))
      seen.add(sid)
    }
    if (sourceFilter !== null) return out
    for (const [i, kind] of BACKGROUND_KINDS.entries()) {
      try {
        const rows = results[i + 1] ?? []
        if (rows instanceof Error) throw rows
        if (rows.length > BACKGROUND_PROJECT_CHIP_LIMIT) truncated.add(kind)
        for (const row of rows.slice(0, BACKGROUND_PROJECT_CHIP_LIMIT)) {
          const sid = str(row.id)
          if (seen.has(sid) || (str(row.source) || kind) !== kind) continue
          out.push(await toRow(row, kind, `${kind.charAt(0).toUpperCase()}${kind.slice(1)} Session`))
          seen.add(sid)
        }
      } catch (error) {
        this.deps.log(`[webui] ${kind} sidebar second pass failed: ${(error as Error).message}`)
      }
    }
    return out
  }
}
