/**
 * Profile listing, switching, creation and deletion (Python `api/profiles.py`
 * `list_profiles_api`, `switch_profile(process_wide=False)`, `create_profile_api`,
 * `delete_profile_api`). Rows come from the sidecar (`profiles.*`, the Agent's
 * own per-profile readers); the per-request active profile stays a cookie.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { atomicWriteText } from '../fs/atomic.js'
import { join, resolve } from 'node:path'
import type { SidecarLike } from '../sidecar/client.js'
import type { AgentConfig, Dict } from '../config/agent-config.js'
import { dict, modelSection, parseProviderQualifiedModel, providerIdentity } from '../config/agent-config.js'
import { writeEnvFile } from '../providers/env-file.js'
import { providerEnvVar, type ModelsCatalog } from '../providers/catalog.js'
import { str } from '../util.js'

export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export class ProfileError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export interface ProfileDeps {
  sidecar: () => SidecarLike | null
  baseHome: string
  profileHome: (name: string) => string
  isolatedProfileMode: () => boolean
  isolatedProfileName: () => string
  config: AgentConfig
  /** Resolves a profile's default workspace (Python `get_profile_default_workspace`). */
  defaultWorkspace: (profile: string) => string | null
  models: (profileHome: string) => Promise<ModelsCatalog>
  /** True while any agent stream runs (blocks deleting the process-active profile). */
  streamsActive: () => boolean
  /** Whether any live run's session belongs to the named profile (its home must not be removed underneath it). */
  profileRunsActive: (name: string) => boolean
  /** Deletion tombstones survive restarts here, so a still-valid cookie cannot recreate a deleted profile later. */
  tombstoneFile?: string
  log: (line: string) => void
}

export function validateProfileName(name: string): void {
  if (name === 'default') throw new ProfileError("Cannot create a profile named 'default' -- it is the built-in profile.", 400)
  if (!PROFILE_ID_RE.test(name)) throw new ProfileError(`Invalid profile name '${name}'. Must match [a-z0-9][a-z0-9_-]{0,63}`, 400)
}

export class ProfileService {
  private cache: { at: number; rows: Dict[] } | null = null

  constructor(private readonly deps: ProfileDeps, private readonly now: () => number = () => Date.now() / 1000) {
    for (const name of this.loadTombstones()) this.deleted.add(name)
  }

  /** Also forgets the root-alias snapshot (Python `_invalidate_root_profile_cache`); the next lookup reloads it. */
  invalidate(): void {
    this.cache = null
    this.rootAliasesLoaded = false
  }

  private sidecar(): SidecarLike {
    const s = this.deps.sidecar()
    if (!s) throw new ProfileError('Hermes Agent sidecar is not running; profiles are unavailable', 503)
    return s
  }

  /** Names the Agent reports with `is_default: true` (a renamed root profile), learned from every `profiles.list`. */
  private rootAliases = new Set<string>()
  private rootAliasesLoaded = false

  /** Python `_is_root_profile`: the literal alias plus any row the Agent marks `is_default`; a cache miss refreshes in the background. */
  isRootProfile(name: string): boolean {
    if (!name) return false
    if (name === 'default') return true
    if (!this.rootAliasesLoaded && !this.deps.isolatedProfileMode() && this.deps.sidecar()) void this.list('default').catch(() => undefined)
    return this.rootAliases.has(name)
  }

  /** Learn the root aliases before the first request (Python populated its cache lazily on a synchronous subprocess). */
  async warmRootAliases(): Promise<void> {
    if (this.deps.isolatedProfileMode()) return
    await this.list('default').catch(() => undefined)
  }

  async list(active: string): Promise<Dict[]> {
    if (this.deps.isolatedProfileMode()) {
      const name = this.deps.isolatedProfileName()
      const home = this.deps.baseHome
      let stats = { enabled: 0, total: 0 }
      try { stats = await this.sidecar().call('profiles.skills_stats', { profile_home: home }) } catch { /* fall back to zeros */ }
      return [{ name, path: home, is_default: name === 'default', is_active: true, gateway_running: false, model: null, provider: null, has_env: existsSync(join(home, '.env')), visible: true, skill_count: stats.enabled, enabled_skills: stats.enabled, total_skills: stats.total }]
    }
    let rows: Dict[]
    if (this.cache && this.now() - this.cache.at < 5) rows = this.cache.rows
    else {
      rows = (await this.sidecar().call('profiles.list', { base_home: this.deps.baseHome })).profiles.map((r) => ({ ...r }))
      this.cache = { at: this.now(), rows }
      this.rootAliases = new Set(rows.filter((r) => r.is_default === true && typeof r.name === 'string' && r.name).map((r) => r.name as string))
      this.rootAliasesLoaded = true
    }
    return rows.map((r) => ({ ...r, is_active: str(r.name) === active }))
  }

  activePayload(active: string): Dict {
    let workspace: string | null = null
    try { workspace = this.deps.defaultWorkspace(active) } catch { workspace = null }
    return { name: active, path: this.deps.profileHome(active), is_default: this.isRootProfile(active), default_workspace: workspace }
  }

  /** Python `switch_profile(process_wide=False)`: validate, then answer the target's defaults. */
  async switch(name: string): Promise<Dict> {
    if (this.deps.isolatedProfileMode() && name !== this.deps.isolatedProfileName()) throw new ProfileError(`Profile switching is not allowed in isolated profile mode. Currently pinned to profile '${this.deps.isolatedProfileName()}'.`, 403)
    if (!this.rootAliasesLoaded && name !== 'default') await this.list('default').catch(() => undefined)
    const home = this.deps.profileHome(name)
    // A target mid-deletion must not be handed out as a cookie: the client's next write would recreate its home.
    // The whole switch runs on the target's lifecycle chain, so a deletion cannot start underneath it, and the
    // marker/directory are re-validated at the end for a deletion that completed before the chain was entered.
    const ensureTarget = (): void => {
      if (this.deleting.has(name)) throw new ProfileError(`Profile '${name}' is being deleted.`, 409)
      if (!this.isRootProfile(name) && !isDir(home)) throw new ProfileError(`Profile '${name}' does not exist.`, 404)
    }
    ensureTarget()
    return this.withLifecycle(name, async () => {
      ensureTarget()
      this.invalidate()
      let cfg: Dict = {}
      try { cfg = await this.deps.config.read(home) } catch { cfg = {} }
      const model = cfg.model
      let defaultModel: unknown = null
      let defaultProvider: unknown = null
      if (typeof model === 'string') defaultModel = model
      else if (model && typeof model === 'object') { defaultModel = (model as Dict).default ?? null; defaultProvider = (model as Dict).provider ?? null }
      let workspace: string | null = null
      try { workspace = this.deps.defaultWorkspace(name) } catch { workspace = null }
      const profiles = await this.list(name)
      ensureTarget()
      return { profiles, active: name, is_default: this.isRootProfile(name), default_model: defaultModel, default_model_provider: defaultProvider, default_workspace: workspace }
    })
  }

  async create(opts: { name: string; clone_from?: string | null; clone_config?: boolean; base_url?: string | null; api_key?: string | null; default_model?: string | null; model_provider?: string | null }): Promise<Dict> {
    if (this.deps.isolatedProfileMode()) throw new ProfileError('Profile creation is not allowed in isolated profile mode.', 403)
    validateProfileName(opts.name)
    if (opts.clone_from && !this.isRootProfile(opts.clone_from)) validateProfileName(opts.clone_from)
    const [model, provider] = splitProviderModel(opts.default_model, opts.model_provider)
    if (model || provider) {
      const catalog = await this.deps.models(this.deps.baseHome)
      if (!selectionExists(catalog, model, provider)) {
        if (model && provider) throw new ProfileError(`Selected model '${model}' is not available for provider '${provider}'`, 400)
        if (model) throw new ProfileError(`Selected model '${model}' is not available`, 400)
        throw new ProfileError(`Selected model provider '${provider}' is not available`, 400)
      }
    }
    const params = { base_home: this.deps.baseHome, name: opts.name, ...(opts.clone_from ? { clone_from: opts.clone_from } : {}), clone_config: Boolean(opts.clone_config) }
    // The clone source is read by the sidecar during creation: hold a write lease on it so its deletion waits (and
    // a source already being deleted / deleted is refused before anything is created).
    let releaseSource: (() => void) | null = null
    if (opts.clone_from && !this.isRootProfile(opts.clone_from)) {
      const lease = this.beginWrite(opts.clone_from)
      if (lease === 'deleting') throw new ProfileError(`Profile '${opts.clone_from}' is being deleted.`, 409)
      if (lease === 'missing') throw new ProfileError(`Profile '${opts.clone_from}' does not exist.`, 404)
      if (lease === 'unreadable') throw new ProfileError('Profile deletion records are unreadable; retry in a moment.', 503)
      releaseSource = lease
    }
    // Sidecar creation and the follow-up configuration writes are one lifecycle step: a delete of the same name
    // waits behind them instead of removing the half-configured home (and `config.set` resurrecting it).
    const created = await this.withLifecycle(opts.name, async () => {
      // A recreation whose tombstone clearing (or follow-up configuration) failed left a home behind: retrying the
      // create skips the sidecar (which would refuse the existing directory) but re-applies the requested settings
      // before clearing the record, so a partially configured home never becomes the final state.
      let row: Dict
      const home = this.deps.profileHome(opts.name)
      if ((this.deleted.has(opts.name) || this.incomplete.has(opts.name)) && isDir(home)) {
        row = { name: opts.name, path: home }
      } else {
        try {
          row = (await this.sidecar().call('profiles.create', params)).profile
        } catch (error) {
          throw new ProfileError(str((error as Error).message), 400)
        }
      }
      this.invalidate()
      const target = str(row.path) || home
      // The home exists from here on; until the requested settings are applied the creation is incomplete, so a
      // failed write rolls the home back (a clean retry recreates it) or, if even that fails, leaves a marker that
      // lets the retry re-apply the settings without a second sidecar create against the existing directory.
      this.incomplete.add(opts.name)
      try {
        if (opts.base_url) await this.deps.config.update(target, (c) => { c.model = { ...modelSection(c), base_url: opts.base_url } })
        if (opts.api_key) writeEnvFile(join(target, '.env'), { [profileEnvVarFor(provider)]: opts.api_key })
        if (model || provider) await this.deps.config.update(target, (c) => { const m = modelSection(c); if (model) m.default = model; if (provider) m.provider = provider; c.model = m })
      } catch (error) {
        let rolledBack = false
        if (!this.deleted.has(opts.name)) {
          try {
            await this.sidecar().call('profiles.delete', { base_home: this.deps.baseHome, name: opts.name })
            this.incomplete.delete(opts.name)
            this.invalidate()
            rolledBack = true
          } catch (rollbackError) {
            this.deps.log(`[webui] WARNING: half-created profile '${opts.name}' could not be rolled back: ${str((rollbackError as Error).message)}`)
          }
        }
        if (error instanceof ProfileError) throw error
        throw new ProfileError(`Profile '${opts.name}' could not be configured (${str((error as Error).message)}); ${rolledBack ? 'the created home was rolled back — retry the create' : 'retry the create to apply the settings'}`, 500)
      }
      this.incomplete.delete(opts.name)
      // The deletion tombstone lifts only once the recreation fully succeeded, and only durably: if the removal cannot
      // be persisted the in-memory mark is kept too, so the response and a restart agree (the profile stays refused
      // until the record can be written), instead of a working profile turning unusable on the next start.
      if (this.deleted.has(opts.name)) this.clearTombstoneDurably(opts.name)
      return row
    }).finally(() => { releaseSource?.() })
    const rows = await this.list('default')
    return rows.find((r) => str(r.name) === opts.name) ?? { ...created, is_active: false }
  }

  /** Per-profile lifecycle chain: creation (+ its configuration) and deletion of one name never overlap. */
  private readonly lifecycles = new Map<string, Promise<unknown>>()
  /** Homes created by the sidecar whose requested configuration has not been applied yet (and could not be rolled back). */
  private readonly incomplete = new Set<string>()

  private clearTombstoneDurably(name: string): void {
    this.deleted.delete(name)
    try {
      this.saveTombstones()
    } catch (error) {
      this.deleted.add(name)
      throw new ProfileError(`Profile '${name}' exists but its deletion record could not be cleared (${str((error as Error).message)}); writes stay refused until a retried create can clear it`, 503)
    }
  }

  private withLifecycle<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.lifecycles.get(name) ?? Promise.resolve()).then(fn)
    const settled = run.catch(() => undefined).then(() => { if (this.lifecycles.get(name) === settled) this.lifecycles.delete(name) })
    this.lifecycles.set(name, settled)
    return run
  }

  /** Profiles whose deletion RPC is in flight: turn admission refuses them so no run enters the check-to-use window. */
  private readonly deleting = new Set<string>()
  /** Deleted profiles (persisted): a client still carrying their cookie must not write them back into existence. */
  private readonly deleted = new Set<string>()

  /** Set when the tombstone file exists but cannot be read or parsed: named-profile writes fail closed until it can. */
  private tombstoneLoadError: string | null = null

  private loadTombstones(): string[] {
    if (!this.deps.tombstoneFile) return []
    let raw: string
    try {
      raw = readFileSync(this.deps.tombstoneFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.tombstoneLoadError = null; return [] }
      this.tombstoneLoadError = str((error as Error).message)
      return []
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) throw new Error('not a list')
      this.tombstoneLoadError = null
      return parsed.filter((v): v is string => typeof v === 'string' && PROFILE_ID_RE.test(v))
    } catch (error) {
      this.tombstoneLoadError = `malformed: ${str((error as Error).message)}`
      return []
    }
  }

  /** Persist the tombstones; throws when the state directory cannot be written (callers decide whether to fail closed). */
  private saveTombstones(): void {
    if (!this.deps.tombstoneFile) return
    atomicWriteText(this.deps.tombstoneFile, JSON.stringify([...this.deleted].sort()))
  }

  isDeleting(name: string | null): boolean {
    return name !== null && this.deleting.has(name)
  }

  /** In-flight profile-scoped mutations per name; deletion waits until they drain and refuses new ones meanwhile. */
  private readonly writeLeases = new Map<string, { count: number; drained: (() => void)[] }>()

  /**
   * Lease a profile-scoped write for a request's lifetime. `'deleting'` while the profile's deletion RPC runs (409);
   * `'missing'` for a profile this process deleted until a recreation fully succeeds (404) — a stale cookie must
   * never recreate it, not even while `profiles.create` is mid-flight. Profiles that merely never existed keep lazy
   * creation (group-mapped trusted identities).
   */
  beginWrite(name: string): (() => void) | 'deleting' | 'missing' | 'unreadable' {
    if (this.deleting.has(name)) return 'deleting'
    // An unreadable tombstone record cannot vouch for any named profile: retry the load, else fail closed (the root
    // profile can never be deleted, so it stays writable).
    if (this.tombstoneLoadError !== null && !this.isRootProfile(name)) {
      for (const stale of this.loadTombstones()) this.deleted.add(stale)
      if (this.tombstoneLoadError !== null) return 'unreadable'
    }
    if (this.deleted.has(name)) return 'missing'
    const lease = this.writeLeases.get(name) ?? { count: 0, drained: [] }
    lease.count += 1
    this.writeLeases.set(name, lease)
    let released = false
    return () => {
      if (released) return
      released = true
      lease.count -= 1
      if (lease.count > 0) return
      this.writeLeases.delete(name)
      for (const resolve of lease.drained.splice(0)) resolve()
    }
  }

  private awaitWritesDrained(name: string, timeoutMs: number): Promise<void> {
    const lease = this.writeLeases.get(name)
    if (!lease || lease.count <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new ProfileError(`Profile '${name}' still has requests in flight. Retry in a moment.`, 503)) }, timeoutMs)
      lease.drained.push(() => { clearTimeout(timer); resolve() })
    })
  }

  async delete(name: string, active: string): Promise<{ ok: true; name: string }> {
    if (this.deps.isolatedProfileMode()) throw new ProfileError('Profile deletion is not allowed in isolated profile mode.', 403)
    if (this.isRootProfile(name)) throw new ProfileError('Cannot delete the default profile.', 400)
    validateProfileName(name)
    // Python guarded only the process-wide active profile; per-request profiles mean another client may be running a
    // turn under the target profile, so any live run owned by it blocks the delete as well. The mark goes on before
    // the check: a turn admitted in between is caught by the check, one arriving after is refused by the mark.
    // One deletion per profile at a time: a second overlapping request must not share (and then clear) the mark.
    if (this.deleting.has(name)) throw new ProfileError(`Profile '${name}' is already being deleted.`, 409)
    this.deleting.add(name)
    try {
      // Behind any in-flight creation of the same name, so its configuration writes finish before the home goes.
      await this.withLifecycle(name, async () => {
        if ((active === name && this.deps.streamsActive()) || this.deps.profileRunsActive(name)) throw new ProfileError(`Cannot delete active profile '${name}' while an agent is running. Cancel or wait for it to finish.`, 409)
        // Mutations admitted before the mark finish before the home goes; new ones are refused by the mark. A request
        // that drained may have started detached profile work (a memory commit) on its way out: check again.
        await this.awaitWritesDrained(name, 30_000)
        if (this.deps.profileRunsActive(name)) throw new ProfileError(`Cannot delete active profile '${name}' while an agent is running. Cancel or wait for it to finish.`, 409)
        // The tombstone is durable before anything is removed: if it cannot be persisted, nothing is deleted, so a
        // restart can never lose the guard for a home that is already gone.
        this.deleted.add(name)
        try {
          this.saveTombstones()
        } catch (error) {
          this.deleted.delete(name)
          throw new ProfileError(`Profile '${name}' was not deleted: the deletion record could not be written (${str((error as Error).message)})`, 503)
        }
        try {
          await this.sidecar().call('profiles.delete', { base_home: this.deps.baseHome, name })
        } catch (error) {
          this.deleted.delete(name)
          try { this.saveTombstones() } catch { /* the stale tombstone only over-refuses; the next successful create lifts it */ }
          const message = str((error as Error).message)
          throw new ProfileError(message, /does not exist/i.test(message) ? 404 : 400)
        }
      })
    } finally {
      this.deleting.delete(name)
    }
    this.invalidate()
    return { ok: true, name }
  }
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** Python `_clean_profile_config_value`: a single line of at most 512 characters. */
function cleanValue(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  const text = str(value).trim()
  if (!text) return null
  if (/[\r\n\0]/.test(text)) throw new ProfileError(`${field} must be a single-line value`, 400)
  if (text.length > 512) throw new ProfileError(`${field} is too long`, 400)
  return text
}

/** Python `_PROVIDER_ENV_MAP`: spellings this module owns; anything else falls through to the catalog's mapping. */
const PROFILE_PROVIDER_ENV_MAP: Record<string, string> = {
  'kimi-coding': 'KIMI_API_KEY', 'kimi-coding-cn': 'KIMI_CN_API_KEY', deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY', google: 'GEMINI_API_KEY', gemini: 'GEMINI_API_KEY', xai: 'XAI_API_KEY', groq: 'GROQ_API_KEY', minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY', mistral: 'MISTRAL_API_KEY', zai: 'ZAI_API_KEY', dashscope: 'DASHSCOPE_API_KEY', kilocode: 'KILOCODE_API_KEY',
  cerebras: 'CEREBRAS_API_KEY', 'github-copilot': 'COPILOT_GITHUB_TOKEN', nous: 'NOUS_API_KEY',
}

/** Python `_resolve_env_var_for_provider`: the module map, then the catalog mapping (alias-aware), else `HERMES_API_KEY`. */
export function profileEnvVarFor(provider: string | null): string {
  const slug = str(provider).trim().toLowerCase()
  if (!slug) return 'HERMES_API_KEY'
  const mapped = PROFILE_PROVIDER_ENV_MAP[slug]
  if (mapped) return mapped
  for (const candidate of [slug, providerIdentity(slug)]) { const resolved = candidate ? providerEnvVar(candidate) : null; if (resolved) return resolved }
  return 'HERMES_API_KEY'
}

/** Python `_split_webui_provider_model_value`. */
export function splitProviderModel(defaultModel: unknown, modelProvider: unknown): [string | null, string | null] {
  let model = cleanValue(defaultModel, 'default_model')
  let provider = cleanValue(modelProvider, 'model_provider')
  if (model?.startsWith('@') && model.includes(':')) {
    const parsed = parseProviderQualifiedModel(model)
    if (parsed) {
      provider = provider ?? cleanValue(parsed[1], 'model_provider')
      model = cleanValue(parsed[0], 'default_model')
    }
  }
  return [model, provider]
}

/** Python `_profile_model_selection_exists`. */
export function selectionExists(catalog: ModelsCatalog, model: string | null, provider: string | null): boolean {
  const groups = catalog.groups
  if (provider && !groups.some((g) => g.provider_id === provider)) return false
  if (!model) return true
  const norm = (s: string): string => s.trim().toLowerCase()
  return groups.some((g) => (!provider || g.provider_id === provider) && g.models.some((m) => {
    const id = norm(m.id)
    return id === norm(model) || id === norm(`@${g.provider_id}:${model}`) || norm(parseProviderQualifiedModel(m.id)?.[0] ?? m.id) === norm(model)
  }))
}

export const resolveHome = (base: string, name: string): string => (name === 'default' ? base : resolve(base, 'profiles', name))
export type { Dict }
export { dict }
