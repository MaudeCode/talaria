/**
 * Provider cards, the model picker catalog, live model lists, quotas and cost
 * history (Python `api/providers.py`, the `/api/models` parts of
 * `api/config.py`, `_handle_live_models`).
 *
 * The Agent's own primitives (registry, auth status, live model ids, account
 * usage) come through the sidecar; the static tables and key detection live
 * here. ponytail: one live-id cache with a 24h TTL replaces the Python
 * publisher/provenance machinery; `refresh()` evicts it.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteText } from '../fs/atomic.js'
import type { SidecarLike } from '../sidecar/client.js'
import { str } from '../util.js'
import { loadEnvFile } from './env-file.js'
import {
  ACCOUNT_USAGE_PROVIDERS, FALLBACK_MODELS, OAUTH_PROVIDERS, PORTAL_PROVIDERS, PROVIDER_DISPLAY, PROVIDER_ENV_VAR, PROVIDER_ENV_VAR_ALIASES, PROVIDER_MODELS, SELF_HOSTED_PROVIDER_IDS,
} from './tables.js'
import {
  activeProviderFromConfig, canonicaliseProviderId, configuredModelIds, configuredModelOptions, customProviderEntries, customProviderSlug, dict, effectiveDefaultModel, isDict,
  isOpenAiFamilyProvider, modelSection, resolveProviderAlias, type AgentConfig, type Config, type Dict,
} from '../config/agent-config.js'

export interface ModelEntry { id: string; label: string; supports_fast_tier?: boolean }
export interface ModelGroup { provider: string; provider_id: string; models: ModelEntry[] }
export interface ModelsCatalog { active_provider: string | null; default_model: string; groups: ModelGroup[]; aliases: Record<string, string>; configured_model_badges: Record<string, { role: string; label: string; provider: string }> }

export interface CatalogDeps {
  sidecar: () => SidecarLike | null
  config: AgentConfig
  env: Record<string, string | undefined>
  now: () => number
  log: (line: string) => void
  /** Settings `provider_cost_budget` (monthly). */
  costBudget: () => number | null
  fetch?: typeof fetch
}

const LIVE_TTL_S = 86_400
const PROVIDERS_TTL_S = 30
const QUOTA_TIMEOUT_MS = 15_000
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key'
const COST_SNAPSHOT_MAX_DAYS = 365

export function displayName(pid: string): string {
  return PROVIDER_DISPLAY[pid] ?? pid.split('-').map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ')
}

/** Python `_format_ollama_label`. */
export function formatOllamaLabel(mid: string): string {
  const [name, variant] = mid.includes(':') ? [mid.slice(0, mid.indexOf(':')), mid.slice(mid.indexOf(':') + 1)] : [mid, '']
  const fmt = (s: string): string => s.replaceAll('-', ' ').replaceAll('_', ' ').split(/\s+/).filter(Boolean).map((t) => {
    const alpha = t.replaceAll('.', '')
    if (/^[A-Za-z]+$/.test(alpha) && t.length <= 3) return t.toUpperCase()
    if (/^[A-Za-z0-9]+$/.test(alpha) && /^\d/.test(alpha)) return t.toUpperCase()
    return t[0]!.toUpperCase() + t.slice(1)
  }).join(' ')
  const label = fmt(name)
  return variant ? `${label} (${fmt(variant)})` : label
}

/** Python `_get_label_for_model`: reuse a known label, else prettify the bare id. */
export function labelForModel(modelId: string, groups: ModelGroup[]): string {
  let lookup = modelId
  if (lookup.startsWith('@') && lookup.includes(':')) lookup = lookup.slice(lookup.indexOf(':') + 1)
  const hasScheme = (s: string): boolean => s.includes('://')
  const norm = (s: string): string => (s.includes('/') && !hasScheme(s) ? s.slice(s.indexOf('/') + 1) : s).replaceAll('-', '.').toLowerCase()
  const target = norm(lookup)
  for (const g of groups) for (const m of g.models) if (m.label && norm(m.id) === target) return m.label
  const bare = lookup.includes('/') && !hasScheme(lookup) ? lookup.slice(lookup.indexOf('/') + 1) : lookup
  return formatOllamaLabel(bare)
}

function looksLikeCodexOauthToken(value: string): boolean {
  const token = value.trim()
  if (!token || token.startsWith('sk-')) return false
  const parts = token.split('.')
  if (parts.length < 2) return false
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
    const auth = claims['https://api.openai.com/auth']
    if (isDict(auth) && Object.keys(auth).length) return true
    return 'chatgpt_account_id' in claims || 'https://api.openai.com/profile' in claims
  } catch {
    return false
  }
}

function valueCountsAsApiKey(pid: string, value: unknown): boolean {
  const text = str(value).trim()
  if (!text) return false
  if (pid === 'openai' && looksLikeCodexOauthToken(text)) return false
  return true
}

export function providerEnvVar(pid: string): string | null {
  return PROVIDER_ENV_VAR[pid] ?? PROVIDER_ENV_VAR[resolveProviderAlias(pid)] ?? null
}

/** Python `_apply_provider_prefix`. */
export function applyProviderPrefix(models: ModelEntry[], pid: string, active: string | null): ModelEntry[] {
  const act = (active ?? '').toLowerCase()
  if (pid === act) return [...models]
  if (!act && !PORTAL_PROVIDERS.has(pid)) return [...models]
  return models.map((m) => (m.id.startsWith('@') || (m.id.includes('/') && !PORTAL_PROVIDERS.has(pid)) ? { ...m } : { ...m, id: `@${pid}:${m.id}` }))
}

/** Python `_deduplicate_model_ids`: later duplicate ids (by provider-id order) gain an `@provider:` prefix. */
export function deduplicateModelIds(groups: ModelGroup[]): void {
  const order = groups.map((_, i) => i).sort((a, b) => (groups[a]!.provider_id < groups[b]!.provider_id ? -1 : groups[a]!.provider_id > groups[b]!.provider_id ? 1 : 0))
  const seen = new Map<string, ModelEntry[]>()
  for (const gi of order) for (const m of groups[gi]!.models) {
    const id = m.id.trim()
    if (!id || id.startsWith('@')) continue
    const list = seen.get(id) ?? []
    list.push(m)
    seen.set(id, list)
  }
  for (const gi of order) for (const m of groups[gi]!.models) {
    const list = seen.get(m.id)
    if (list && list.length > 1 && list[0] !== m) m.id = `@${groups[gi]!.provider_id}:${m.id}`
  }
}

interface KeyProbe { hasKey: boolean; keySource: string; authError: string | null; isOauth: boolean }

export class ProviderCatalog {
  private readonly liveIds = new Map<string, { at: number; ids: string[] }>()
  private readonly liveInflight = new Map<string, Promise<string[]>>()
  private readonly providersCache = new Map<string, { at: number; key: string; payload: { providers: Dict[]; active_provider: string | null } }>()

  constructor(private readonly deps: CatalogDeps) {}

  invalidate(profileHome?: string, provider?: string): void {
    for (const key of [...this.liveIds.keys()]) {
      if (profileHome && !key.startsWith(`${profileHome}\0`)) continue
      if (provider && !key.endsWith(`\0${provider}`)) continue
      this.liveIds.delete(key)
    }
    this.providersCache.clear()
  }

  /** Python `_provider_has_key` minus the credential pool (the sidecar answers OAuth/pool state). */
  providerHasKey(pid: string, config: Config, envValues: Record<string, string>): boolean {
    const envVar = providerEnvVar(pid)
    if (envVar) {
      if (valueCountsAsApiKey(pid, envValues[envVar]) || valueCountsAsApiKey(pid, this.deps.env[envVar])) return true
      for (const alias of PROVIDER_ENV_VAR_ALIASES[pid] ?? []) if (valueCountsAsApiKey(pid, envValues[alias]) || valueCountsAsApiKey(pid, this.deps.env[alias])) return true
    }
    const model = modelSection(config)
    if (str(model.api_key).trim() && canonicaliseProviderId(model.provider) === canonicaliseProviderId(pid) && valueCountsAsApiKey(pid, model.api_key)) return true
    const providers = dict(config.providers)
    for (const [key, value] of Object.entries(providers)) {
      if (canonicaliseProviderId(key) !== canonicaliseProviderId(pid)) continue
      if (isDict(value) && valueCountsAsApiKey(pid, value.api_key)) return true
    }
    for (const cp of customProviderEntries(config)) {
      const name = str(cp.name).trim().toLowerCase()
      if (name && (pid === name || pid === `custom:${name}` || pid === customProviderSlug(name)) && valueCountsAsApiKey(pid, cp.api_key)) return true
    }
    return false
  }

  private async authStatus(profileHome: string, pid: string): Promise<Dict | null> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return null
    try {
      return (await sidecar.call('providers.auth_status', { profile_home: profileHome, provider: pid })).status
    } catch {
      return null
    }
  }

  private async probeKey(profileHome: string, pid: string, config: Config, envValues: Record<string, string>): Promise<KeyProbe> {
    let hasKey = this.providerHasKey(pid, config, envValues)
    let isOauth = OAUTH_PROVIDERS.has(pid)
    let keySource = 'none'
    let authError: string | null = null
    if (isOauth) {
      keySource = 'oauth'
      const status = await this.authStatus(profileHome, pid)
      if (status?.logged_in) {
        hasKey = true
        keySource = str(status.key_source) || 'oauth'
      } else if (hasKey) {
        keySource = 'config_yaml'
        authError = status ? str(status.error) || null : null
      } else if (status) {
        hasKey = false
        authError = str(status.error) || null
      }
    } else if (hasKey) {
      const envVar = providerEnvVar(pid)
      if (envVar) {
        if (valueCountsAsApiKey(pid, envValues[envVar])) keySource = 'env_file'
        else if (valueCountsAsApiKey(pid, this.deps.env[envVar])) keySource = 'env_var'
        else {
          keySource = 'config_yaml'
          for (const alias of PROVIDER_ENV_VAR_ALIASES[pid] ?? []) {
            if (valueCountsAsApiKey(pid, envValues[alias])) { keySource = 'env_file'; break }
            if (valueCountsAsApiKey(pid, this.deps.env[alias])) { keySource = 'env_var'; break }
          }
        }
      } else keySource = 'config_yaml'
    } else if (!providerEnvVar(pid) && /^[a-z][a-z0-9_-]{0,63}$/.test(pid)) {
      const status = await this.authStatus(profileHome, pid)
      if (status?.logged_in) {
        hasKey = true
        const raw = str(status.key_source)
        keySource = ['oauth', 'env', 'config', 'token'].includes(raw) ? raw : 'oauth'
        isOauth = true
      }
    }
    return { hasKey, keySource, authError, isOauth }
  }

  /** Live model ids from the Agent for one provider, cached per profile home. */
  async liveModelIds(profileHome: string, pid: string, opts: { force?: boolean } = {}): Promise<string[]> {
    const key = `${profileHome}\0${pid}`
    const hit = this.liveIds.get(key)
    if (hit && !opts.force && this.deps.now() - hit.at < LIVE_TTL_S) return hit.ids
    const inflight = this.liveInflight.get(key)
    if (inflight && !opts.force) return inflight
    const sidecar = this.deps.sidecar()
    if (!sidecar) return hit?.ids ?? []
    const run = sidecar.call('providers.model_ids', { profile_home: profileHome, provider: pid, ...(opts.force ? { force_refresh: true } : {}) }, { timeoutMs: 30_000 })
      .then((r) => { this.liveIds.set(key, { at: this.deps.now(), ids: r.model_ids }); return r.model_ids })
      .catch((error: unknown) => { this.deps.log(`[catalog] live model ids for ${pid} failed: ${str((error as Error).message)}`); return hit?.ids ?? [] })
      .finally(() => { this.liveInflight.delete(key) })
    this.liveInflight.set(key, run)
    return run
  }

  /** Python `get_providers`. */
  async providers(profileHome: string): Promise<{ providers: Dict[]; active_provider: string | null }> {
    const config = await this.deps.config.read(profileHome)
    const envValues = loadEnvFile(join(profileHome, '.env'))
    const cacheKey = JSON.stringify([config, envValues])
    const hit = this.providersCache.get(profileHome)
    if (hit?.key === cacheKey && this.deps.now() - hit.at < PROVIDERS_TTL_S) return structuredClone(hit.payload)
    const active = activeProviderFromConfig(config)
    const known = new Set<string>([...Object.keys(PROVIDER_DISPLAY), ...Object.keys(PROVIDER_MODELS), ...OAUTH_PROVIDERS])
    const providersCfg = dict(config.providers)
    for (const key of Object.keys(providersCfg)) {
      const identity = canonicaliseProviderId(key)
      known.add(known.has(identity) ? identity : key)
    }
    const rows: Dict[] = []
    for (const pid of [...known].sort()) {
      const probe = await this.probeKey(profileHome, pid, config, envValues)
      if (pid === 'openai' && !probe.hasKey && looksLikeCodexOauthToken(str(envValues[providerEnvVar('openai') ?? ''] ?? this.deps.env.OPENAI_API_KEY))) continue
      let models: ModelEntry[] = pid === 'openrouter' ? FALLBACK_MODELS.map((m) => ({ id: m.id, label: m.label })) : [...(PROVIDER_MODELS[pid] ?? [])]
      let modelsTotal = models.length
      if (probe.hasKey && (probe.isOauth || pid === 'lmstudio' || pid === 'nous')) {
        const live = await this.liveModelIds(profileHome, pid)
        if (live.length) {
          models = pid === 'nous' ? live.slice(0, 25).map((id) => ({ id: `@nous:${id}`, label: `${formatOllamaLabel(id.includes('/') ? id.slice(id.indexOf('/') + 1) : id)} (via Nous)` })) : live.map((id) => ({ id, label: labelForModel(id, []) }))
          modelsTotal = live.length
        }
      }
      const providerCfg = dict(providersCfg[pid] ?? providersCfg[Object.keys(providersCfg).find((k) => canonicaliseProviderId(k) === pid) ?? ''])
      const baseUrl = str(providerCfg.base_url).trim() || (active === pid ? str(modelSection(config).base_url).trim() : '') || null
      rows.push({
        id: pid,
        display_name: displayName(pid),
        has_key: probe.hasKey,
        configurable: !probe.isOauth && Boolean(providerEnvVar(pid)),
        is_oauth: probe.isOauth,
        is_plugin_provider: false,
        is_self_hosted: SELF_HOSTED_PROVIDER_IDS.has(pid),
        is_custom: false,
        key_source: probe.keySource,
        base_url: baseUrl,
        auth_error: probe.authError,
        env_var: providerEnvVar(pid),
        models,
        models_total: modelsTotal,
      })
    }
    for (const cp of customProviderEntries(config)) {
      const name = str(cp.name).trim()
      if (!name) continue
      const slug = customProviderSlug(name) || 'custom'
      const ids = [str(cp.model).trim(), ...configuredModelIds(cp.models)].filter((v, i, a) => v && a.indexOf(v) === i)
      rows.push({
        id: slug, display_name: name, has_key: valueCountsAsApiKey(slug, cp.api_key) || Boolean(str(cp.key_env).trim() && this.deps.env[str(cp.key_env).trim()]),
        configurable: false, is_oauth: false, is_plugin_provider: false, is_self_hosted: false, is_custom: true, key_source: str(cp.api_key).trim() ? 'config_yaml' : 'none',
        base_url: str(cp.base_url).trim() || null, auth_error: null, env_var: null, models: ids.map((id) => ({ id, label: labelForModel(id, []) })), models_total: ids.length,
      })
    }
    const payload = { providers: rows, active_provider: active }
    this.providersCache.set(profileHome, { at: this.deps.now(), key: cacheKey, payload })
    return structuredClone(payload)
  }

  /** Python `get_available_models` (static catalog + live ids for keyed providers). */
  async models(profileHome: string): Promise<ModelsCatalog> {
    const config = await this.deps.config.read(profileHome)
    const envValues = loadEnvFile(join(profileHome, '.env'))
    const active = activeProviderFromConfig(config)
    const model = modelSection(config)
    const defaultModel = effectiveDefaultModel(config, this.deps.env)
    const cfgBaseUrl = str(model.base_url).trim()
    const detected = new Set<string>()
    const configuredIds = new Map<string, string[]>()
    const append = (pid: string, id: unknown): void => {
      const m = str(id).trim()
      if (!m) return
      const list = configuredIds.get(pid) ?? []
      if (!list.includes(m)) list.push(m)
      configuredIds.set(pid, list)
    }
    if (active) detected.add(active)
    const providersCfg = dict(config.providers)
    const rawKeyFor = new Map<string, string>()
    for (const [key, value] of Object.entries(providersCfg)) {
      const canonical = canonicaliseProviderId(key)
      if (!canonical) continue
      if (!rawKeyFor.has(canonical)) rawKeyFor.set(canonical, key)
      if (!isDict(value)) continue
      let signal = ['api_key', 'key_env', 'base_url'].some((k) => str(value[k]).trim())
      for (const id of configuredModelIds(value.models)) { append(canonical, id); signal = true }
      if (signal) detected.add(canonical)
    }
    for (const pid of new Set([...Object.keys(PROVIDER_MODELS), ...Object.keys(PROVIDER_DISPLAY)])) {
      const canonical = canonicaliseProviderId(pid)
      if (canonical && this.providerHasKey(canonical, config, envValues)) detected.add(canonical)
    }
    const fallbackCfg = Array.isArray(config.fallback_providers) ? config.fallback_providers.filter(isDict) : []
    for (const entry of fallbackCfg) {
      const p = resolveProviderAlias(entry.provider)
      if (p) { detected.add(p); append(p, entry.model) }
    }
    const namedCustom = new Map<string, { name: string; models: ModelEntry[] }>()
    const customModels: ModelEntry[] = []
    for (const entry of customProviderEntries(config)) {
      const name = str(entry.name).trim()
      const slug = customProviderSlug(name) || 'custom'
      if (slug !== 'custom' && !namedCustom.has(slug)) namedCustom.set(slug, { name, models: [] })
      detected.add(slug)
      const ids = [str(entry.model).trim(), ...configuredModelIds(entry.models)].filter((v, i, a) => v && a.indexOf(v) === i)
      for (const id of ids) {
        const row = { id, label: labelForModel(id, []) }
        if (slug === 'custom') customModels.push(row)
        else namedCustom.get(slug)!.models.push(row)
        append(slug, id)
      }
    }
    if (cfgBaseUrl) {
      const named = [...namedCustom.entries()].find(([, v]) => customProviderEntries(config).some((e) => customProviderSlug(e.name) === customProviderSlug(v.name) && str(e.base_url).trim().replace(/\/+$/, '') === cfgBaseUrl.replace(/\/+$/, '')))
      detected.add(named?.[0] ?? active ?? 'custom')
    }
    const groups: ModelGroup[] = []
    for (const pid of [...detected].map((p) => (p.startsWith('custom') ? p : canonicaliseProviderId(p) || p)).filter((v, i, a) => v && a.indexOf(v) === i).sort()) {
      if (pid.startsWith('custom:')) {
        const g = namedCustom.get(pid)
        const models = [...(g?.models ?? [])]
        if (models.length || pid === active) groups.push({ provider: g?.name ?? pid.replace('custom:', ''), provider_id: pid, models: applyProviderPrefix(models, pid, active) })
        continue
      }
      if (pid === 'custom') {
        const models = [...customModels]
        for (const id of configuredIds.get(pid) ?? []) if (!models.some((m) => m.id === id)) models.push({ id, label: labelForModel(id, []) })
        if (models.length || cfgBaseUrl || pid === active) groups.push({ provider: PROVIDER_DISPLAY.custom ?? 'Custom', provider_id: pid, models: applyProviderPrefix(models, pid, active) })
        continue
      }
      const providerCfg = dict(providersCfg[rawKeyFor.get(pid) ?? pid])
      let raw: ModelEntry[] = []
      if ('models' in providerCfg && providerCfg.models_discovered !== true) raw = configuredModelOptions(providerCfg.models)
      if (!raw.length && this.providerHasKey(pid, config, envValues)) {
        const live = await this.liveModelIds(profileHome, pid)
        if (live.length) raw = live.map((id) => ({ id, label: pid === 'nous' ? `${formatOllamaLabel(id.includes('/') ? id.slice(id.indexOf('/') + 1) : id)} (via Nous)` : labelForModel(id, []) }))
      }
      if (!raw.length) raw = pid === 'openrouter' ? FALLBACK_MODELS.map((m) => ({ id: m.id, label: m.label })) : [...(PROVIDER_MODELS[pid] ?? [])]
      for (const id of configuredIds.get(pid) ?? []) if (!raw.some((m) => m.id === id)) raw.push({ id, label: labelForModel(id, groups) })
      if (raw.length) groups.push({ provider: displayName(pid), provider_id: pid, models: applyProviderPrefix(raw, pid, active) })
    }
    if (defaultModel) {
      const all = new Set(groups.flatMap((g) => g.models.map((m) => m.id)))
      if (!all.has(defaultModel) && !all.has(`@${active ?? ''}:${defaultModel}`)) {
        const label = labelForModel(defaultModel, groups)
        const target = groups.find((g) => g.provider_id === active)
        if (target) target.models.unshift({ id: defaultModel, label })
        else if (groups.length) groups.push({ provider: 'Default', provider_id: active ?? 'default', models: [{ id: defaultModel, label }] })
      }
    }
    deduplicateModelIds(groups)
    const kept = groups.filter((g) => g.models.length || g.provider_id.startsWith('custom:'))
    const withKeys = new Set<string>()
    for (const [k, v] of Object.entries(providersCfg)) if (isDict(v) && (v.api_key || v.key_env || v.base_url)) { const c = canonicaliseProviderId(k); if (c) withKeys.add(c) }
    const rank = (g: ModelGroup): number => (g.provider_id === active ? 0 : g.provider_id.startsWith('custom:') ? 1 : withKeys.has(g.provider_id) ? 2 : 3)
    kept.sort((a, b) => rank(a) - rank(b) || (a.provider_id < b.provider_id ? -1 : a.provider_id > b.provider_id ? 1 : 0))
    for (const g of kept) if (isOpenAiFamilyProvider(g.provider_id)) for (const m of g.models) if (/^(@[^:]+:)?(openai\/)?(gpt-5|o[0-9])/.test(m.id)) m.supports_fast_tier = true
    const aliases: Record<string, string> = {}
    const rawAliases = model.aliases
    if (isDict(rawAliases)) for (const [k, v] of Object.entries(rawAliases)) if (k && v) aliases[k.trim()] = str(v).trim()
    if (!kept.length && defaultModel) {
      return { active_provider: active, default_model: defaultModel, groups: [{ provider: 'Default', provider_id: active ?? 'default', models: [{ id: defaultModel, label: labelForModel(defaultModel, []) }] }], aliases: {}, configured_model_badges: {} }
    }
    return { active_provider: active, default_model: defaultModel, groups: kept, aliases, configured_model_badges: this.badges(kept, active, defaultModel, fallbackCfg) }
  }

  /** Python `_configured_model_badges_from_static_catalog`: which picker rows are the main/fallback selections. */
  private badges(groups: ModelGroup[], active: string | null, defaultModel: string, fallback: Dict[]): ModelsCatalog['configured_model_badges'] {
    const entries: { provider: string; model: string; role: string; label: string }[] = []
    if (active && defaultModel) entries.push({ provider: active, model: defaultModel, role: 'main', label: 'Main' })
    fallback.forEach((entry, i) => {
      const provider = resolveProviderAlias(entry.provider)
      const m = str(entry.model).trim()
      if (provider && m) entries.push({ provider, model: m, role: 'fallback', label: `Fallback ${String(i + 1)}` })
    })
    const providerOf = new Map<string, string>()
    for (const g of groups) for (const m of g.models) providerOf.set(m.id, g.provider_id)
    const badges: ModelsCatalog['configured_model_badges'] = {}
    for (const e of entries) {
      const candidates = [e.model, `${e.provider}/${e.model}`, `@${e.provider}:${e.model}`]
      const payload = { role: e.role, label: e.label, provider: e.provider }
      for (const c of candidates) {
        const p = providerOf.get(c)
        if (p && p !== e.provider) continue
        badges[c] = payload
      }
    }
    return badges
  }

  /** Python `_handle_live_models`. */
  async liveModels(profileHome: string, providerRaw: string): Promise<Dict> {
    const config = await this.deps.config.read(profileHome)
    let provider = providerRaw.trim().toLowerCase() || str(modelSection(config).provider).trim().toLowerCase()
    if (!provider) return { error: 'no_provider', models: [] }
    provider = resolveProviderAlias(provider)
    let ids = await this.liveModelIds(profileHome, provider)
    let source = 'live'
    if (!ids.length) {
      const fromConfig: string[] = []
      if (provider === 'custom' || provider.startsWith('custom:')) {
        for (const cp of customProviderEntries(config)) {
          const slug = customProviderSlug(cp.name)
          if ((provider.startsWith('custom:') && slug === provider) || (provider === 'custom' && !slug)) fromConfig.push(...[str(cp.model).trim(), ...configuredModelIds(cp.models)].filter(Boolean))
        }
      }
      ids = fromConfig.length ? [...new Set(fromConfig)] : (PROVIDER_MODELS[provider] ?? []).map((m) => m.id)
      source = fromConfig.length ? 'config' : 'static'
    }
    return { provider, source, models: ids.map((id) => ({ id, label: labelForModel(id, []) })) }
  }

  private apiKeyFor(pid: string, profileHome: string, config: Config): string | null {
    const envValues = loadEnvFile(join(profileHome, '.env'))
    const envVar = providerEnvVar(pid)
    if (envVar) {
      for (const name of [envVar, ...(PROVIDER_ENV_VAR_ALIASES[pid] ?? [])]) {
        const v = str(envValues[name] ?? this.deps.env[name]).trim()
        if (v) return v
      }
    }
    const p = dict(dict(config.providers)[pid])
    return str(p.api_key).trim() || null
  }

  /** Python `get_provider_quota`. */
  async quota(profileHome: string, providerRaw: string | null): Promise<Dict> {
    const config = await this.deps.config.read(profileHome)
    const provider = (providerRaw ?? activeProviderFromConfig(config) ?? '').trim().toLowerCase()
    if (!provider) return { ok: false, provider: null, display_name: null, supported: false, status: 'unavailable', quota: null, message: 'No active provider is configured.' }
    const name = displayName(provider)
    if (ACCOUNT_USAGE_PROVIDERS.has(provider)) {
      const sidecar = this.deps.sidecar()
      let limits: Dict | null = null
      if (sidecar) {
        try {
          const snapshot = (await sidecar.call('usage.account', { profile_home: profileHome, provider }, { timeoutMs: 35_000 })).snapshot
          if (snapshot) limits = { ...snapshot, title: str(snapshot.title) || 'Account limits', available: snapshot.available && !str(snapshot.unavailable_reason) }
        } catch (error) {
          limits = { available: false, unavailable_reason: str((error as Error).message), windows: [], details: [] }
        }
      }
      if (limits?.available) return { ok: true, provider, display_name: name, supported: true, status: limits.stale ? 'stale' : 'available', label: limits.title, quota: null, account_limits: limits, message: limits.stale ? `${name} refresh failed; showing last-known account limits.` : `${name} account limits loaded.` }
      const reason = str(limits?.unavailable_reason).trim()
      return { ok: false, provider, display_name: name, supported: true, status: 'unavailable', quota: null, account_limits: limits, message: reason ? `${name} account limits are unavailable. ${reason}` : `${name} account limits are unavailable. Confirm provider authentication and try again.` }
    }
    if (provider === 'openrouter') {
      const apiKey = this.apiKeyFor('openrouter', profileHome, config)
      if (!apiKey) return { ok: false, provider, display_name: name, supported: true, status: 'no_key', quota: null, message: 'OpenRouter quota status needs an OPENROUTER_API_KEY configured on the server.' }
      const info = await this.fetchOpenRouterKey(apiKey)
      if (info.kind === 'ok') return { ok: true, provider, display_name: name, supported: true, status: 'available', label: 'OpenRouter credits', quota: info.quota, message: 'OpenRouter quota status loaded.' }
      const status = info.kind === 'invalid_key' ? 'invalid_key' : 'unavailable'
      return { ok: false, provider, display_name: name, supported: true, status, quota: null, message: status === 'invalid_key' ? 'OpenRouter rejected the configured API key.' : 'OpenRouter quota status is temporarily unavailable.' }
    }
    return { ok: false, provider, display_name: name, supported: false, status: 'unsupported', quota: null, message: `Quota status is not available for ${name}.` }
  }

  private async fetchOpenRouterKey(apiKey: string): Promise<{ kind: 'ok'; quota: Dict; label: string | null } | { kind: 'invalid_key' | 'unavailable' }> {
    const f = this.deps.fetch ?? fetch
    try {
      const res = await f(OPENROUTER_KEY_URL, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS) })
      if (!res.ok) return { kind: res.status === 401 || res.status === 403 ? 'invalid_key' : 'unavailable' }
      let payload: unknown = await res.json()
      if (isDict(payload) && isDict(payload.data)) payload = payload.data
      const d = dict(payload)
      const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      return { kind: 'ok', quota: { limit_remaining: num(d.limit_remaining), usage: num(d.usage), limit: num(d.limit) }, label: str(d.label).trim() || null }
    } catch {
      return { kind: 'unavailable' }
    }
  }

  /** Python `get_provider_quotas`: one source per keyed provider. */
  async quotas(profileHome: string, profile: string, opts: { sourceId?: string | null } = {}): Promise<Dict> {
    const status = await this.providers(profileHome)
    const active = status.active_provider
    const sourceId = (pid: string): string => `qsrc_${createHash('sha256').update(`${profile}\0${pid}\0provider`).digest('hex').slice(0, 32)}`
    let descriptors = status.providers.filter((p) => p.has_key || p.is_custom).map((p) => ({ source_id: sourceId(str(p.id)), provider_id: str(p.id), provider_label: str(p.display_name) || str(p.id) }))
    if (opts.sourceId) descriptors = descriptors.filter((d) => d.source_id === opts.sourceId)
    const sources = await Promise.all(descriptors.map(async (d) => {
      const q = await this.quota(profileHome, d.provider_id)
      const limits = dict(q.account_limits)
      return {
        source_id: d.source_id, provider_id: d.provider_id, provider_label: d.provider_label, account_label: d.provider_label,
        is_active_provider: d.provider_id === active, supported: q.supported === true, status: str(limits.status) || str(q.status) || 'unavailable',
        plan: limits.plan ?? null, windows: limits.windows ?? [], quota: q.quota ?? null, balances: q.balances ?? [], details: limits.details ?? [],
        unavailable_reason: limits.unavailable_reason ?? null, retry_after: limits.retry_after ?? null, fetched_at: limits.fetched_at ?? null, message: q.message ?? null,
      }
    }))
    return { sources, active_provider: active, version: 1 }
  }

  /** Python `get_provider_cost_history` (OpenRouter only; daily snapshots under `<home>/cost-snapshots`). */
  async costHistory(profileHome: string, providerRaw: string | null, days: number): Promise<Dict> {
    const provider = str(providerRaw).trim().toLowerCase()
    if (!provider) return { ok: false, provider: null, status: 'missing_provider', message: 'Provider parameter is required.  Use ?provider=openrouter' }
    if (provider !== 'openrouter') return { ok: false, provider, display_name: displayName(provider), supported: false, status: 'unsupported', message: `Cost history is not available for ${displayName(provider)}. Only openrouter is supported in this release.` }
    const name = displayName('openrouter')
    const budget = this.deps.costBudget()
    const config = await this.deps.config.read(profileHome)
    const apiKey = this.apiKeyFor('openrouter', profileHome, config)
    if (!apiKey) return { ok: false, provider, display_name: name, supported: true, status: 'no_key', monthly_budget: budget, message: 'OpenRouter cost history needs an OPENROUTER_API_KEY configured on the server.' }
    const file = join(profileHome, 'cost-snapshots', 'openrouter.json')
    const read = (): { date: string; used: number | null; limit: number | null }[] => {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as { snapshots?: unknown }
        return (Array.isArray(data.snapshots) ? data.snapshots : []).filter(isDict).map((e) => ({ date: str(e.date).trim(), used: typeof e.used === 'number' ? e.used : null, limit: typeof e.limit === 'number' ? e.limit : null })).filter((e) => e.date).sort((a, b) => (a.date < b.date ? -1 : 1))
      } catch {
        return []
      }
    }
    const deltas = (rows: ReturnType<typeof read>): Dict[] => {
      const window = rows.slice(-days)
      return window.map((e, i) => {
        let delta: number | null = null
        const prev = window[i - 1]
        if (i > 0 && e.used !== null && prev?.used !== null && prev?.used !== undefined) {
          delta = e.used - prev.used
          if (delta < 0) delta = e.used
          delta = Math.abs(delta) < 1e-9 ? 0 : Math.round(delta * 1e6) / 1e6
        }
        return { date: e.date, used: e.used, delta }
      })
    }
    const info = await this.fetchOpenRouterKey(apiKey)
    if (info.kind !== 'ok') {
      return { ok: false, provider, display_name: name, supported: true, status: 'unavailable', window_days: days, snapshots: deltas(read()), limit: null, label: null, monthly_budget: budget, message: 'OpenRouter cost history is temporarily unavailable. Showing last known data.' }
    }
    let snapshots = read()
    try {
      const today = new Date().toISOString().slice(0, 10)
      const usage = info.quota.usage as number | null
      const limit = info.quota.limit as number | null
      const existing = snapshots.find((e) => e.date === today)
      if (existing) { existing.used = usage; existing.limit = limit } else snapshots.push({ date: today, used: usage, limit })
      snapshots.sort((a, b) => (a.date < b.date ? -1 : 1))
      if (snapshots.length > COST_SNAPSHOT_MAX_DAYS) snapshots = snapshots.slice(-COST_SNAPSHOT_MAX_DAYS)
      mkdirSync(join(profileHome, 'cost-snapshots'), { recursive: true })
      atomicWriteText(file, JSON.stringify({ snapshots }, null, 2))
    } catch {
      snapshots = read()
    }
    return { ok: true, provider, display_name: name, supported: true, status: 'available', window_days: days, snapshots: deltas(snapshots), limit: info.quota.limit, label: info.label ?? 'OpenRouter credits', monthly_budget: budget, message: 'OpenRouter cost history loaded.' }
  }
}

export const envFileExists = (profileHome: string): boolean => existsSync(join(profileHome, '.env'))
