/**
 * The Agent's per-profile `config.yaml`, read and written through the sidecar
 * (`config.get` / `config.set`) so the server needs no YAML parser. Reads are
 * memoised on the file's mtime+size; every write evicts the entry.
 *
 * Policy helpers (model section, reasoning, max_tokens, auxiliary slots,
 * personalities) port Python `api/config.py`.
 */
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import type { SidecarLike } from '../sidecar/client.js'
import { PORTAL_PROVIDERS, PROVIDER_ALIASES, PROVIDER_DISPLAY, PROVIDER_MODELS, VALID_REASONING_EFFORTS, AUXILIARY_TASK_CATALOG, AUX_TASK_SLOTS, RETIRED_AUX_TASK_SLOTS } from '../providers/tables.js'
import { str } from '../util.js'

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
      const st = statSync(this.path(profileHome, opts), { bigint: true })
      return `${String(st.mtimeNs)}:${String(st.size)}:${String(st.ino)}`
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
  peek(profileHome: string): Config | null {
    let key: string
    try { key = this.statKey(profileHome) } catch { return null }
    const hit = this.cache.get(this.path(profileHome))
    if (hit?.key === key) return hit.config
    if (key === 'missing') return {}
    // A changed file invalidates the snapshot: callers gate on `null` (fail closed) until the matching read lands.
    void this.read(profileHome).catch(() => undefined)
    return null
  }

  /** Read-modify-write under a per-file lock (homes sharing an `HERMES_CONFIG_PATH` override serialise); `mutate` returns false to skip the write. */
  async update(profileHome: string, mutate: (config: Config) => unknown, opts: ConfigFileOptions = {}): Promise<Config> {
    const file = this.path(profileHome, opts)
    const prev = this.locks.get(file) ?? Promise.resolve()
    const run = prev.catch(() => undefined).then(async () => {
      const config = await this.read(profileHome, opts)
      if (mutate(config) === false) return config
      const sidecar = this.deps.sidecar()
      if (!sidecar) throw new ConfigUnavailable('Hermes Agent sidecar is not running; config.yaml cannot be written')
      await sidecar.call('config.set', { profile_home: profileHome, config_path: file, config })
      this.cache.delete(file)
      return config
    })
    this.locks.set(file, run)
    return run
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
  if (resolved && (resolved in PROVIDER_DISPLAY || resolved in PROVIDER_MODELS)) return resolved
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

export interface ReasoningStatus { show_reasoning: boolean; reasoning_effort: string; supported_efforts: string[]; supports_reasoning_effort: boolean; supports_thinking_toggle: boolean }

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

export async function reasoningStatus(config: Config, resolve: EffortsResolver, opts: { model?: string | null; provider?: string | null; baseUrl?: string | null } = {}): Promise<ReasoningStatus> {
  const display = dict(config.display)
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
  const showRaw = display.show_reasoning
  return {
    show_reasoning: typeof showRaw === 'boolean' ? showRaw : true,
    reasoning_effort: coerceReasoningEffort(str(agent.reasoning_effort), supported, provider),
    supported_efforts: supported,
    supports_reasoning_effort: supported.length > 0,
    supports_thinking_toggle: supported.length > 0,
  }
}

export function validReasoningEffort(effort: string): boolean {
  const raw = effort.trim().toLowerCase()
  return !raw || raw === 'none' || (VALID_REASONING_EFFORTS as readonly string[]).includes(raw)
}

// ── personalities ─────────────────────────────────────────────────────

export function personalityRows(config: Config): { name: string; description: string }[] {
  const raw = dict(config.agent).personalities
  if (!isDict(raw)) return []
  return Object.entries(raw).map(([name, value]) => {
    let desc = ''
    if (isDict(value)) desc = str(value.description)
    else if (typeof value === 'string') desc = value.slice(0, 80) + (value.length > 80 ? '...' : '')
    return { name, description: desc }
  })
}

/** Python `/api/personality/set` prompt resolution; null when the personality is unknown. */
export function personalityPrompt(config: Config, name: string): string | null {
  const raw = dict(config.agent).personalities
  if (!isDict(raw) || !(name in raw)) return null
  const value = raw[name]
  if (isDict(value)) {
    const parts = [str(value.system_prompt) || str(value.prompt)]
    if (value.tone) parts.push(`Tone: ${str(value.tone)}`)
    if (value.style) parts.push(`Style: ${str(value.style)}`)
    return parts.filter(Boolean).join('\n')
  }
  return str(value)
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
    else if (tier === 'priority') target.service_tier = 'priority'
    else throw new Error('service_tier must be one of: default, priority')
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

export function isOpenAiFamilyProvider(provider: unknown): boolean {
  const resolved = resolveProviderAlias(provider)
  return resolved === 'openai' || resolved === 'openai-api' || resolved === 'openai-codex'
}

/** Python `_main_model_supports_service_tier`: OpenAI-family GPT-5-class models take `priority`. */
export function mainModelSupportsServiceTier(model: unknown, provider: unknown): boolean {
  if (!isOpenAiFamilyProvider(provider)) return false
  const id = str(model).trim().toLowerCase().replace(/^openai\//, '')
  return id.startsWith('gpt-5') || /^o[0-9]/.test(id)
}

function auxTaskPayload(key: string, entry: unknown, label: string, description: string): Dict {
  const e = dict(entry)
  return {
    task: key,
    provider: str(e.provider).trim() || 'auto',
    model: str(e.model).trim(),
    base_url: str(e.base_url).trim(),
    timeout: e.timeout ?? '',
    download_timeout: e.download_timeout ?? '',
    max_concurrency: e.max_concurrency ?? '',
    extra_body: isDict(e.extra_body) ? e.extra_body : {},
    api_key_set: Boolean(str(e.api_key).trim()),
    label,
    description,
  }
}

export function auxiliaryModels(config: Config): { tasks: Dict[]; main: Dict } {
  const modelCfg = modelSection(config)
  const aux = dict(config.auxiliary)
  const mainProvider = str(modelCfg.provider).trim()
  const mainModel = str(modelCfg.default ?? modelCfg.name).trim()
  const supportsFast = mainModelSupportsServiceTier(mainModel, mainProvider)
  return {
    tasks: AUXILIARY_TASK_CATALOG.map((slot) => auxTaskPayload(slot.key, aux[slot.key], slot.label, slot.description)),
    main: {
      provider: mainProvider,
      model: mainModel,
      supports_fast_tier: supportsFast,
      service_tier: supportsFast && str(modelCfg.service_tier).trim().toLowerCase() === 'priority' ? 'priority' : '',
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

export async function setAuxiliaryModel(store: AgentConfig, home: string, task: string, providerRaw: string, modelRaw: string, advanced: unknown): Promise<{ ok: true; task: string; provider: string; model: string }> {
  if (task !== '__reset__' && !AUX_TASK_SLOTS.includes(task)) throw new Error(`Unknown auxiliary task slot: '${task}'. Valid: [${AUX_TASK_SLOTS.map((s) => `'${s}'`).join(', ')}]`)
  const [provider, model] = task === '__reset__' ? ['auto', ''] : auxiliarySelection(providerRaw, modelRaw)
  await store.update(home, (config) => {
    const aux = dict(config.auxiliary)
    // Auto clears the override, including a custom endpoint's base_url (which would otherwise keep routing there).
    const autoSlot = (entry: unknown): Dict => { const slot: Dict = { ...dict(entry), provider: 'auto', model: '' }; Reflect.deleteProperty(slot, 'base_url'); return slot }
    if (task === '__reset__') {
      for (const retired of RETIRED_AUX_TASK_SLOTS) Reflect.deleteProperty(aux, retired)
      for (const slot of AUX_TASK_SLOTS) aux[slot] = autoSlot(aux[slot])
      config.auxiliary = aux
      return
    }
    const slot = provider === 'auto' && !model ? autoSlot(aux[task]) : dict(aux[task])
    if (isCustomProvider(slot.provider) && !isCustomProvider(provider)) Reflect.deleteProperty(slot, 'base_url')
    slot.provider = provider
    slot.model = model
    if (isCustomProvider(provider)) {
      let base: string | null = null
      if (provider.startsWith('custom:')) {
        const match = customProviderEntries(config).find((e) => customProviderSlug(e.name) === provider)
        base = match ? str(match.base_url).trim() || null : null
        if (!base) Reflect.deleteProperty(slot, 'base_url')
      }
      if (base) slot.base_url = base.replace(/\/+$/, '')
    }
    if (advanced !== null && advanced !== undefined) {
      try {
        applyAdvancedModelOptions(slot, advanced)
      } catch (error) {
        throw new Error((error as Error).message.replace('advanced model options', 'advanced auxiliary options'))
      }
    }
    aux[task] = slot
    config.auxiliary = aux
  })
  return { ok: true, task, provider, model }
}

/** Python `set_hermes_default_model`: persist the bare model + provider (never `@provider:` or `local`). */
export async function setDefaultModel(store: AgentConfig, home: string, modelId: unknown, providerRaw: unknown, advanced: unknown): Promise<{ ok: true; model: string; provider: string | null }> {
  const selected = str(modelId).trim()
  if (!selected) throw new Error('model is required')
  let persistedModel = selected
  let persistedProvider = ''
  await store.update(home, (config) => {
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
    if (!mainModelSupportsServiceTier(persistedModel, persistedProvider)) Reflect.deleteProperty(modelCfg, 'service_tier')
    config.model = modelCfg
  })
  return { ok: true, model: persistedModel, provider: persistedProvider || null }
}
