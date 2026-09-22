/**
 * Profile listing, switching, creation and deletion (Python `api/profiles.py`
 * `list_profiles_api`, `switch_profile(process_wide=False)`, `create_profile_api`,
 * `delete_profile_api`). Rows come from the sidecar (`profiles.*`, the Agent's
 * own per-profile readers); the per-request active profile stays a cookie.
 */
import { existsSync, statSync } from 'node:fs'
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
  log: (line: string) => void
}

export function validateProfileName(name: string): void {
  if (name === 'default') throw new ProfileError("Cannot create a profile named 'default' -- it is the built-in profile.", 400)
  if (!PROFILE_ID_RE.test(name)) throw new ProfileError(`Invalid profile name '${name}'. Must match [a-z0-9][a-z0-9_-]{0,63}`, 400)
}

export class ProfileService {
  private cache: { at: number; rows: Dict[] } | null = null

  constructor(private readonly deps: ProfileDeps, private readonly now: () => number = () => Date.now() / 1000) {}

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
    if (!this.isRootProfile(name) && !isDir(home)) throw new ProfileError(`Profile '${name}' does not exist.`, 404)
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
    return { profiles: await this.list(name), active: name, is_default: this.isRootProfile(name), default_model: defaultModel, default_model_provider: defaultProvider, default_workspace: workspace }
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
    let created: Dict
    try {
      created = (await this.sidecar().call('profiles.create', params)).profile
    } catch (error) {
      throw new ProfileError(str((error as Error).message), 400)
    }
    this.invalidate()
    const home = str(created.path) || this.deps.profileHome(opts.name)
    if (opts.base_url) await this.deps.config.update(home, (c) => { c.model = { ...modelSection(c), base_url: opts.base_url } })
    if (opts.api_key) writeEnvFile(join(home, '.env'), { [profileEnvVarFor(provider)]: opts.api_key })
    if (model || provider) await this.deps.config.update(home, (c) => { const m = modelSection(c); if (model) m.default = model; if (provider) m.provider = provider; c.model = m })
    const rows = await this.list('default')
    return rows.find((r) => str(r.name) === opts.name) ?? { ...created, is_active: false }
  }

  async delete(name: string, active: string): Promise<{ ok: true; name: string }> {
    if (this.deps.isolatedProfileMode()) throw new ProfileError('Profile deletion is not allowed in isolated profile mode.', 403)
    if (this.isRootProfile(name)) throw new ProfileError('Cannot delete the default profile.', 400)
    validateProfileName(name)
    // Python guarded only the process-wide active profile; per-request profiles mean another client may be running a
    // turn under the target profile, so any live run owned by it blocks the delete as well.
    if ((active === name && this.deps.streamsActive()) || this.deps.profileRunsActive(name)) throw new ProfileError(`Cannot delete active profile '${name}' while an agent is running. Cancel or wait for it to finish.`, 409)
    try {
      await this.sidecar().call('profiles.delete', { base_home: this.deps.baseHome, name })
    } catch (error) {
      const message = str((error as Error).message)
      throw new ProfileError(message, /does not exist/i.test(message) ? 404 : 400)
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
    return id === norm(model) || id === norm(`@${g.provider_id}:${model}`) || id.replace(/^@[^:]+:/, '') === norm(model)
  }))
}

export const resolveHome = (base: string, name: string): string => (name === 'default' ? base : resolve(base, 'profiles', name))
export type { Dict }
export { dict }
