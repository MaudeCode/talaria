/**
 * The Agent's per-profile `config.yaml`, read and written through the sidecar
 * (`config.get` / `config.set`) so the server needs no YAML parser. Reads are
 * memoised on the file's mtime, ctime, size and inode; every write evicts the entry.
 *
 * Policy helpers (model section, reasoning, max_tokens, auxiliary slots,
 * personalities) port Python `api/config.py`.
 */
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import type { SidecarResult, DelegationSettings, DelegationWrite } from '@maudecode/talaria-web-contracts'
import type { SidecarLike } from '../sidecar/client.js'
import { LOCAL_RUNTIME_PROVIDER, PORTAL_PROVIDERS, PROVIDER_ALIASES, PROVIDER_DISPLAY, PROVIDER_MODELS, VALID_REASONING_EFFORTS, AUXILIARY_TASK_CATALOG, RETIRED_AUX_TASK_SLOTS } from '../providers/tables.js'
import { str } from '../util.js'
import { fileStatKey } from '../fs/stat.js'

export type SpeedTier = SidecarResult<'models.speed_tiers'>['tiers'][number][number]
/** One auxiliary slot as the Agent lists it (TAL-800); the static catalog's rows carry no effort or inheritance. */
export type AuxSlot = Omit<SidecarResult<'aux.tasks'>['tasks'][number], 'reasoning_effort'> & { reasoning_effort: string | null }
export type Config = Record<string, unknown>
export type Dict = Record<string, unknown>

export const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v)
export const dict = (v: unknown): Dict => (isDict(v) ? v : {})

export class ConfigUnavailable extends Error {}

/** `profileFile`: address `<home>/config.yaml` itself, ignoring `HERMES_CONFIG_PATH` (Python `_active_profile_config_path` for skills). */
export interface ConfigFileOptions { profileFile?: boolean }

export class AgentConfig {
  private readonly cache = new Map<string, { key: string; config: Config }>()
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly deps: { sidecar: () => SidecarLike | null; env: Record<string, string | undefined> }) {}

  /** The authoritative config file: the documented `HERMES_CONFIG_PATH` override, else `<home>/config.yaml`. Every read, write, and fingerprint uses this one path. */
  path(profileHome: string, opts: ConfigFileOptions = {}): string {
    const override = opts.profileFile ? '' : (this.deps.env.HERMES_CONFIG_PATH ?? '').trim()
    return override ? resolvePath(override.replace(/^~(?=$|\/)/, homedir())) : join(profileHome, 'config.yaml')
  }

  /** Fingerprint of the config file; `missing` only when it does not exist. Any other stat failure (EACCES, EIO, ...) is unreadable, never empty. */
  private statKey(profileHome: string, opts: ConfigFileOptions = {}): string {
    try {
      // ctime moves on chmod/chown, so a permission change re-reads through the sidecar instead of serving the old parse.
      return fileStatKey(this.path(profileHome, opts))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
      throw new ConfigUnavailable(`config.yaml is unreadable (${code ?? 'stat failed'}); refusing to treat it as empty`)
    }
  }

  /** The config file's current fingerprint, so a value derived from it can tell it is stale; `unreadable` on a stat failure. */
  fingerprint(profileHome: string): string {
    try { return this.statKey(profileHome) } catch { return 'unreadable' }
  }

  /** Parsed config.yaml (empty object when the file is missing). */
  async read(profileHome: string, opts: ConfigFileOptions = {}): Promise<Config> {
    const file = this.path(profileHome, opts)
    const key = this.statKey(profileHome, opts)
    const hit = this.cache.get(file)
    if (hit?.key === key) return structuredClone(hit.config)
    if (key === 'missing') return {}
    const sidecar = this.deps.sidecar()
    if (!sidecar) throw new ConfigUnavailable('Hermes Agent sidecar is not running; config.yaml is unavailable')
    // The snapshot is keyed by the fingerprint observed before the read; a file replaced while the RPC was in flight
    // is re-read once and otherwise reported unavailable rather than cached under the new key.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = this.statKey(profileHome, opts)
      const result = await sidecar.call('config.get', { profile_home: profileHome, config_path: file })
      const config = isDict(result.config) ? result.config : {}
      if (this.statKey(profileHome, opts) === before) {
        this.cache.set(file, { key: before, config })
        return structuredClone(config)
      }
    }
    throw new ConfigUnavailable('config.yaml changed while it was being read; retry')
  }

  /** Synchronous last-known config for callers that cannot await (workspace resolution); refreshes in the background. */
  peek(profileHome: string, opts: { refresh?: boolean } = {}): Config | null {
    let key: string
    try { key = this.statKey(profileHome) } catch { return null }
    const hit = this.cache.get(this.path(profileHome))
    if (hit?.key === key) return hit.config
    if (key === 'missing') return {}
    // A changed file invalidates the snapshot: callers gate on `null` (fail closed) until the matching read lands.
    if (opts.refresh !== false) void this.read(profileHome).catch(() => undefined)
    return null
  }

  /** Read-modify-write under a per-file lock (homes sharing an `HERMES_CONFIG_PATH` override serialise); `mutate` returns false to skip the write. */
  async update(profileHome: string, mutate: (config: Config) => unknown, opts: ConfigFileOptions = {}): Promise<Config> {
    const file = this.path(profileHome, opts)
    const prev = this.locks.get(file) ?? Promise.resolve()
    const run = prev.catch(() => undefined).then(async () => {
      const config = await this.read(profileHome, opts)
      if (await mutate(config) === false) return config
      const sidecar = this.deps.sidecar()
      if (!sidecar) throw new ConfigUnavailable('Hermes Agent sidecar is not running; config.yaml cannot be written')
      await sidecar.call('config.set', { profile_home: profileHome, config_path: file, config })
      this.cache.delete(file)
      return config
    })
    this.locks.set(file, run)
    return run
  }

  /** The Agent owns speed eligibility. A failed lookup must not erase a saved tier. */
  async speedTiers(profileHome: string, config: Config, models: { model: string; provider: string }[]): Promise<SpeedTier[][]> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) throw new ConfigUnavailable('Hermes Agent sidecar is not running; speed tiers are unavailable')
    try {
      const routes = models.map(({ model, provider }) => ({ model, provider: resolveProviderAlias(provider), base_url: modelBaseUrl(config, provider) }))
      const result = await sidecar.call('models.speed_tiers', { profile_home: profileHome, routes })
      if (result.tiers.length !== routes.length) throw new Error('incomplete speed tier response')
      return result.tiers
    } catch (error) {
      throw new ConfigUnavailable(`Speed tiers are unavailable: ${String(error)}`)
    }
  }

  /**
   * TAL-800: the profile's auxiliary slots as its Agent lists them (plugin tasks included), and the Agent's other
   * `auxiliary.*` keys. The static catalog only when the Agent cannot list them; `reserved` is then unknown (null).
   */
  async auxiliarySlots(profileHome: string): Promise<{ slots: AuxSlot[]; reserved: string[] | null }> {
    const sidecar = this.deps.sidecar()
    // A failed listing offers the built-in table only, so a plugin slot is never assignable without the Agent vouching for it.
    const listed = sidecar ? await sidecar.call('aux.tasks', { profile_home: profileHome }).catch(() => null) : null
    return listed ? { slots: listed.tasks, reserved: listed.reserved } : { slots: AUXILIARY_TASK_CATALOG.map((slot) => ({ ...slot, inherit_from: null, reasoning_effort: null, effective: null, takes_reasoning: null })), reserved: null }
  }

  async delegation(profileHome: string, config: Config): Promise<Omit<DelegationSettings, 'can_edit'>> {
    const section = dict(config.delegation)
    const configured = str(section.backend).trim().toLowerCase() || 'default'
    const sidecar = this.deps.sidecar()
    const registry = sidecar ? await sidecar.call('aux.delegation', { profile_home: profileHome, config }).catch(() => null) : null
    const blocks = dict(section.backends)
    const block = (key: string, field: 'options' | 'profiles') => {
      const saved = dict(blocks[key])
      const rows = Array.isArray(saved[field]) ? saved[field] as unknown[] : []
      return { default: str(saved.default) || null, [field]: rows.filter(isDict).map((row) => {
        // Request overrides and credentials stay private and round-trip by original route identity.
        const visible = ['name', 'description', 'provider', 'model', 'base_url', 'api_mode', 'reasoning_effort', 'service_tier', 'profile', 'label']
        return { ...Object.fromEntries(visible.filter((key) => typeof row[key] === 'string').map((key) => [key, row[key]])), name: str(row.name), api_key_set: Boolean(row.api_key),
          ...(Array.isArray(row.fallback_providers) && row.fallback_providers.every((value) => typeof value === 'string') ? { fallback_providers: row.fallback_providers } : {}) }
      }) }
    }
    return { ...(registry ?? { supported: false, configured, effective: null, available: false, fixed_model_active: false,
      blocked_reason: 'Delegation modes are unavailable. Update or reconnect Hermes Agent.', backends: [{ name: configured, label: configured, description: '', available: false, reason: 'Reconnect Hermes Agent.' }], profiles: [] }),
      model_map: block('model_map', 'options'), profile_routes: block('profile_routes', 'profiles') }
  }

  private async selectDelegationBackend(profileHome: string, backend: string): Promise<void> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) throw new ConfigUnavailable('Delegation settings are unavailable')
    await sidecar.call('aux.delegation_backend', { profile_home: profileHome, config_path: this.path(profileHome), backend })
    this.invalidate(profileHome)
  }

  /** Shares the existing per-config write queue with every model and settings edit. */
  async setDelegation(profileHome: string, write: DelegationWrite): Promise<void> {
    await this.update(profileHome, async (config) => {
      const sidecar = this.deps.sidecar()
      if (!sidecar) throw new ConfigUnavailable('Delegation settings are unavailable')
      if (write.action === 'backend') {
        await this.selectDelegationBackend(profileHome, write.backend)
        return false
      }
      const section = dict(config.delegation)
      const blocks = dict(section.backends)
      const block = { ...write.block, ...(write.block.options ? { options: write.block.options.map((row) => {
        const [provider, model] = auxiliarySelection(row.provider ?? '', row.model ?? '')
        return { ...row, provider, model }
      }) } : {}) }
      const validated = await sidecar.call('aux.delegation_routes', { profile_home: profileHome, backend: write.backend, block, current: dict(blocks[write.backend]) })
      config.delegation = { ...section, backends: { ...blocks, [write.backend]: validated.block } }
    })
  }

  async resetDelegation(profileHome: string, config: Config): Promise<void> {
    const state = await this.delegation(profileHome, config)
    if (!state.supported) {
      if ((str(dict(config.delegation).backend) || 'default') !== 'default') throw new ConfigUnavailable('Update Hermes Agent to restore the saved delegation backend')
      return
    }
    await this.selectDelegationBackend(profileHome, 'default')
    config.delegation = { ...dict(config.delegation), backend: 'default' }
  }

  /** TAL-901: the personalities the profile's Agent offers for its config; throws when the Agent cannot list them. */
  async agentPersonalities(profileHome: string): Promise<PersonalityRow[]> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) throw new ConfigUnavailable('Hermes Agent sidecar is not running; personalities are unavailable')
    return (await sidecar.call('personalities.list', { config: await this.read(profileHome) })).personalities
  }

  /** The Agent's personalities to list and select from; the config's own block only while the sidecar cannot list them. */
  async personalities(profileHome: string): Promise<PersonalityRow[]> {
    try {
      return await this.agentPersonalities(profileHome)
    } catch {
      return configPersonalities(await this.read(profileHome))
    }
  }

  invalidate(profileHome?: string): void {
    if (profileHome) this.cache.delete(this.path(profileHome))
    else this.cache.clear()
  }
}

/** Settings `provider_cost_budget` → positive number or null. */
export function coerceProviderCostBudgetValue(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(str(raw).trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

// ── model section helpers ──────────────────────────────────────────────

export function resolveProviderAlias(name: unknown): string {
  const raw = str(name).trim().toLowerCase()
  if (!raw) return ''
  return PROVIDER_ALIASES[raw] ?? raw
}

/** Python `_canonicalise_provider_id`: fold case/underscores, then aliases that land on a known id. */
/**
 * Python `_provider_identity`: one comparable identity for "do these names mean the same provider?" (`x-ai` and `xai`
 * agree). Never used as a card id — `canonicaliseProviderId` keeps `x-ai` because cards are keyed by it.
 */
export function providerIdentity(name: unknown): string {
  const slug = canonicaliseProviderId(name)
  if (!slug) return ''
  return resolveProviderAlias(slug) || slug
}

export function canonicaliseProviderId(name: unknown): string {
  const raw = str(name).trim().toLowerCase().replaceAll('_', '-')
  if (!raw) return ''
  if (raw in PROVIDER_DISPLAY || raw in PROVIDER_MODELS) return raw
  const resolved = resolveProviderAlias(raw)
  if (resolved && (resolved in PROVIDER_DISPLAY || resolved in PROVIDER_MODELS || resolved === LOCAL_RUNTIME_PROVIDER)) return resolved
  return raw
}

export function customProviderSlug(name: unknown): string {
  const raw = str(name).trim().toLowerCase()
  if (!raw) return ''
  if (raw.startsWith('custom:')) return raw
  const slug = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-')
  return slug ? `custom:${slug}` : ''
}

function slugRestLooksLikeHostPort(rest: string): boolean {
  const idx = rest.lastIndexOf(':')
  if (idx <= 0) return false
  return /^\d{1,5}$/.test(rest.slice(idx + 1))
}

/** Python `_parse_provider_qualified_model_id`: `@provider:model` → `[model, provider]`. */
export function parseProviderQualifiedModel(modelId: unknown): [string, string] | null {
  const candidate = str(modelId).trim()
  if (!candidate.startsWith('@') || !candidate.includes(':')) return null
  const inner = candidate.slice(1)
  const cut = inner.lastIndexOf(':')
  let providerHint = inner.slice(0, cut)
  let bareModel = inner.slice(cut + 1)
  if (providerHint.startsWith('custom:') && (providerHint.split(':').length - 1) >= 2) {
    const rest = providerHint.slice('custom:'.length)
    if (!slugRestLooksLikeHostPort(rest)) {
      const at = providerHint.lastIndexOf(':')
      bareModel = `${providerHint.slice(at + 1)}:${bareModel}`
      providerHint = providerHint.slice(0, at)
    }
  } else if (!(providerHint in PROVIDER_MODELS) && !(providerHint in PROVIDER_DISPLAY) && !providerHint.startsWith('custom:')) {
    const first = inner.indexOf(':')
    providerHint = inner.slice(0, first)
    bareModel = inner.slice(first + 1)
  }
  return [bareModel, providerHint]
}

export function customProviderEntries(config: Config): Dict[] {
  const entries = config.custom_providers
  return Array.isArray(entries) ? entries.filter(isDict) : []
}

export function configuredModelIds(raw: unknown): string[] {
  const candidates: unknown[] = isDict(raw) ? Object.keys(raw) : Array.isArray(raw) ? raw : []
  const ids: string[] = []
  for (const item of candidates) {
    const candidate = isDict(item) ? (item.id ?? item.model ?? item.name) : item
    const id = str(candidate).trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

export function configuredModelOptions(raw: unknown): { id: string; label: string }[] {
  const labels = new Map<string, string>()
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isDict(item)) continue
      const id = str(item.id ?? item.model ?? item.name).trim()
      if (!id || labels.has(id)) continue
      labels.set(id, str(item.label).trim() || id)
    }
  }
  return configuredModelIds(raw).map((id) => ({ id, label: labels.get(id) ?? id }))
}

export function effectiveDefaultModel(config: Config, env: Record<string, string | undefined>): string {
  let model = (env.HERMES_WEBUI_DEFAULT_MODEL ?? '').trim()
  const modelCfg = config.model
  if (typeof modelCfg === 'string') model = modelCfg.trim()
  else if (isDict(modelCfg)) {
    const d = str(modelCfg.default).trim()
    if (d) model = d
  }
  for (const name of ['HERMES_MODEL', 'OPENAI_MODEL', 'LLM_MODEL']) {
    const v = (env[name] ?? '').trim()
    if (v) return v
  }
  return model
}

export function modelSection(config: Config): Dict {
  return dict(config.model)
}

/** Python `_resolve_configured_provider_id` (simplified): heal `local`, keep custom slugs, alias the rest. */
export function activeProviderFromConfig(config: Config): string | null {
  const model = modelSection(config)
  let provider = str(model.provider).trim().toLowerCase()
  if (!provider) return null
  if (provider === 'local') provider = 'custom'
  if (provider.startsWith('custom:')) return provider
  const named = customProviderEntries(config).find((e) => customProviderSlug(e.name) === customProviderSlug(provider) || str(e.name).trim().toLowerCase() === provider)
  if (named) return customProviderSlug(named.name) || 'custom'
  return canonicaliseProviderId(provider) || provider
}

// ── max_tokens ────────────────────────────────────────────────────────

function positiveInt(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const n = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(str(raw), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

export interface MaxTokensStatus { max_tokens: number | null; max_tokens_effective: number | null; max_tokens_fallback: number | null }

export function maxTokensStatus(config: Config): MaxTokensStatus {
  const root = positiveInt(config.max_tokens)
  const fallback = config.max_tokens === undefined || config.max_tokens === null ? positiveInt(dict(config.agent).max_tokens) : null
  return { max_tokens: root, max_tokens_effective: root ?? fallback, max_tokens_fallback: fallback }
}

export async function setMaxTokens(store: AgentConfig, home: string, value: unknown): Promise<MaxTokensStatus> {
  const raw = typeof value === 'string' ? value.trim() : value
  const clear = raw === null || raw === undefined || raw === ''
  const parsed = positiveInt(raw)
  if (!clear && parsed === null) return maxTokensStatus(await store.read(home))
  const config = await store.update(home, (c) => {
    if (clear) {
      if (!('max_tokens' in c)) return false
      Reflect.deleteProperty(c, 'max_tokens')
    } else c.max_tokens = parsed
  })
  return maxTokensStatus(config)
}

// ── reasoning ─────────────────────────────────────────────────────────

export interface ReasoningStatus { show_reasoning: boolean; reasoning_effort: string; supported_efforts: string[]; supports_reasoning_effort: boolean; supports_thinking_toggle: boolean; supports_session_scope: boolean }

export type EffortsResolver = (model: string, provider: string, baseUrl: string) => Promise<string[]>

/** Python `_KNOWN_REASONING_PROVIDERS`: providers whose models take supra-`xhigh` levels even when unresolved. */
const KNOWN_REASONING_PROVIDERS = new Set(['anthropic', 'claude', 'anthropic-claude', 'openai', 'openai-api', 'openai-codex', 'azure', 'azure-openai', 'azure-foundry', 'bedrock', 'aws-bedrock', 'vertex', 'google-vertex', 'gemini', 'google', 'google-gemini', 'deepseek', 'x-ai', 'xai', 'grok', 'copilot', 'github-copilot', 'openrouter'])

/**
 * Python `coerce_reasoning_effort_for_model` (ceiling ladder, `none` passthrough). With no resolved capability list a
 * `max`/`ultra` level degrades to `xhigh` unless the provider is known reasoning-capable, so an unknown or custom
 * endpoint never receives a supra-ceiling level.
 */
export function coerceReasoningEffort(effort: string, supported: string[], provider = ''): string {
  const raw = effort.trim().toLowerCase()
  if (!raw) return ''
  if (raw === 'none') return 'none'
  if (!(VALID_REASONING_EFFORTS as readonly string[]).includes(raw)) return ''
  const levels = supported.filter((e) => e !== 'none')
  if (!levels.length) {
    const ladder = VALID_REASONING_EFFORTS as readonly string[]
    const supra = ladder.slice(ladder.indexOf('xhigh') + 1)
    if (supra.includes(raw) && !KNOWN_REASONING_PROVIDERS.has(resolveProviderAlias(provider))) return 'xhigh'
    return raw
  }
  if (levels.includes(raw)) return raw
  const ladder = VALID_REASONING_EFFORTS as readonly string[]
  for (let i = ladder.indexOf(raw) - 1; i >= 0; i -= 1) {
    const level = ladder[i]
    if (level && levels.includes(level)) return level
  }
  return raw
}

/** The Web display preference, shared by the settings response and native-owner watches. */
export function showReasoning(config: Config): boolean {
  const display = dict(config.display)
  const webui = dict(dict(display.platforms).webui).show_reasoning
  const boolean = (value: unknown): boolean | undefined => {
    if (typeof value === 'boolean') return value
    if (typeof value !== 'string') return undefined
    const normalized = value.trim().toLowerCase()
    if (['true', 'on', 'yes', '1'].includes(normalized)) return true
    if (['false', 'off', 'no', '0'].includes(normalized)) return false
    return undefined
  }
  return boolean(webui) ?? boolean(display.show_reasoning) ?? true
}

export async function reasoningStatus(config: Config, resolve: EffortsResolver, opts: { model?: string | null; provider?: string | null; baseUrl?: string | null } = {}): Promise<ReasoningStatus> {
  const agent = dict(config.agent)
  let model = str(opts.model).trim()
  let provider = str(opts.provider).trim()
  let baseUrl = str(opts.baseUrl).trim()
  if (!model) {
    const m = modelSection(config)
    model = str(m.default).trim()
    if (!provider && m.provider) provider = str(m.provider).trim()
    if (!baseUrl && m.base_url) baseUrl = str(m.base_url).trim()
  }
  const supported = model ? await resolve(model, provider, baseUrl) : []
  return {
    show_reasoning: showReasoning(config),
    reasoning_effort: coerceReasoningEffort(str(agent.reasoning_effort), supported, provider),
    supported_efforts: supported,
    supports_reasoning_effort: supported.length > 0,
    supports_thinking_toggle: supported.length > 0,
    supports_session_scope: true,
  }
}

export function validReasoningEffort(effort: string): boolean {
  const raw = effort.trim().toLowerCase()
  return !raw || raw === 'none' || (VALID_REASONING_EFFORTS as readonly string[]).includes(raw)
}

// ── personalities ─────────────────────────────────────────────────────

export type PersonalityRow = SidecarResult<'personalities.list'>['personalities'][number]

/** The pre-TAL-901 reading of `agent.personalities` alone, kept only for when the sidecar cannot list the Agent's. */
export function configPersonalities(config: Config): PersonalityRow[] {
  const raw = dict(config.agent).personalities
  if (!isDict(raw)) return []
  return Object.entries(raw).map(([name, value]) => {
    if (isDict(value)) {
      const parts = [str(value.system_prompt) || str(value.prompt)]
      if (value.tone) parts.push(`Tone: ${str(value.tone)}`)
      if (value.style) parts.push(`Style: ${str(value.style)}`)
      return { name, description: str(value.description), prompt: parts.filter(Boolean).join('\n') }
    }
    const text = str(value)
    return { name, description: text.slice(0, 80) + (text.length > 80 ? '...' : ''), prompt: text }
  })
}

/** The personality `name` selects, compared case-folded as the Agent does; undefined when there is none. */
export function findPersonality(rows: PersonalityRow[], name: string): PersonalityRow | undefined {
  const key = name.trim().toLowerCase()
  return key ? rows.find((row) => row.name.toLowerCase() === key) : undefined
}

// ── advanced model options / auxiliary slots ──────────────────────────

function coerceOptionalPositiveInt(value: unknown, field: string): number | '' | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && !value.trim()) return ''
  const n = typeof value === 'number' ? value : Number(str(value).trim())
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${field} must be a positive integer`)
  return n
}

/** Python `_apply_advanced_model_options` (in place). */
export function applyAdvancedModelOptions(target: Dict, advanced: unknown): void {
  if (advanced === null || advanced === undefined) return
  if (!isDict(advanced)) throw new Error('advanced model options must be an object')
  if ('base_url' in advanced) {
    const base = str(advanced.base_url).trim().replace(/\/+$/, '')
    if (base) target.base_url = base
    else Reflect.deleteProperty(target, 'base_url')
  }
  for (const field of ['timeout', 'download_timeout', 'max_concurrency']) {
    if (!(field in advanced)) continue
    const coerced = coerceOptionalPositiveInt(advanced[field], field)
    if (coerced === '') Reflect.deleteProperty(target, field)
    else if (coerced !== null) target[field] = coerced
  }
  if ('extra_body' in advanced) {
    let extra: unknown = advanced.extra_body
    if (typeof extra === 'string') {
      const text = extra.trim()
      try { extra = text ? JSON.parse(text) : {} } catch { throw new Error('extra_body must be valid JSON') }
    }
    if (extra === null || extra === undefined || extra === '') Reflect.deleteProperty(target, 'extra_body')
    else if (isDict(extra)) {
      if (Object.keys(extra).length) target.extra_body = extra
      else Reflect.deleteProperty(target, 'extra_body')
    } else throw new Error('extra_body must be a JSON object')
  }
  if ('service_tier' in advanced) {
    const tier = str(advanced.service_tier).trim().toLowerCase()
    if (!tier || tier === 'default') Reflect.deleteProperty(target, 'service_tier')
    else if (tier === 'priority' || tier === 'ultrafast') target.service_tier = tier
    else throw new Error('service_tier must be one of: default, priority, ultrafast')
  }
  if (advanced.api_key_clear) Reflect.deleteProperty(target, 'api_key')
  const apiKey = str(advanced.api_key).trim()
  if (apiKey) target.api_key = apiKey
}

export function publicAdvancedModelOptions(modelCfg: Dict): Dict {
  return {
    base_url: str(modelCfg.base_url).trim(),
    timeout: modelCfg.timeout ?? '',
    download_timeout: modelCfg.download_timeout ?? '',
    max_concurrency: modelCfg.max_concurrency ?? '',
    extra_body: isDict(modelCfg.extra_body) ? modelCfg.extra_body : {},
    api_key_set: Boolean(str(modelCfg.api_key).trim()),
  }
}

/** Effective configured endpoint, shared by speed display and validation after model selection. */
export function modelBaseUrl(config: Config, provider: string): string {
  const pid = canonicaliseProviderId(provider)
  const model = modelSection(config)
  if (canonicaliseProviderId(model.provider) === pid && str(model.base_url).trim()) return str(model.base_url).trim()
  const providers = dict(config.providers)
  const key = Object.keys(providers).find((k) => canonicaliseProviderId(k) === pid)
  const base = str(dict(key ? providers[key] : null).base_url).trim()
  if (base) return base
  const custom = customProviderEntries(config).find((cp) => customProviderSlug(cp.name) === pid)
  return str(custom?.base_url).trim()
}

function auxTaskPayload(slot: AuxSlot, entry: unknown, reasoning: AuxReasoning | undefined): Dict {
  const e = dict(entry)
  return {
    task: slot.key,
    provider: str(e.provider).trim() || 'auto',
    model: str(e.model).trim(),
    base_url: str(e.base_url).trim(),
    timeout: e.timeout ?? '',
    download_timeout: e.download_timeout ?? '',
    max_concurrency: e.max_concurrency ?? '',
    extra_body: isDict(e.extra_body) ? e.extra_body : {},
    api_key_set: Boolean(str(e.api_key).trim()),
    label: slot.label,
    description: slot.description,
    inherit_from: slot.inherit_from,
    reasoning_effort: slot.reasoning_effort,
    reasoning: reasoning ?? { saved: savedEffort(e), effective: slot.reasoning_effort, inherited: savedEffort(e) === null, default_source: defaultSource(slot.key), options: [], unavailable: 'agent' },
    effective: slot.effective,
  }
}

// ── auxiliary reasoning (TAL-1285) ────────────────────────────────────

/** The levels the Agent offers for a model on a provider; null when it could not say. */
export type AuxEfforts = (model: string, provider: string, baseUrl: string) => Promise<string[] | null>
export interface AuxReasoning { saved: string | null; effective: string | null; inherited: boolean; default_source: 'provider' | 'parent'; options: string[]; unavailable: 'slot' | 'model' | 'agent' | null }

const defaultSource = (task: string): AuxReasoning['default_source'] => (task === DELEGATION_TASK ? 'parent' : 'provider')
/** A slot's block: the top-level `delegation` section for the subagent slot (TAL-1273), else `auxiliary.<task>`. */
const auxEntry = (config: Config, task: string): Dict => dict(task === DELEGATION_TASK ? config.delegation : dict(config.auxiliary)[task])
/** The effort saved in a slot's block (YAML `false` is `none`); null when none is saved and the slot inherits its default. */
const savedEffort = (entry: Dict): string | null => (entry.reasoning_effort === false ? 'none' : str(entry.reasoning_effort).trim().toLowerCase() || null)
const isAutoRoute = (route: Dict): boolean => (str(route.provider).trim() || 'auto') === 'auto' && !str(route.model).trim()

/** The route a slot's effort applies to: its pin, else the slot it inherits (TAL-800), else the main chat model. */
function effortRoute(config: Config, entry: Dict, effective: AuxSlot['effective']): { provider: string; model: string; base_url: string } {
  const pick = (route: Dict) => ({ provider: str(route.provider).trim(), model: str(route.model).trim(), base_url: str(route.base_url).trim() })
  if (!isAutoRoute(entry)) return pick(entry)
  if (effective && !isAutoRoute(effective)) return pick(effective)
  const main = modelSection(config)
  return pick({ provider: main.provider, model: main.default ?? main.name, base_url: main.base_url })
}

/** What a slot may save: the Agent's levels for its route plus `none`, or why it may save nothing. Unknown fails closed. */
async function effortOptions(config: Config, slot: AuxSlot, resolve: AuxEfforts): Promise<Pick<AuxReasoning, 'options' | 'unavailable'>> {
  if (slot.takes_reasoning === false) return { options: [], unavailable: 'slot' }
  if (slot.takes_reasoning !== true) return { options: [], unavailable: 'agent' }
  const route = effortRoute(config, auxEntry(config, slot.key), slot.effective)
  if (!route.model) return { options: [], unavailable: 'model' }
  const efforts = await resolve(route.model, route.provider === 'auto' ? '' : route.provider, route.base_url)
  if (efforts === null) return { options: [], unavailable: 'agent' }
  const levels = [...new Set(efforts.map((e) => e.trim().toLowerCase()).filter((e) => e && e !== 'none'))]
  return levels.length ? { options: [...levels, 'none'], unavailable: null } : { options: [], unavailable: 'model' }
}

/** Every slot's reasoning control, reading each distinct route's capability once. */
export async function auxiliaryReasoning(config: Config, slots: AuxSlot[], resolve: AuxEfforts): Promise<Map<string, AuxReasoning>> {
  const reads = new Map<string, Promise<string[] | null>>()
  const once: AuxEfforts = (model, provider, baseUrl) => {
    const key = [model, provider, baseUrl].join('\0')
    const read = reads.get(key) ?? resolve(model, provider, baseUrl)
    reads.set(key, read)
    return read
  }
  return new Map(await Promise.all(slots.map(async (slot): Promise<[string, AuxReasoning]> => {
    const saved = savedEffort(auxEntry(config, slot.key))
    return [slot.key, { saved, effective: slot.reasoning_effort, inherited: saved === null, default_source: defaultSource(slot.key), ...(await effortOptions(config, slot, once)) }]
  })))
}

/**
 * Applies a write's effort to the slot's (already re-routed) block. `requested` undefined: a route change keeps a
 * still-supported effort, steps it down the ladder where it can, and clears it otherwise; a slot that ignores efforts or
 * an Agent that cannot say leaves it alone. null clears the override. A level outside the route's options throws, so
 * the caller's update writes nothing.
 */
async function applyAuxEffort(config: Config, slot: AuxSlot, requested: string | null | undefined, resolve: AuxEfforts): Promise<void> {
  const saved = savedEffort(auxEntry(config, slot.key))
  if (requested === undefined && saved === null) return
  if (requested === null) {
    Reflect.deleteProperty(auxEntry(config, slot.key), 'reasoning_effort')
    return
  }
  const { options, unavailable } = await effortOptions(config, slot, resolve)
  const block = (): Dict => {
    if (slot.key === DELEGATION_TASK) return (config.delegation = auxEntry(config, slot.key))
    const aux = (config.auxiliary = dict(config.auxiliary))
    return (aux[slot.key] = dict(aux[slot.key]))
  }
  if (requested === undefined) {
    if (unavailable === 'slot' || unavailable === 'agent' || saved === null) return
    const next = coerceReasoningEffort(saved, options)
    if (options.includes(next)) block().reasoning_effort = next
    else Reflect.deleteProperty(block(), 'reasoning_effort')
    return
  }
  if (!options.includes(requested)) {
    throw new Error(unavailable ? `${slot.label} cannot use a reasoning effort here` : `Reasoning effort '${requested}' is not supported for ${slot.label}. Valid: ${options.join(', ')}`)
  }
  block().reasoning_effort = requested
}

export function auxiliaryModels(config: Config, tiers: SpeedTier[], slots: AuxSlot[], reasoning: Map<string, AuxReasoning>): { tasks: Dict[]; main: Dict } {
  const modelCfg = modelSection(config)
  const aux = dict(config.auxiliary)
  const mainProvider = str(modelCfg.provider).trim()
  const mainModel = str(modelCfg.default ?? modelCfg.name).trim()
  return {
    tasks: slots.map((slot) => auxTaskPayload(slot, slot.key === DELEGATION_TASK ? config.delegation : aux[slot.key], reasoning.get(slot.key))),
    main: {
      provider: mainProvider,
      model: mainModel,
      supports_fast_tier: tiers.some((t) => t.service_tier === 'priority'),
      supported_speed_tiers: tiers,
      service_tier: tiers.find((t) => t.service_tier === str(modelCfg.service_tier).trim().toLowerCase())?.service_tier ?? 'default',
      ...publicAdvancedModelOptions(modelCfg),
    },
  }
}

/** A picked `/api/models` id (`@provider:model`) splits into its provider and bare model; a qualified id must agree with an explicit provider. */
function auxiliarySelection(providerRaw: string, modelRaw: string): [string, string] {
  const provider = providerRaw.trim() || 'auto'
  const model = modelRaw.trim()
  if (!model.startsWith('@')) return [provider, model]
  const parsed = parseProviderQualifiedModel(model)
  if (!parsed?.[0] || !parsed[1] || (provider !== 'auto' && canonicaliseProviderId(provider) !== canonicaliseProviderId(parsed[1]))) {
    throw new Error('provider-qualified auxiliary model must match the selected provider and include a model name')
  }
  return [provider === 'auto' ? parsed[1] : provider, parsed[0]]
}

const isCustomProvider = (provider: unknown): boolean => { const p = str(provider).trim(); return p === 'custom' || p.startsWith('custom:') }

/**
 * TAL-1273: the Agent's subagent slot. `delegate_task` reads top-level `delegation`, where Auto (inherit the parent) is
 * stored as empty strings, and a `base_url` outranks `provider`. Only `custom` keeps a direct endpoint; any other pick
 * clears its `base_url` and `api_mode` so the child really runs on the picked provider.
 */
const DELEGATION_TASK = 'delegation'
function delegationRoute(entry: unknown, provider: string, model: string, advanced: unknown): Dict {
  const route: Dict = { ...dict(entry), provider: provider === 'auto' ? '' : provider, model }
  if (provider !== 'custom') Object.assign(route, { base_url: '', api_mode: '' })
  if (isDict(advanced)) {
    // The section has no timeout, concurrency, extra_body, or speed keys; only the endpoint and its key apply.
    applyAdvancedModelOptions(route, Object.fromEntries(['base_url', 'api_key', 'api_key_clear'].filter((k) => k in advanced).map((k) => [k, advanced[k]])))
  }
  return route
}

/**
 * One slot's route and reasoning effort, written together (TAL-1285). Without `provider` and `model`, a write that names
 * a `reasoning_effort` changes only the effort and keeps the route; otherwise an omitted provider/model means Auto.
 * Reset All returns every slot to Auto and clears every saved effort, as the Agent's picker does.
 */
export interface AuxWrite { provider?: string | undefined; model?: string | undefined; reasoning_effort?: string | null | undefined; advanced?: unknown }

export async function setAuxiliaryModel(store: AgentConfig, home: string, task: string, write: AuxWrite, resolve: AuxEfforts): Promise<{ ok: true; task: string; provider: string; model: string }> {
  const listing = await store.auxiliarySlots(home)
  const slots = listing.slots.map((slot) => slot.key)
  if (task !== '__reset__' && !slots.includes(task)) throw new Error(`Unknown auxiliary task slot: '${task}'. Valid: [${slots.map((s) => `'${s}'`).join(', ')}]`)
  const requested = write.reasoning_effort === undefined ? undefined : str(write.reasoning_effort).trim().toLowerCase() || null
  if (requested && !validReasoningEffort(requested)) throw new Error(`Unknown reasoning effort '${requested}'. Valid: none, ${VALID_REASONING_EFFORTS.join(', ')}.`)
  const keepRoute = task !== '__reset__' && write.provider === undefined && write.model === undefined && requested !== undefined
  let [provider, model] = task === '__reset__' || keepRoute ? ['auto', ''] : auxiliarySelection(write.provider ?? '', write.model ?? '')
  const advanced = write.advanced
  await store.update(home, async (config) => {
    const aux = dict(config.auxiliary)
    // Auto clears the override, including a custom endpoint's base_url (which would otherwise keep routing there).
    const autoSlot = (entry: unknown): Dict => { const slot: Dict = { ...dict(entry), provider: 'auto', model: '' }; Reflect.deleteProperty(slot, 'base_url'); return slot }
    const slot = listing.slots.find((s) => s.key === task)
    if (keepRoute && slot) {
      if (task === DELEGATION_TASK && !(await store.delegation(home, config)).fixed_model_active) throw new ConfigUnavailable('The selected delegation mode does not use the fixed model')
      const route = auxEntry(config, task)
      ;[provider, model] = [str(route.provider).trim() || 'auto', str(route.model).trim()]
      await applyAuxEffort(config, slot, requested, resolve)
      return
    }
    if (task === '__reset__') {
      await store.resetDelegation(home, config)
      for (const retired of RETIRED_AUX_TASK_SLOTS) Reflect.deleteProperty(aux, retired)
      // A route block the Agent neither lists nor owns is a disabled or removed plugin's task: Reset All clears it too, so
      // re-enabling the plugin does not bring back a pin the user reset. Unknown ownership (no listing) leaves it alone.
      const { reserved } = listing
      const orphans = reserved ? Object.keys(aux).filter((key) => isDict(aux[key]) && !slots.includes(key) && !reserved.includes(key)) : []
      const reset = (entry: Dict): Dict => { Reflect.deleteProperty(entry, 'reasoning_effort'); return entry }
      for (const key of [...slots, ...orphans]) if (key !== DELEGATION_TASK) aux[key] = reset(autoSlot(aux[key]))
      config.auxiliary = aux
      if (slots.includes(DELEGATION_TASK)) config.delegation = reset(delegationRoute(config.delegation, 'auto', '', null))
      return
    }
    if (task === DELEGATION_TASK) {
      const state = await store.delegation(home, config)
      if (!state.fixed_model_active) throw new ConfigUnavailable(state.blocked_reason ?? 'The selected delegation mode does not use the fixed model')
      config.delegation = delegationRoute(config.delegation, provider, model, advanced)
      if (slot) await applyAuxEffort(config, slot, requested, resolve)
      return
    }
    const entry = provider === 'auto' && !model ? autoSlot(aux[task]) : dict(aux[task])
    if (isCustomProvider(entry.provider) && !isCustomProvider(provider)) Reflect.deleteProperty(entry, 'base_url')
    entry.provider = provider
    entry.model = model
    if (isCustomProvider(provider)) {
      let base: string | null = null
      if (provider.startsWith('custom:')) {
        const match = customProviderEntries(config).find((e) => customProviderSlug(e.name) === provider)
        base = match ? str(match.base_url).trim() || null : null
        if (!base) Reflect.deleteProperty(entry, 'base_url')
      }
      if (base) entry.base_url = base.replace(/\/+$/, '')
    }
    if (advanced !== null && advanced !== undefined) {
      try {
        applyAdvancedModelOptions(entry, advanced)
      } catch (error) {
        throw new Error((error as Error).message.replace('advanced model options', 'advanced auxiliary options'))
      }
    }
    aux[task] = entry
    config.auxiliary = aux
    if (slot) await applyAuxEffort(config, slot, requested, resolve)
  })
  return { ok: true, task, provider, model }
}

/** Python `set_hermes_default_model`: persist the bare model + provider (never `@provider:` or `local`). */
export async function setDefaultModel(store: AgentConfig, home: string, modelId: unknown, providerRaw: unknown, advanced: unknown): Promise<{ ok: true; model: string; provider: string | null }> {
  const selected = str(modelId).trim()
  if (!selected) throw new Error('model is required')
  let persistedModel = selected
  let persistedProvider = ''
  await store.update(home, async (config) => {
    const modelCfg = modelSection(config)
    const previousProvider = str(modelCfg.provider).trim()
    const requested = str(providerRaw).trim()
    const parsed = parseProviderQualifiedModel(selected)
    let resolvedModel = selected
    let resolvedProvider = ''
    let resolvedBase: string | null = null
    // Python `_get_provider_base_url`: `providers.<id>.base_url`, else the model block's base_url for the same provider.
    const providerBaseUrl = (pid: string): string | null => {
      const explicit = str(dict(dict(config.providers)[pid]).base_url).trim().replace(/\/+$/, '')
      if (explicit) return explicit
      if (previousProvider.toLowerCase() === pid.trim().toLowerCase()) return str(modelCfg.base_url).trim().replace(/\/+$/, '') || null
      return null
    }
    if (parsed) {
      resolvedModel = parsed[0]
      resolvedProvider = parsed[1]
      if (resolvedProvider.startsWith('custom:')) {
        const entry = customProviderEntries(config).find((e) => customProviderSlug(e.name) === resolvedProvider)
        resolvedBase = entry ? str(entry.base_url).trim() || null : providerBaseUrl(resolvedProvider)
      } else {
        resolvedBase = providerBaseUrl(resolvedProvider)
      }
    } else {
      const entry = customProviderEntries(config).find((e) => str(e.model).trim() === selected || configuredModelIds(e.models).includes(selected))
      if (entry) {
        resolvedProvider = customProviderSlug(entry.name) || 'custom'
        resolvedBase = str(entry.base_url).trim() || null
      } else if (selected.includes('/')) {
        // Python `_resolve_model_provider` for a `vendor/model` id under a configured provider: OpenRouter keeps the
        // full path, portals keep the namespaced id, a prefix equal to the provider is stripped, and a foreign known
        // vendor prefix routes through OpenRouter (never for a custom proxy provider).
        const prefix = selected.slice(0, selected.indexOf('/'))
        const bare = selected.slice(selected.indexOf('/') + 1)
        const canonPrev = canonicaliseProviderId(previousProvider)
        const isCustomPrev = previousProvider.toLowerCase() === 'custom' || previousProvider.toLowerCase().startsWith('custom:')
        if (previousProvider === 'openrouter') {
          resolvedProvider = 'openrouter'
        } else if (canonPrev && PORTAL_PROVIDERS.has(canonPrev)) {
          resolvedProvider = previousProvider
        } else if (previousProvider && prefix === previousProvider) {
          resolvedModel = bare
          resolvedProvider = previousProvider
        } else if (canonicaliseProviderId(prefix) in PROVIDER_MODELS && canonicaliseProviderId(prefix) !== canonPrev && !isCustomPrev) {
          resolvedProvider = 'openrouter'
        }
      }
    }
    persistedModel = resolvedModel.trim() || selected
    persistedProvider = (requested || resolvedProvider || previousProvider).trim()
    const overrideWon = Boolean(requested && requested !== resolvedProvider)
    if (persistedProvider.toLowerCase() === 'local') persistedProvider = 'custom'
    modelCfg.default = persistedModel
    if (persistedProvider) modelCfg.provider = persistedProvider
    if (resolvedBase && !overrideWon) modelCfg.base_url = resolvedBase.replace(/\/+$/, '')
    else if (persistedProvider !== previousProvider) {
      if (persistedProvider === 'openai') modelCfg.base_url = 'https://api.openai.com/v1'
      else Reflect.deleteProperty(modelCfg, 'base_url')
    }
    applyAdvancedModelOptions(modelCfg, advanced)
    config.model = modelCfg
    if (modelCfg.service_tier) {
      const [tiers] = await store.speedTiers(home, config, [{ model: persistedModel, provider: persistedProvider }])
      if (!tiers!.some((t) => t.service_tier === modelCfg.service_tier)) {
        if (dict(advanced).service_tier) throw new Error('service_tier is not supported for this model and route')
        Reflect.deleteProperty(modelCfg, 'service_tier')
      }
    }
  })
  return { ok: true, model: persistedModel, provider: persistedProvider || null }
}
