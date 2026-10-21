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
import type { DocumentBackend } from '../sessions/storage/backend.js'
import { updateDocument } from '../sessions/storage/document.js'
import { homeDotenvKeys } from '../cli/dotenv.js'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteText } from '../fs/atomic.js'
import type { SidecarLike } from '../sidecar/client.js'
import type { CatalogAvailability, KeySourceKind, SidecarParams, SidecarResult } from '@maudecode/talaria-web-contracts'
import { str } from '../util.js'
import { QUOTA_THRESHOLD_DEFAULTS, type QuotaThresholds } from '../settings.js'
import { loadEnvFile } from './env-file.js'
import {
  ACCOUNT_USAGE_PROVIDERS, FALLBACK_MODELS, OAUTH_PROVIDERS, PORTAL_PROVIDERS, PROVIDER_DISPLAY, PROVIDER_ENV_VAR, PROVIDER_ENV_VAR_ALIASES, PROVIDER_MODELS, SELF_HOSTED_PROVIDER_IDS,
} from './tables.js'
import {
  activeProviderFromConfig, canonicaliseProviderId, configuredModelIds, configuredModelOptions, customProviderEntries, customProviderSlug, dict, effectiveDefaultModel, isDict,
  modelSection, parseProviderQualifiedModel, providerIdentity, resolveProviderAlias, type AgentConfig, type Config, type Dict, type SpeedTier,
} from '../config/agent-config.js'

export interface ModelEntry { id: string; label: string; supports_fast_tier?: boolean; supported_speed_tiers?: SpeedTier[]; provider_id?: string; bare_id?: string; limit?: { scope: 'model'; resets_at: string } }
type PluginProvider = SidecarResult<'plugins.providers'>['providers'][number]
interface QuotaSourceRow extends Dict { source_id: string; provider_id: string; account_label: string }
interface CatalogLookup<T> { value: T | null; authoritative: boolean }
export interface ModelGroup {
  availability?: CatalogAvailability
  provider: string; provider_id: string; models: ModelEntry[]; extra_models?: ModelEntry[]
  limit?: { scope: 'account'; resets_at: string } | { scope: 'models'; models: Record<string, string> }; quota_level?: QuotaLevel
}

/** Python `_model_matches_picker_selection`: same bare id, and the routing hints agree when the selection names one. */
function modelMatchesPickerSelection(modelId: string, selected: string, providerId: string): boolean {
  const candidate = modelId.trim()
  const sel = selected.trim()
  if (!sel || !candidate) return false
  if (candidate === sel) return true
  const [candBare, candProvider] = parseProviderQualifiedModel(candidate) ?? [candidate, providerId.trim()]
  const [selBare, selProvider] = parseProviderQualifiedModel(sel) ?? [sel, '']
  return selBare === candBare && (!selProvider || selProvider.toLowerCase() === candProvider.toLowerCase())
}

/** TAL-301: every entry names its routing provider and bare id, split once by `parseProviderQualifiedModel`. */
function stampModelEntries(models: ModelEntry[], providerId: string): ModelEntry[] {
  return models.map((m) => {
    const [bare, provider] = parseProviderQualifiedModel(m.id) ?? [m.id, providerId]
    return { ...m, bare_id: bare, provider_id: provider }
  })
}

/** TAL-301: the catalog entry a stored `(model, provider)` pair selects, so clients render the pairing instead of computing it. */
export function catalogOptionId(catalog: ModelsCatalog, model: string | null, provider: string | null): string | null {
  const bare = str(model).trim()
  const pid = str(provider).trim().toLowerCase()
  if (!bare || !pid) return null
  for (const g of catalog.groups) for (const e of [...g.models, ...(g.extra_models ?? [])]) if (e.bare_id === bare && str(e.provider_id).toLowerCase() === pid) return e.id
  return null
}

/** TAL-542: the vendor a first-party provider serves, or a model id names by prefix; '' when neither says. */
const PROVIDER_VENDOR: Record<string, string> = { openai: 'openai', 'openai-api': 'openai', 'openai-codex': 'openai', anthropic: 'anthropic', gemini: 'google', google: 'google' }
function modelVendor(model: string): string {
  const m = model.trim().toLowerCase()
  if (m.includes('/')) return ({ openai: 'openai', anthropic: 'anthropic', google: 'google', gemini: 'google' } as Record<string, string>)[m.slice(0, m.indexOf('/'))] ?? ''
  return m.startsWith('gpt') ? 'openai' : m.startsWith('claude') ? 'anthropic' : m.startsWith('gemini') ? 'google' : ''
}

/**
 * TAL-542 (Python `_resolve_compatible_session_model_state` + `_repair_foreign_session_model_provider`): the pair a
 * session's stale model starts on. A model its provider's catalog group does not list moves to the one other provider
 * that lists it; else, when the model names another vendor than a first-party provider, to the profile default. No
 * evidence (no group for the provider, a group built from a failed live lookup in `unlisted`, which never names an owner either) keeps the pair, and so does a stored
 * provider that is the profile's own unless the model names another vendor. `null` keeps the pair.
 */
export function repairSessionModel(catalog: ModelsCatalog, model: string, provider: string | null, unlisted: ReadonlySet<string> = new Set()): [string, string] | null {
  const active = canonicaliseProviderId(catalog.active_provider)
  const pid = canonicaliseProviderId(provider) || active
  if (!model.trim() || !pid || unlisted.has(pid) || !catalog.groups.some((g) => canonicaliseProviderId(g.provider_id) === pid)) return null
  const loose = (id: string): string => id.trim().toLowerCase().replaceAll('-', '.')
  const want = loose(model)
  const entries = catalog.groups.flatMap((g) => [...g.models, ...(g.extra_models ?? [])])
  const tail = (id: string): string => loose(id.slice(id.indexOf('/') + 1))
  const own = entries.filter((e) => canonicaliseProviderId(e.provider_id) === pid).map((e) => str(e.bare_id))
  if (own.some((bare) => loose(bare) === want)) return null
  // Equivalence across ids only drops a recognised vendor prefix; another namespace is no evidence. A match starts on the
  // matching entry's own id, so the turn runs on the id that provider advertises.
  const vendorless = (id: string): string => loose(id.replace(/^(openai|anthropic|google|gemini)\//i, ''))
  const same = (bare: string): boolean => vendorless(bare) === vendorless(model)
  const here = own.find(same)
  if (here) return [here, pid]
  // Python `_catalog_model_id_matches`: a model the provider lists under another namespace is kept, never moved.
  if (own.some((bare) => tail(bare) === want)) return null
  if (!provider || pid !== active) {
    const owners = new Map(entries.filter((e) => same(str(e.bare_id)) && !unlisted.has(canonicaliseProviderId(e.provider_id))).map((e) => [canonicaliseProviderId(e.provider_id), str(e.bare_id)] as const))
    const [only] = owners.size === 1 ? [...owners] : []
    if (only) return [only[1], only[0]]
  }
  const vendor = PROVIDER_VENDOR[pid] ?? ''
  const named = modelVendor(model)
  // Python: Codex takes bare ids, so an `openai/` id on it is stale too.
  if (!vendor || !named || (named === vendor && !(pid === 'openai-codex' && model.includes('/')))) return null
  const defaultModel = str(catalog.default_bare_id).trim()
  const defaultProvider = canonicaliseProviderId(catalog.default_provider_id) || active
  return defaultModel && defaultProvider && (defaultModel !== model || defaultProvider !== pid) ? [defaultModel, defaultProvider] : null
}

/** Python `_split_picker_overflow_models`: past 25 rows the picker shows 15, keeping the selected model visible. */
export function splitPickerOverflow(models: ModelEntry[], selected: string, providerId: string): [ModelEntry[], ModelEntry[]] {
  if (models.length <= MODEL_PICKER_OVERFLOW_THRESHOLD) return [models, []]
  const visible = models.slice(0, MODEL_PICKER_VISIBLE_TARGET)
  const extras = models.slice(MODEL_PICKER_VISIBLE_TARGET)
  if (!selected || visible.some((m) => modelMatchesPickerSelection(m.id, selected, providerId))) return [visible, extras]
  const idx = extras.findIndex((m) => modelMatchesPickerSelection(m.id, selected, providerId))
  if (idx >= 0) { const displaced = visible[visible.length - 1]!; visible[visible.length - 1] = extras[idx]!; extras[idx] = displaced }
  return [visible, extras]
}
export interface ModelsCatalog { availability?: CatalogAvailability; active_provider: string | null; default_model: string; default_provider_id?: string | null; default_bare_id?: string; default_option_id?: string | null; groups: ModelGroup[]; aliases: Record<string, string>; configured_model_badges: Record<string, { role: string; label: string; provider: string }> }

/**
 * TAL-388: stamp each auxiliary slot with its display value and the catalog entry whose provider/model pair equals the
 * saved one, so clients tick exactly one option (a bare id listed under two providers matches only its own provider).
 */
export function stampAuxiliarySelections(aux: { tasks: Dict[]; main: Dict }, catalog: ModelsCatalog): { tasks: Dict[]; main: Dict } {
  const options = catalog.groups.flatMap((g) => [...g.models, ...(g.extra_models ?? [])].map((m) => {
    const parsed = parseProviderQualifiedModel(m.id)
    return { id: m.id, label: m.label, group: g.provider, provider: canonicaliseProviderId(parsed?.[1] ?? g.provider_id), bare: parsed?.[0] ?? m.id }
  }))
  const describe = (providerRaw: unknown, modelRaw: unknown): { value_label: string | null; provider_label: string | null; option_id: string | null } => {
    const provider = str(providerRaw).trim() || 'auto'
    const model = str(modelRaw).trim()
    const key = canonicaliseProviderId(provider)
    const match = provider === 'auto' ? undefined : options.find((o) => o.provider === key && o.bare === model)
    if (match) return { value_label: match.label || match.bare, provider_label: match.group, option_id: match.id }
    return { value_label: model || null, provider_label: provider === 'auto' ? null : providerLabel(catalog, provider), option_id: null }
  }
  // Auto falls back to the main chat model; name the effective one the catalog resolved (a legacy string `model` or a
  // `HERMES_MODEL`-style override never reaches `aux.main`).
  const mainParsed = parseProviderQualifiedModel(catalog.default_model)
  const main = describe(mainParsed?.[1] ?? catalog.active_provider ?? aux.main.provider, mainParsed?.[0] ?? (catalog.default_model || aux.main.model))
  const isAuto = (route: Dict): boolean => (str(route.provider).trim() || 'auto') === 'auto' && !str(route.model).trim()
  const tasks = aux.tasks.map(({ effective, ...t }) => {
    if (isAuto(t)) {
      // TAL-800: an Auto task that inherits another slot runs on that slot's route, the main model only when it is Auto too.
      const base = isDict(effective) && !isAuto(effective) ? describe(effective.provider, effective.model) : main
      return { ...t, is_auto: true, value_label: base.value_label, provider_label: base.provider_label, selected_option_id: null, in_catalog: true }
    }
    const pinned = describe(t.provider, t.model)
    return { ...t, is_auto: false, value_label: pinned.value_label, provider_label: pinned.provider_label, selected_option_id: pinned.option_id, in_catalog: pinned.option_id !== null }
  })
  return { ...aux, tasks }
}

export interface CatalogDeps {
  sidecar: () => SidecarLike | null
  config: AgentConfig
  env: Record<string, string | undefined>
  now: () => number
  log: (line: string) => void
  /** Settings `provider_cost_budget` (monthly). */
  costBudget: () => number | null
  /** Whether `profileHome` is the default profile's home (`$HERMES_HOME`). */
  isRootProfileHome: (profileHome: string) => boolean
  /** WebUI state directory; holds `.quota_scope_id`, the stable public identity namespace for quota sources. */
  documents?: DocumentBackend
  /** Settings `provider_quota_thresholds` for a profile; defaults when absent. */
  quotaThresholds?: (profile: string) => Promise<QuotaThresholds>
}

/** Python `_BESPOKE_CATALOG_PROVIDERS`: cards whose catalog is resolved by their own rule, never the generic live probe. */
const BESPOKE_CATALOG_PROVIDERS = new Set(['openai-codex', 'nous', 'xai-oauth', 'lmstudio', 'opencode-go'])
/** A provider's configured endpoint: its `providers.<id>.base_url` (alias-aware), else the active model's `base_url`. */
const configuredBaseUrl = (pid: string, config: Config): string => {
  const providers = dict(config.providers)
  const cfg = dict(providers[pid] ?? providers[Object.keys(providers).find((k) => providerIdentity(k) === providerIdentity(pid)) ?? ''])
  return str(cfg.base_url).trim() || (activeProviderFromConfig(config) === pid ? str(modelSection(config).base_url).trim() : '')
}
/** TAL-603: the credential family a card's badge names; `null` when the card holds no credential. */
const KEY_SOURCE_KINDS: Record<string, KeySourceKind> = { env_file: 'env', env_var: 'env', env: 'env', oauth: 'oauth', token: 'oauth', config_yaml: 'config', config: 'config', credential_pool: 'pool', plugin: 'plugin' }
const keySourceKind = (row: Dict): KeySourceKind | null => row.has_key === true && row.key_source !== 'none' ? KEY_SOURCE_KINDS[str(row.key_source)] ?? 'other' : null
/** TAL-570: Ollama and LM Studio run keyless, so a configured endpoint makes them ready the way a key does. */
const selfHostedEndpoint = (pid: string, config: Config): boolean => SELF_HOSTED_PROVIDER_IDS.has(pid) && Boolean(configuredBaseUrl(pid, config))
/** Python `_unqualified_model_id`: strip a picker routing hint (`@provider:`). */
const unqualifiedModelId = (id: string): string => parseProviderQualifiedModel(id)?.[0] ?? id.trim()
/** Python `_MODEL_PICKER_OVERFLOW_THRESHOLD` / `_MODEL_PICKER_VISIBLE_TARGET`. */
const MODEL_PICKER_OVERFLOW_THRESHOLD = 25
const MODEL_PICKER_VISIBLE_TARGET = 15
const ACCOUNT_USAGE_CACHE_TTL_S = 45
/** TAL-807: the oldest account-usage read the picker still shows a quota level from. */
const PICKER_USAGE_MAX_AGE_S = 600
/** TAL-807: how long a picker read waits for a provider's first account-usage read. */
const PICKER_USAGE_WAIT_MS = 2_000
const LIVE_TTL_S = 86_400
/** TAL-799: the Agent's `_PROVIDER_MODELS_FALLBACK_TTL`; its placeholder for an unreachable catalog is re-probed soon. */
const FALLBACK_TTL_S = 60
const PROVIDERS_TTL_S = 30
/** The sidecar reads a balance endpoint with a 15 s timeout of its own. */
const BALANCE_TIMEOUT_MS = 20_000
const PLUGIN_LIST_TIMEOUT_MS = 15_000
/** TAL-288: the card text for a plugin provider the Agent does not report ready. */
const PLUGIN_SETUP_ERRORS: Record<Exclude<PluginProvider['setup'], 'ready'>, string> = {
  missing_cli: "This provider's CLI was not found on the server. Install it and sign in, then refresh.",
  needs_setup: "This provider is not set up yet. Finish its setup in Hermes, then refresh.",
  not_loaded: 'This provider is installed but could not be loaded. Check it with hermes plugins doctor, then restart Talaria Web.',
  unavailable: "This provider's setup status is unavailable.",
}
const PLUGIN_NO_MODELS = 'This provider listed no models.'
const COST_SNAPSHOT_MAX_DAYS = 365

interface CostSnapshot { date: string; used: number | null; limit: number | null }

/**
 * The last `days` daily snapshots with their spend deltas, bar heights, monthly pace, and budget standing (the legacy
 * Web chart's formulas). A drop in `used` is a credit reset, so that day's delta is its `used`.
 */
function costHistoryView(rows: CostSnapshot[], days: number, budget: number | null): Dict {
  const window = rows.slice(-days)
  const deltas = window.map((e, i) => {
    const prev = window[i - 1]
    if (i === 0 || e.used === null || prev?.used === null || prev?.used === undefined) return null
    const delta = e.used - prev.used < 0 ? e.used : e.used - prev.used
    return Math.abs(delta) < 1e-9 ? 0 : Math.round(delta * 1e6) / 1e6
  })
  const known = deltas.filter((d): d is number => d !== null)
  const maxDelta = Math.max(...deltas.map((d) => d ?? 0), 1e-9)
  const pace = known.length ? (known.reduce((a, b) => a + b, 0) / known.length) * 30 : null
  const budgetPercent = pace !== null && pace > 0 && budget !== null && budget > 0 ? Math.round((pace / budget) * 100) : null
  return {
    snapshots: window.map((e, i) => {
      const delta = deltas[i] ?? null
      return { date: e.date, used: e.used, delta, bar_percent: delta === null ? 0 : Number(Math.max((delta / maxDelta) * 100, delta > 0 ? 2 : 0).toFixed(1)) }
    }),
    monthly_pace: pace === null ? null : Math.round(pace * 100) / 100,
    has_enough_data: known.length > 0,
    budget_percent: budgetPercent,
    budget_level: budgetPercent === null ? null : budgetPercent >= 100 ? 'over' : budgetPercent >= 80 ? 'warn' : 'ok',
  }
}

const FIVE_HOUR_WINDOW_S = 18_000
const WEEK_WINDOW_S = 604_800

/** Swift `rounded()`: half away from zero. */
function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits
  return (Math.sign(value) * Math.round(Math.abs(value) * scale)) / scale
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** ISO-8601 UTC for epoch seconds, without a `.000` fraction. */
export const isoAt = (seconds: number): string => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z')

/** ISO-8601 UTC (`…Z`) or null. Accepts the pre-TAL-409 sidecar's `str(datetime)` space form; a zone-less stamp is UTC. */
export function isoUtc(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  let text = value.trim().replace(' ', 'T')
  if (text.includes('T') && !/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += 'Z'
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? isoAt(ms / 1000) : null
}

export interface QuotaPace { expected_remaining_percent: number; pace_delta_percent: number; burn_rate: number; minutes_to_reset: number; projected_minutes_to_empty: number | null; elapsed_minutes: number; valid_until: string }
export interface QuotaForecast { outcome: 'safe' | 'warning'; budget_unit: 'hour' | 'day'; budget_percent: number | null; depletion_margin_minutes: number | null }
export interface QuotaWindow { label: string; used_percent: number | null; remaining_percent: number | null; reset_at: string | null; detail: string | null; window_seconds: number | null; pace: QuotaPace | null; forecast: QuotaForecast | null }
export interface QuotaWindows { windows: QuotaWindow[]; pace_window_index: number | null; session_window_index: number | null; weekly_window_index: number | null }

/** The forecast a pace implies: per-hour or per-day budget until reset, and whether the projection empties the window first. */
export function quotaForecast(pace: QuotaPace, remaining: number | null): QuotaForecast {
  const daily = pace.minutes_to_reset >= 24 * 60
  const margin = pace.projected_minutes_to_empty === null ? null : pace.projected_minutes_to_empty - pace.minutes_to_reset
  return {
    outcome: margin === null || margin >= 0 ? 'safe' : 'warning',
    budget_unit: daily ? 'day' : 'hour',
    budget_percent: remaining !== null && pace.minutes_to_reset > 0 ? remaining / (pace.minutes_to_reset / (daily ? 24 * 60 : 60)) : null,
    depletion_margin_minutes: margin,
  }
}

/**
 * TAL-409: the one normaliser for account-usage windows (Python `_snapshot_windows_payload` plus the pace math the
 * App used to run). Blank labels drop; `reset_at` becomes ISO `Z`; each window gets its duration, pace and forecast
 * as of `nowSeconds`; the indexes name the windows the App shows for pace, session and weekly selections.
 */
export function normalizeQuotaWindows(raw: unknown, nowSeconds: number): QuotaWindows {
  const nowMs = nowSeconds * 1000
  const windows: QuotaWindow[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isDict(entry)) continue
    const label = str(entry.label).trim()
    if (!label) continue
    const usedRaw = finite(entry.used_percent)
    const remainingRaw = finite(entry.remaining_percent)
    const clamp = (v: number): number => Math.min(Math.max(v, 0), 100)
    const used = usedRaw !== null ? clamp(usedRaw) : remainingRaw !== null ? clamp(100 - remainingRaw) : null
    const remaining = used === null ? null : 100 - used
    const resetAt = isoUtc(entry.reset_at)
    const resetMs = resetAt === null ? null : Date.parse(resetAt)
    const minutesToReset = resetMs === null ? null : Math.max(0, roundTo((resetMs - nowMs) / 60_000, 0))
    const lower = label.toLowerCase()
    const providedSeconds = finite(entry.window_seconds)
    const windowSeconds = providedSeconds
      ?? (lower.includes('week') ? WEEK_WINDOW_S
        : lower.includes('5h') ? FIVE_HOUR_WINDOW_S
          // A "Session" window is 5h, or the weekly window a provider collapsed into one session bucket.
          : lower.includes('session') && minutesToReset !== null ? (minutesToReset > 5 * 60 ? WEEK_WINDOW_S : FIVE_HOUR_WINDOW_S)
            : null)
    let pace: QuotaPace | null = null
    if (resetAt !== null && resetMs !== null && minutesToReset !== null && resetMs > nowMs && used !== null && remaining !== null
      && (windowSeconds === FIVE_HOUR_WINDOW_S || windowSeconds === WEEK_WINDOW_S)) {
      const windowMinutes = windowSeconds / 60
      const elapsed = Math.max(0, windowMinutes - minutesToReset)
      const expectedRemaining = roundTo(Math.min(Math.max((minutesToReset / windowMinutes) * 100, 0), 100), 1)
      const expectedUsed = roundTo(100 - expectedRemaining, 1)
      const usagePerMinute = elapsed > 0 ? used / elapsed : 0
      pace = {
        expected_remaining_percent: expectedRemaining,
        pace_delta_percent: roundTo(remaining - expectedRemaining, 1),
        burn_rate: expectedUsed > 0 ? roundTo(used / expectedUsed, 2) : 0,
        minutes_to_reset: minutesToReset,
        projected_minutes_to_empty: usagePerMinute > 0 ? roundTo(remaining / usagePerMinute, 0) : null,
        elapsed_minutes: elapsed,
        valid_until: resetAt,
      }
    }
    windows.push({
      label, used_percent: usedRaw, remaining_percent: remaining, reset_at: resetAt, detail: typeof entry.detail === 'string' ? entry.detail : null,
      window_seconds: windowSeconds, pace, forecast: pace ? quotaForecast(pace, remaining) : null,
    })
  }
  const index = (match: (w: QuotaWindow) => boolean): number | null => { const i = windows.findIndex(match); return i < 0 ? null : i }
  const labelHas = (needle: string) => (w: QuotaWindow): boolean => w.label.toLowerCase().includes(needle)
  const knownPace = (w: QuotaWindow): boolean => w.window_seconds === FIVE_HOUR_WINDOW_S || w.window_seconds === WEEK_WINDOW_S || ['week', 'session', '5h'].some((n) => labelHas(n)(w))
  return {
    windows,
    pace_window_index: index(labelHas('week')) ?? index(knownPace),
    session_window_index: index(labelHas('session')) ?? index(labelHas('5h')),
    weekly_window_index: index(labelHas('week')),
  }
}

export type QuotaLevel = 'healthy' | 'warning' | 'critical' | 'stale' | 'unavailable'
export interface QuotaUrgency { remaining: QuotaLevel; pace: QuotaLevel }

/** The burn-rate breakpoints apply once the window is old and used enough and the projection empties it before reset. */
function projectionEligible(pace: QuotaPace, usedPercent: number, minimumElapsedHours: number): boolean {
  return pace.elapsed_minutes >= Math.max(0, minimumElapsedHours) * 60 && usedPercent >= 5 && pace.minutes_to_reset > 20
    && (pace.projected_minutes_to_empty ?? Infinity) < pace.minutes_to_reset
}

/** The App's former `ProviderQuotaUrgencyCalculator.urgency` for one colour basis; a pace basis without a pace falls back to remaining. */
function quotaLevel(window: QuotaWindow | undefined, status: string, basis: keyof QuotaUrgency, t: QuotaThresholds): QuotaLevel {
  if (status === 'stale') return 'stale'
  const remaining = window?.remaining_percent ?? null
  if (status !== 'available' || remaining === null) return status === 'available' ? 'healthy' : 'unavailable'
  const pace = window?.pace ?? null
  if (basis === 'pace' && pace) {
    const eligible = projectionEligible(pace, 100 - remaining, t.pace_minimum_elapsed_hours)
    if (eligible && pace.burn_rate >= Math.max(0, t.pace_critical_burn_rate_percent) / 100) return 'critical'
    if (eligible && pace.burn_rate >= Math.max(0, t.pace_warning_burn_rate_percent) / 100) return 'warning'
    return pace.pace_delta_percent <= -Math.max(0, t.pace_tolerance_percent) ? 'warning' : 'healthy'
  }
  if (remaining <= Math.max(0, t.critical_remaining_percent)) return 'critical'
  if (remaining <= Math.max(0, t.warning_remaining_percent)) return 'warning'
  return 'healthy'
}

/**
 * TAL-411: each window's `projection_eligible`, `urgency` per colour basis, and `pace.status` (over/on/under the
 * tolerance), and the source's `urgency` on the windows a widget shows by default (the first; the pace window for pace).
 */
export interface ClassifiedQuotaWindow extends Omit<QuotaWindow, 'pace'> { pace: (QuotaPace & { status: 'over' | 'on' | 'under' }) | null; projection_eligible: boolean; urgency: QuotaUrgency }
export function classifyQuotaSource<T extends { status: string; windows: QuotaWindow[]; pace_window_index: number | null }>(source: T, t: QuotaThresholds): Omit<T, 'windows'> & { windows: ClassifiedQuotaWindow[]; urgency: QuotaUrgency } {
  const urgency = (w: QuotaWindow | undefined): QuotaUrgency => ({ remaining: quotaLevel(w, source.status, 'remaining', t), pace: quotaLevel(w, source.status, 'pace', t) })
  return {
    ...source,
    windows: source.windows.map((w) => ({
      ...w,
      pace: w.pace && { ...w.pace, status: w.pace.pace_delta_percent <= -Math.max(0, t.pace_tolerance_percent) ? 'over' : w.pace.pace_delta_percent > 1 ? 'under' : 'on' },
      projection_eligible: w.pace !== null && w.remaining_percent !== null && projectionEligible(w.pace, 100 - w.remaining_percent, t.pace_minimum_elapsed_hours),
      urgency: urgency(w),
    })),
    urgency: { remaining: urgency(source.windows[0]).remaining, pace: urgency(source.windows[source.pace_window_index ?? 0]).pace },
  }
}

/** A provider's name as the catalog lists it (a named custom endpoint's configured name, a plugin's display name), else its static display name. */
export function providerLabel(catalog: ModelsCatalog | undefined, provider: string): string {
  const key = canonicaliseProviderId(provider)
  return catalog?.groups.find((g) => canonicaliseProviderId(g.provider_id) === key)?.provider ?? displayName(provider)
}

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
  const lookup = unqualifiedModelId(modelId)
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

const BALANCE_PROVIDERS = ['openrouter', 'deepseek', 'opencode-go'] as const
function isBalanceProvider(pid: string): pid is SidecarParams<'usage.balance'>['provider'] {
  return BALANCE_PROVIDERS.some((provider) => provider === pid)
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

/** TAL-548: one credential-pool account's local state, as the sidecar reads it without probing. */
type PoolEntry = SidecarResult<'usage.pool'>['entries'][number]

/** OpenCode Go's usage windows: their label and length (Python `_sanitize_opencode_go_account_limits`). */
const OPENCODE_GO_WINDOWS = { rolling: ['5-hour', FIVE_HOUR_WINDOW_S], weekly: ['Weekly', WEEK_WINDOW_S], monthly: ['Monthly', null] } as const

/** One pool account's local state as account limits; `status` is the account's, which its quota source shows. */
function poolEntryLimits(entry: PoolEntry, at: number): Dict {
  return {
    source: 'local_pool', title: 'Credential pool', status: entry.status, available: entry.status === 'available', plan: null, details: [],
    unavailable_reason: entry.unavailable_reason, retry_after: entry.retry_after, fetched_at: null, ...normalizeQuotaWindows([], at),
  }
}

/** Python `_local_pool_snapshot`: a provider's pool accounts summarised as account limits. */
function poolLimits(entries: PoolEntry[], at: number): Dict {
  const count = (status: PoolEntry['status']): number => entries.filter((e) => e.status === status).length
  const [available, exhausted, dead] = [count('available'), count('exhausted'), count('dead')]
  const details = [`${String(available)}/${String(entries.length)} credentials available`, ...(exhausted ? [`${String(exhausted)} exhausted`] : []), ...(dead ? [`${String(dead)} dead`] : [])]
  return {
    source: 'local_pool', title: 'Credential pool', available: available > 0, plan: null, details, unavailable_reason: available ? null : 'All pool credentials are unavailable.', fetched_at: null,
    ...normalizeQuotaWindows([], at),
  }
}

/** Quota sources keep the first row per source id, ordered by provider id, account label, then source id (TAL-272). */
export function uniqueQuotaSources<T extends { source_id: string; provider_id: string; account_label: string }>(sources: T[]): T[] {
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return sources.filter((q, i) => sources.findIndex((o) => o.source_id === q.source_id) === i)
    .sort((a, b) => cmp(a.provider_id, b.provider_id) || cmp(a.account_label, b.account_label) || cmp(a.source_id, b.source_id))
}

/** `removable` (TAL-641): `setProviderKey(…, null)` would leave the provider keyless: its own `.env` var holds the only key. */
interface KeyProbe { authoritative: boolean; hasKey: boolean; keySource: string; authError: string | null; isOauth: boolean; removable: boolean }

export class ProviderCatalog {
  private readonly scopedKeyRevisions = new Map<string, string>()
  private readonly scopedKeyAuthority = new Map<string, boolean>()
  private readonly modelGenerations = new Map<string, number>()
  private readonly modelReads = new Map<string, Promise<ModelsCatalog>>()
  private readonly credentialReads = new Map<string, Promise<CatalogLookup<SidecarResult<'usage.pool_providers'>>>>()
  /** Failed live lookups by home, provider, and the `sourceFingerprint` they ran under (TAL-542). */
  private readonly liveFailed = new Set<string>()
  /** `source`: the `sourceFingerprint` the ids were fetched under; another one makes them stale (TAL-542). `ttl`: seconds they stay fresh. */
  private readonly liveIds = new Map<string, { at: number; ids: string[]; source: string; ttl: number; confirmed: boolean }>()
  private readonly liveInflight = new Map<string, Promise<string[]>>()
  /** `pooled`: the fill's `poolProviders` answer, null when unknown (TAL-638). */
  private readonly providersCache = new Map<string, { at: number; key: string; payload: { providers: Dict[]; active_provider: string | null; availability: CatalogAvailability }; pooled: string[] | null }>()
  /** TAL-301: the last catalog served per profile home, for the sync session payloads' `model_option_id`. */
  private readonly lastModels = new Map<string, ModelsCatalog>()
  /** TAL-542: per `lastModels` catalog, the `sourceFingerprint` it was built from, when, and the providers whose group came from a failed live lookup. */
  private readonly lastModelsMeta = new Map<string, { source: string; unconfirmed: ReadonlySet<string>; at: number }>()

  constructor(private readonly deps: CatalogDeps) {}

  /** Python `models_cache` diagnostics: live-id groups held, ids across them, and the oldest snapshot's age. */
  diagnosticSnapshot(): { groups: number; models: number; age_seconds: number | null } {
    let models = 0
    let oldest: number | null = null
    for (const { at, ids } of this.liveIds.values()) { models += ids.length; oldest = oldest === null ? at : Math.min(oldest, at) }
    return { groups: this.liveIds.size, models, age_seconds: oldest === null ? null : Math.max(0, Math.round(this.deps.now() - oldest)) }
  }

  invalidate(profileHome?: string, provider?: string, opts: { preserveConfirmed?: boolean } = {}): void {
    // Explicit refresh retires builds without changing the credential identity of confirmed live ids.
    if (profileHome) this.modelGenerations.set(profileHome, (this.modelGenerations.get(profileHome) ?? 0) + 1)
    else for (const [home, generation] of this.modelGenerations) this.modelGenerations.set(home, generation + 1)
    for (const key of [...this.liveIds.keys()]) {
      if (profileHome && !key.startsWith(`${profileHome}\0`)) continue
      if (provider && !key.endsWith(`\0${provider}`)) continue
      if (opts.preserveConfirmed) this.liveIds.get(key)!.ttl = 0
      else this.liveIds.delete(key)
    }
    this.providersCache.clear()
    for (const key of this.pickerLimitsCache.keys()) if (!profileHome || key === profileHome) this.pickerLimitsCache.delete(key)
    if (opts.preserveConfirmed) return
    for (const key of [...this.lastQuotaSources.keys()]) if (!profileHome || key.startsWith(`${profileHome}\0`)) this.lastQuotaSources.delete(key)
    // Credentials changed: the last pool answers no longer stand in for a failed lookup.
    for (const key of [...this.lastPoolAnswers.keys()]) if (!profileHome || key.startsWith(`${profileHome}\0`)) this.lastPoolAnswers.delete(key)
    // The picker catalog changed: option ids rebuild on the next read rather than pairing against the old one.
    if (profileHome) { this.lastModels.delete(profileHome); this.lastModelsMeta.delete(profileHome) } else { this.lastModels.clear(); this.lastModelsMeta.clear() }
  }

  /** TAL-301: the entry id a stored `(model, provider)` pair selects in the last catalog built for this home; a cold home starts building one. */
  modelOptionFor(profileHome: string, model: string | null, provider: string | null): string | null {
    const catalog = this.lastModels.get(profileHome)
    if (!catalog) { void this.warmModelOptions(profileHome); return null }
    return catalogOptionId(catalog, model, provider)
  }

  /** TAL-821: `providerLabel` against the last catalog built for this home; a cold home starts building one. */
  providerLabel(profileHome: string, provider: string): string {
    const catalog = this.lastModels.get(profileHome)
    if (!catalog) void this.warmModelOptions(profileHome)
    return providerLabel(catalog, provider)
  }

  /**
   * TAL-542: the identity of the files a catalog and its live ids derive from: config.yaml, `.env`, the Agent's sign-in
   * store (`auth.json`, rewritten by an account switch), and the installed plugins directory, so a change outside Web
   * makes both stale. Opaque scoped-key revisions cover external secret sources without exposing their keys.
   */
  private sourceFingerprint(profileHome: string, includeScoped = true): string {
    const stamp = (name: string): string => {
      try { const st = statSync(join(profileHome, name), { bigint: true }); return `${String(st.mtimeNs)}:${String(st.ctimeNs)}:${String(st.size)}:${String(st.ino)}` } catch { return 'missing' }
    }
    const names = new Set([...Object.values(PROVIDER_ENV_VAR), ...Object.values(PROVIDER_ENV_VAR_ALIASES).flat()])
    const config = this.deps.config.peek(profileHome, { refresh: false }) ?? {}
    for (const cp of [modelSection(config), ...Object.values(dict(config.providers)).filter(isDict), ...customProviderEntries(config)]) {
      for (const name of [str(cp.key_env).trim(), /^\$\{([^}]+)\}$/.exec(str(cp.api_key).trim())?.[1]]) if (name) names.add(name)
    }
    const credentials = [...names].sort().map((name) => [name, this.processEnv(name, profileHome)])
    const models = ['HERMES_MODEL', 'OPENAI_MODEL', 'LLM_MODEL'].map((name) => [name, this.deps.env[name]])
    const environment = createHash('sha256').update(JSON.stringify([credentials, models, includeScoped ? this.scopedKeyRevisions.get(profileHome) ?? '[]' : '[]'])).digest('hex')
    return [profileHome, environment, this.deps.config.fingerprint(profileHome), ...['.env', 'auth.json', 'plugins'].map(stamp)].join('|')
  }

  /** The last catalog built for this home, younger than `maxAgeS`, while its source files are unchanged since (TAL-542). */
  private currentModels(profileHome: string, maxAgeS = Infinity): ModelsCatalog | undefined {
    const meta = this.lastModelsMeta.get(profileHome)
    return this.scopedKeyAuthority.get(profileHome) !== false && meta?.source === this.sourceFingerprint(profileHome) && this.deps.now() - meta.at < maxAgeS ? this.lastModels.get(profileHome) : undefined
  }

  /**
   * TAL-542: `repairSessionModel` against this home's catalog. Agent-owned sign-in and plugin state has no file to
   * fingerprint, so the repair also needs a catalog no older than the providers listing it read (`PROVIDERS_TTL_S`);
   * a cold or stale one keeps the pair and starts a rebuild.
   */
  sessionModelRepair(profileHome: string, model: string, provider: string | null): [string, string] | null {
    const catalog = this.currentModels(profileHome, PROVIDERS_TTL_S)
    const pid = canonicaliseProviderId(provider) || canonicaliseProviderId(catalog?.active_provider)
    if (!catalog || this.lastModelsMeta.get(profileHome)?.unconfirmed.has(pid)) void this.models(profileHome).catch(() => undefined)
    if (!catalog) return null
    return repairSessionModel(catalog, model, provider, this.lastModelsMeta.get(profileHome)?.unconfirmed)
  }

  /**
   * Explicitly await discovery, or start it in the background from `sessionModelRepair`. Admission never awaits it.
   * A source that changed while the build awaited makes that build stale, so it is rebuilt once.
   */
  async warmSessionModelRepair(profileHome: string): Promise<void> {
    await this.poolProviders(profileHome)
    for (let attempt = 0; attempt < 2 && !this.currentModels(profileHome, PROVIDERS_TTL_S); attempt += 1) {
      try { await this.models(profileHome) } catch { return /* fail closed: the pair is kept */ }
    }
  }

  /** Builds the catalog `modelOptionFor` reads once per home, again after config.yaml or `.env` changes; an unavailable catalog leaves every option id null. */
  async warmModelOptions(profileHome: string): Promise<void> {
    await this.poolProviders(profileHome)
    if (this.currentModels(profileHome)) return
    try { await this.models(profileHome) } catch { /* fail closed: no option ids */ }
  }

  /**
   * The process-environment value of `name` as a named profile may see it: values `loadStartupEnv` copied from the
   * default profile's `.env` belong to that profile only, so they never count for another profile.
   */
  /** `cleared`: the variable a key delete clears, which also retires its `.env`-owned startup copy (TAL-641). */
  private processEnv(name: string, profileHome: string, cleared?: string): string | undefined {
    if ((name === cleared || !this.deps.isRootProfileHome(profileHome)) && homeDotenvKeys(this.deps.env).has(name)) return undefined
    return this.deps.env[name]
  }

  /**
   * Python `_provider_has_key` minus the credential pool, which `probeKey` reads from the sidecar.
   * `cleared` (TAL-641) answers for after `setProviderKey(…, null)`: that variable's `.env` entry and startup copy are gone.
   */
  providerHasKey(pid: string, config: Config, envValues: Record<string, string>, profileHome: string, cleared?: string): boolean {
    const envVar = providerEnvVar(pid)
    if (envVar) {
      if ((envVar !== cleared && valueCountsAsApiKey(pid, envValues[envVar])) || valueCountsAsApiKey(pid, this.processEnv(envVar, profileHome, cleared))) return true
      for (const alias of PROVIDER_ENV_VAR_ALIASES[pid] ?? []) if (valueCountsAsApiKey(pid, envValues[alias]) || valueCountsAsApiKey(pid, this.processEnv(alias, profileHome))) return true
    }
    const model = modelSection(config)
    if (str(model.api_key).trim() && canonicaliseProviderId(model.provider) === canonicaliseProviderId(pid) && valueCountsAsApiKey(pid, model.api_key)) return true
    const providers = dict(config.providers)
    for (const [key, value] of Object.entries(providers)) {
      if (providerIdentity(key) !== providerIdentity(pid)) continue
      if (isDict(value) && valueCountsAsApiKey(pid, value.api_key)) return true
    }
    for (const cp of customProviderEntries(config)) {
      const name = str(cp.name).trim().toLowerCase()
      if (name && (pid === name || pid === `custom:${name}` || pid === customProviderSlug(name)) && valueCountsAsApiKey(pid, cp.api_key)) return true
    }
    return false
  }

  private async authStatus(profileHome: string, pid: string): Promise<CatalogLookup<Dict>> {
    return this.poolLookup(profileHome, `auth\0${pid}`, async (sidecar) => {
      const { status } = await sidecar.call('providers.auth_status', { profile_home: profileHome, provider: pid })
      return { logged_in: status.logged_in, key_source: str(status.key_source), error: str(status.error) }
    })
  }

  /** `pooled`: the providers whose persisted credential pool holds an added account (TAL-638). */
  private async probeKey(profileHome: string, pid: string, config: Config, envValues: Record<string, string>, pooled: ReadonlySet<string>, scopedKeys: SidecarResult<'usage.pool_providers'>['keys']): Promise<KeyProbe> {
    let authoritative = true
    let hasKey = this.providerHasKey(pid, config, envValues, profileHome)
    let isOauth = OAUTH_PROVIDERS.has(pid)
    let keySource = 'none'
    let authError: string | null = null
    let removable = false
    if (isOauth) {
      keySource = 'oauth'
      const lookup = await this.authStatus(profileHome, pid)
      authoritative = lookup.authoritative
      const status = lookup.value
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
        if (valueCountsAsApiKey(pid, envValues[envVar])) {
          keySource = 'env_file'
          removable = !pooled.has(pid) && !this.providerHasKey(pid, config, envValues, profileHome, envVar)
        }
        else if (valueCountsAsApiKey(pid, this.processEnv(envVar, profileHome))) keySource = 'env_var'
        else {
          keySource = 'config_yaml'
          for (const alias of PROVIDER_ENV_VAR_ALIASES[pid] ?? []) {
            if (valueCountsAsApiKey(pid, envValues[alias])) { keySource = 'env_file'; break }
            if (valueCountsAsApiKey(pid, this.processEnv(alias, profileHome))) { keySource = 'env_var'; break }
          }
        }
      } else keySource = 'config_yaml'
    } else if (pooled.has(pid)) {
      // Python `_has_explicit_pool_credentials`: keys added with `hermes auth add` live only in the Agent's pool.
      hasKey = true
      keySource = 'credential_pool'
    } else if (isBalanceProvider(pid)) {
      if (scopedKeys[pid]?.present) { hasKey = true; keySource = 'env' }
    } else if (!providerEnvVar(pid) && /^[a-z][a-z0-9_-]{0,63}$/.test(pid)) {
      const lookup = await this.authStatus(profileHome, pid)
      authoritative = lookup.authoritative
      const status = lookup.value
      if (status?.logged_in) {
        hasKey = true
        const raw = str(status.key_source)
        keySource = ['oauth', 'env', 'config', 'token'].includes(raw) ? raw : 'oauth'
        isOauth = true
      }
    }
    return { authoritative, hasKey, keySource, authError, isOauth, removable }
  }

  /** Live model ids from the Agent for one provider, cached per profile home. */
  async liveModelIds(profileHome: string, pid: string, opts: { force?: boolean; source?: string } = {}): Promise<string[]> {
    const inputSource = this.sourceFingerprint(profileHome, false)
    if (!opts.source || opts.source !== this.sourceFingerprint(profileHome)) await this.poolProviders(profileHome)
    const key = `${profileHome}\0${pid}`
    const source = inputSource === this.sourceFingerprint(profileHome, false) ? this.sourceFingerprint(profileHome) : inputSource
    const hit = this.liveIds.get(key)
    if (this.scopedKeyAuthority.get(profileHome) === false) {
      this.liveFailed.add(`${key}\0${source}`)
      return hit?.source === source ? hit.ids : []
    }
    if (hit?.source === source && !opts.force && this.deps.now() - hit.at < hit.ttl) return hit.ids
    // A lookup started under another source answers for the old endpoint or credential; this one starts its own.
    const flightKey = `${key}\0${source}`
    const inflight = this.liveInflight.get(flightKey)
    if (inflight && !opts.force) return inflight
    const sidecar = this.deps.sidecar()
    // No sidecar is a failed lookup for this source: the ids it keeps showing never confirm a stale-model repair (TAL-542).
    if (!sidecar) { this.liveFailed.add(flightKey); return hit?.source === source && source === this.sourceFingerprint(profileHome) ? hit.ids : [] }
    const run = sidecar.call('providers.model_ids', { profile_home: profileHome, provider: pid, ...(opts.force ? { force_refresh: true } : {}) }, { timeoutMs: 30_000 })
      .then((r) => {
        if (source !== this.sourceFingerprint(profileHome)) { this.liveFailed.add(flightKey); return [] }
        if (r.fallback && hit?.source === source && hit.confirmed) { this.liveFailed.add(flightKey); return hit.ids }
        this.liveIds.set(key, { at: this.deps.now(), ids: r.model_ids, source, ttl: r.fallback ? FALLBACK_TTL_S : LIVE_TTL_S, confirmed: !r.fallback })
        // TAL-799: the Agent's curated placeholder for an unreachable catalog is a failed lookup that still lists models.
        if (r.fallback) this.liveFailed.add(flightKey)
        else this.liveFailed.delete(flightKey)
        return r.model_ids
      })
      .catch((error: unknown) => { this.deps.log(`[catalog] live model ids for ${pid} failed: ${str((error as Error).message)}`); this.liveFailed.add(flightKey); return hit?.source === source && source === this.sourceFingerprint(profileHome) ? hit.ids : [] })
      .finally(() => { this.liveInflight.delete(flightKey) })
    this.liveInflight.set(flightKey, run)
    return run
  }

  /** Whether the last live lookup for this provider under `source` failed or answered with the Agent's placeholder list. */
  private liveLookupFailed(profileHome: string, pid: string, source = this.sourceFingerprint(profileHome)): boolean {
    return this.liveFailed.has(`${profileHome}\0${pid}\0${source}`)
  }

  /**
   * TAL-288: the model-provider plugins installed and enabled in this profile, as the sidecar reads them from the Agent.
   * A failed lookup lists none, so every other provider stays usable; an id that cannot be a provider routing hint is dropped.
   */
  private async pluginProviders(profileHome: string): Promise<CatalogLookup<PluginProvider[]>> {
    return this.poolLookup(profileHome, 'plugins', async (sidecar) => {
      const { providers } = await sidecar.call('plugins.providers', { profile_home: profileHome }, { timeoutMs: PLUGIN_LIST_TIMEOUT_MS })
      return providers.filter((p, i, all) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(p.name) && all.findIndex((q) => q.name === p.name) === i)
    })
  }

  /**
   * TAL-798: the GGUFs staged for the Agent's managed llama.cpp provider, selectable before its server runs (a turn boots
   * it). Null when none are staged or the listing failed, so every other provider stays usable.
   */
  private async localModels(profileHome: string): Promise<CatalogLookup<SidecarResult<'providers.local_models'>>> {
    return this.poolLookup(profileHome, 'local-models', async (sidecar) => sidecar.call('providers.local_models', { profile_home: profileHome }, { timeoutMs: PLUGIN_LIST_TIMEOUT_MS }))
  }

  /** Python `get_providers`. */
  async providers(profileHome: string): Promise<{ providers: Dict[]; active_provider: string | null; availability: CatalogAvailability }> {
    return structuredClone((await this.providerRows(profileHome)).payload)
  }

  /** The cached `providers` answer, shared with `quotas`; callers never mutate it. */
  private async providerRows(profileHome: string, pool?: CatalogLookup<SidecarResult<'usage.pool_providers'>>): Promise<{ payload: { providers: Dict[]; active_provider: string | null; availability: CatalogAvailability }; pooled: string[] | null }> {
    const config = await this.deps.config.read(profileHome)
    const envValues = loadEnvFile(join(profileHome, '.env'))
    pool ??= await this.poolProviders(profileHome)
    const source = this.sourceFingerprint(profileHome)
    const cacheKey = source
    const hit = this.providersCache.get(profileHome)
    if (pool.authoritative && hit?.key === cacheKey && this.deps.now() - hit.at < PROVIDERS_TTL_S) return hit
    const pooledIds = pool.value?.providers ?? null
    const pluginLookup = await this.pluginProviders(profileHome)
    let authoritative = pool.authoritative && pluginLookup.authoritative
    const pooled = new Set(pooledIds ?? [])
    const active = activeProviderFromConfig(config)
    const known = new Set<string>([...Object.keys(PROVIDER_DISPLAY), ...Object.keys(PROVIDER_MODELS), ...OAUTH_PROVIDERS])
    // A plugin never stands in for a built-in provider, by id or alias (that would route to the built-in's billing); it
    // does own a `providers.<id>` config entry.
    const plugins = (pluginLookup.value ?? []).filter((p) => !known.has(p.name) && !known.has(providerIdentity(p.name)))
    const pluginIds = new Set(plugins.map((p) => p.name))
    const providersCfg = dict(config.providers)
    for (const key of Object.keys(providersCfg)) {
      const identity = canonicaliseProviderId(key)
      const id = known.has(identity) ? identity : key
      if (!pluginIds.has(id)) known.add(id)
    }
    const rows: Dict[] = []
    for (const pid of [...known].sort()) {
      const probe = await this.probeKey(profileHome, pid, config, envValues, pooled, pool.value?.keys ?? {})
      authoritative &&= probe.authoritative
      if (pid === 'openai' && !probe.hasKey && looksLikeCodexOauthToken(str(envValues[providerEnvVar('openai') ?? ''] ?? this.deps.env.OPENAI_API_KEY))) continue
      const configured = probe.hasKey || selfHostedEndpoint(pid, config)
      let models: ModelEntry[] = pid === 'openrouter' ? FALLBACK_MODELS.map((m) => ({ id: m.id, label: m.label })) : [...(PROVIDER_MODELS[pid] ?? [])]
      let modelsTotal = models.length
      // Python: the card prefers the live catalog for every keyed provider (exactly like the picker), keeping the
      // static list as the cold/failed-probe fallback; Nous renders a featured subset with the full count.
      if (configured && (probe.isOauth || pid === 'lmstudio' || pid === 'nous' || !BESPOKE_CATALOG_PROVIDERS.has(pid))) {
        const live = await this.liveModelIds(profileHome, pid, { source })
        if (live.length) {
          models = pid === 'nous' ? live.slice(0, 25).map((id) => ({ id: `@nous:${id}`, label: `${formatOllamaLabel(id.includes('/') ? id.slice(id.indexOf('/') + 1) : id)} (via Nous)` })) : live.map((id) => ({ id, label: labelForModel(id, []) }))
          modelsTotal = live.length
        }
      }
      const providerCfg = dict(providersCfg[pid] ?? providersCfg[Object.keys(providersCfg).find((k) => providerIdentity(k) === providerIdentity(pid)) ?? ''])
      // Python: `providers.<id>.models` from config.yaml reach the card (alias-aware), minus ids already published.
      if ('models' in providerCfg) {
        const seen = new Set(models.map((m) => unqualifiedModelId(m.id)))
        const added = configuredModelIds(providerCfg.models).filter((id) => !seen.has(unqualifiedModelId(id))).map((id) => ({ id, label: id }))
        models = [...models, ...added]
        if (pid !== 'nous') modelsTotal += added.length
      }
      const baseUrl = configuredBaseUrl(pid, config) || null
      rows.push({
        id: pid,
        display_name: displayName(pid),
        has_key: probe.hasKey,
        configured,
        configurable: !probe.isOauth && Boolean(providerEnvVar(pid)),
        is_oauth: probe.isOauth,
        is_plugin_provider: false,
        is_self_hosted: SELF_HOSTED_PROVIDER_IDS.has(pid),
        is_custom: false,
        key_source: probe.keySource,
        removable: probe.removable && !SELF_HOSTED_PROVIDER_IDS.has(pid),
        base_url: baseUrl,
        auth_error: probe.authError,
        env_var: providerEnvVar(pid),
        models,
        models_total: modelsTotal,
      })
    }
    // TAL-288: a plugin is selectable only once the Agent reports its setup ready; it never borrows a built-in's key.
    for (const plugin of plugins) {
      const ready = plugin.setup === 'ready'
      const live = ready ? await this.liveModelIds(profileHome, plugin.name) : []
      rows.push({
        id: plugin.name, display_name: plugin.display_name || plugin.name, has_key: ready, configured: ready,
        configurable: false, is_oauth: false, is_plugin_provider: true, is_self_hosted: false, is_custom: false, key_source: ready ? 'plugin' : 'none', removable: false,
        base_url: null, auth_error: plugin.setup === 'ready' ? (live.length ? null : PLUGIN_NO_MODELS) : PLUGIN_SETUP_ERRORS[plugin.setup], env_var: null,
        models: live.map((id) => ({ id, label: labelForModel(id, []) })), models_total: live.length,
      })
    }
    for (const cp of customProviderEntries(config)) {
      const name = str(cp.name).trim()
      if (!name) continue
      const slug = customProviderSlug(name) || 'custom'
      const ids = [str(cp.model).trim(), ...configuredModelIds(cp.models)].filter((v, i, a) => v && a.indexOf(v) === i)
      // Python: an `api_key: ${VAR}` reference counts when the variable resolves.
      const cpKey = str(cp.api_key).trim()
      const envRef = /^\$\{([^}]+)\}$/.exec(cpKey)?.[1] ?? ''
      const yamlKey = !envRef && valueCountsAsApiKey(slug, cp.api_key)
      const hasKey = envRef ? Boolean((this.processEnv(envRef, profileHome) ?? '').trim()) : yamlKey || Boolean(str(cp.key_env).trim() && this.processEnv(str(cp.key_env).trim(), profileHome))
      // TAL-603: a `${VAR}` reference or `key_env` credential comes from the environment.
      const keySource = yamlKey ? 'config_yaml' : hasKey ? 'env_var' : cpKey ? 'config_yaml' : 'none'
      rows.push({
        id: slug, display_name: name, has_key: hasKey, configured: hasKey,
        configurable: false, is_oauth: false, is_plugin_provider: false, is_self_hosted: false, is_custom: true, key_source: keySource, removable: false,
        base_url: str(cp.base_url).trim() || null, auth_error: null, env_var: null, models: ids.map((id) => ({ id, label: labelForModel(id, []) })), models_total: ids.length,
      })
    }
    // Python `_provider_sort_key`: active first, then `custom:*`, then keyed providers, then the rest (alphabetical within).
    const rank = (p: Dict): number => (str(p.id) === active ? 0 : str(p.id).startsWith('custom:') ? 1 : p.has_key ? 2 : 3)
    rows.sort((a, b) => rank(a) - rank(b) || (str(a.id) < str(b.id) ? -1 : str(a.id) > str(b.id) ? 1 : 0))
    for (const row of rows) {
      row.models = stampModelEntries(row.models as ModelEntry[], str(row.id))
      // TAL-603: the server decides the Active badge, the key badge and the count; a featured list never outnumbers its total.
      row.is_active = str(row.id) === active
      row.key_source_kind = keySourceKind(row)
      row.models_total = Math.max(Number(row.models_total), (row.models as ModelEntry[]).length)
    }
    authoritative &&= source === this.sourceFingerprint(profileHome)
    const availability = this.availability(source, authoritative, Boolean(pool.value))
    const entry = { at: this.deps.now(), key: cacheKey, payload: { providers: rows, active_provider: active, availability }, pooled: pooledIds }
    if (authoritative) this.providersCache.set(profileHome, entry)
    return entry
  }

  /** Python `get_available_models` (static catalog + live ids for keyed providers). */
  async models(profileHome: string, attempt = 0): Promise<ModelsCatalog> {
    const generation = this.modelGenerations.get(profileHome) ?? 0
    this.modelGenerations.set(profileHome, generation)
    const inputSource = this.sourceFingerprint(profileHome, false)
    const pool = await this.poolProviders(profileHome)
    if (generation !== this.modelGenerations.get(profileHome) || inputSource !== this.sourceFingerprint(profileHome, false)) {
      if (attempt === 0) return this.models(profileHome, 1)
      throw new Error('Provider configuration changed during catalog lookup. Try again.')
    }
    const source = this.sourceFingerprint(profileHome)
    const key = `${source}\0${generation}`
    const pending = this.modelReads.get(key)
    if (pending) return structuredClone(await pending)
    const read = this.buildModels(profileHome, pool, source, generation, attempt).finally(() => { this.modelReads.delete(key) })
    this.modelReads.set(key, read)
    return structuredClone(await read)
  }

  private async buildModels(profileHome: string, pool: CatalogLookup<SidecarResult<'usage.pool_providers'>>, source: string, generation: number, attempt: number): Promise<ModelsCatalog> {
    const providerState = (await this.providerRows(profileHome, pool)).payload
    const unconfirmed = new Set<string>()
    const config = await this.deps.config.read(profileHome)
    const envValues = loadEnvFile(join(profileHome, '.env'))
    const model = modelSection(config)
    const defaultModel = effectiveDefaultModel(config, this.deps.env)
    const cfgBaseUrl = str(model.base_url).trim()
    const localLookup = await this.localModels(profileHome)
    const local = localLookup.value?.models.length ? localLookup.value : null
    const configured = activeProviderFromConfig(config)
    // A `custom` main model at the running local server's endpoint is that server: its Local group owns the selection.
    const atLocalServer = configured === 'custom' && Boolean(cfgBaseUrl) && cfgBaseUrl.replace(/\/+$/, '') === str(local?.current_endpoint).replace(/\/+$/, '')
    const active = local && atLocalServer ? local.provider_id : configured
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
    if (local) detected.add(local.provider_id)
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
      if (canonical && this.providerHasKey(canonical, config, envValues, profileHome)) detected.add(canonical)
    }
    // Python: OAuth providers the Agent reports as logged in join the picker with their live catalog (#1567, #2545); so do
    // ready plugin providers (TAL-288), under their own name, and providers keyed only through the credential pool (TAL-638).
    const signedIn = new Set<string>()
    const pluginNames = new Map<string, string>()
    for (const row of providerState.providers) {
      if (row.has_key !== true || (row.is_oauth !== true && row.is_plugin_provider !== true && row.key_source !== 'credential_pool' && row.key_source !== 'env')) continue
      signedIn.add(str(row.id))
      if (row.is_plugin_provider === true) pluginNames.set(str(row.id), str(row.display_name) || str(row.id))
    }
    for (const pid of signedIn) detected.add(pid)
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
    // TAL-911: Agent pickers drop `model_catalog.excluded_providers` under any of their aliases, the active provider included.
    const excludedCfg = dict(config.model_catalog).excluded_providers
    const excluded = new Set(Array.isArray(excludedCfg) ? excludedCfg.map(providerIdentity).filter(Boolean) : [])
    const isExcluded = (pid: unknown): boolean => excluded.has(providerIdentity(pid))
    const pickerDefault = isExcluded(active) || isExcluded(parseProviderQualifiedModel(defaultModel)?.[1]) ? '' : defaultModel
    const groups: ModelGroup[] = []
    for (const pid of [...detected].map((p) => (p.startsWith('custom') || pluginNames.has(p) ? p : canonicaliseProviderId(p) || p)).filter((v, i, a) => v && a.indexOf(v) === i).sort()) {
      if (isExcluded(pid)) continue
      if (pid.startsWith('custom:')) {
        const g = namedCustom.get(pid)
        const models = [...(g?.models ?? [])]
        if (models.length || pid === active) groups.push({ provider: g?.name ?? pid.replace('custom:', ''), provider_id: pid, models: applyProviderPrefix(models, pid, active) })
        continue
      }
      if (pid === local?.provider_id) {
        // A GGUF's id is its file name, quant tag included (`Q4_K_M`); prettifying would mangle it.
        groups.push({ provider: 'Local', provider_id: pid, models: applyProviderPrefix(local.models.map((id) => ({ id, label: id })), pid, active) })
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
      let allowFallback = false
      if ('models' in providerCfg && providerCfg.models_discovered !== true) raw = configuredModelOptions(providerCfg.models)
      if (!raw.length) {
        // TAL-799: a provider without credentials lists the Agent's curated catalog too; the static tables only cover a missing sidecar.
        const keyed = this.providerHasKey(pid, config, envValues, profileHome) || selfHostedEndpoint(pid, config) || signedIn.has(pid)
        const live = await this.liveModelIds(profileHome, pid, { source })
        const failed = this.liveLookupFailed(profileHome, pid, source)
        // TAL-542: a failed lookup, or a curated list no account confirmed, leaves this group unconfirmed, so the stale-model repair never trusts it.
        allowFallback = failed || !keyed
        if (allowFallback) unconfirmed.add(pid)
        if (live.length) raw = live.map((id) => ({ id, label: pid === 'nous' ? `${formatOllamaLabel(id.includes('/') ? id.slice(id.indexOf('/') + 1) : id)} (via Nous)` : labelForModel(id, []) }))
        // Python (#1567): an authenticated Nous account with an empty live catalog shows no group; only a failed lookup falls back to the curated list.
        else if (keyed && pid === 'nous' && !failed) continue
      }
      if (!raw.length && allowFallback) raw = pid === 'openrouter' ? FALLBACK_MODELS.map((m) => ({ id: m.id, label: m.label })) : [...(PROVIDER_MODELS[pid] ?? [])]
      for (const id of configuredIds.get(pid) ?? []) if (!raw.some((m) => m.id === id)) raw.push({ id, label: labelForModel(id, groups) })
      if (raw.length) groups.push({ provider: pluginNames.get(pid) ?? displayName(pid), provider_id: pid, models: applyProviderPrefix(raw, pid, active) })
    }
    if (pickerDefault) {
      const all = new Set(groups.flatMap((g) => g.models.map((m) => m.id)))
      if (!all.has(defaultModel) && !all.has(`@${active ?? ''}:${defaultModel}`)) {
        const label = labelForModel(defaultModel, groups)
        const target = groups.find((g) => g.provider_id === active)
        if (target) target.models.unshift({ id: defaultModel, label })
        else if (groups.length) groups.push({ provider: 'Default', provider_id: active ?? 'default', models: [{ id: defaultModel, label }] })
      }
    }
    deduplicateModelIds(groups)
    // Python: every group is split into visible rows plus `extra_models`; Nous decorates its label with "(15 of N)".
    const selectedId = str(model.model).trim() || defaultModel
    for (const g of groups) {
      const [visible, extras] = splitPickerOverflow(g.models, selectedId, g.provider_id)
      g.models = visible
      if (extras.length) {
        g.extra_models = extras
        if (g.provider_id === 'nous') g.provider = `${g.provider} (${String(visible.length)} of ${String(visible.length + extras.length)})`
      }
    }
    const kept = groups.filter((g) => g.models.length || g.provider_id.startsWith('custom:'))
    const withKeys = new Set<string>()
    for (const [k, v] of Object.entries(providersCfg)) if (isDict(v) && (v.api_key || v.key_env || v.base_url)) { const c = canonicaliseProviderId(k); if (c) withKeys.add(c) }
    const rank = (g: ModelGroup): number => (g.provider_id === active ? 0 : g.provider_id.startsWith('custom:') ? 1 : withKeys.has(g.provider_id) ? 2 : 3)
    kept.sort((a, b) => rank(a) - rank(b) || (a.provider_id < b.provider_id ? -1 : a.provider_id > b.provider_id ? 1 : 0))
    const aliases: Record<string, string> = {}
    const rawAliases = model.aliases
    if (isDict(rawAliases)) for (const [k, v] of Object.entries(rawAliases)) if (k && v) aliases[k.trim()] = str(v).trim()
    const [defaultBare, defaultProvider] = parseProviderQualifiedModel(defaultModel) ?? [defaultModel, active]
    if (source !== this.sourceFingerprint(profileHome)) {
      if (attempt === 0) return this.models(profileHome, 1)
      throw new Error('Provider configuration changed during catalog lookup. Try again.')
    }
    if (!providerState.availability.authoritative || !localLookup.authoritative) for (const g of kept) unconfirmed.add(g.provider_id)
    const previous = this.currentModels(profileHome)
    const availability = this.availability(source, providerState.availability.authoritative && localLookup.authoritative && !unconfirmed.size && source === this.sourceFingerprint(profileHome), previous?.availability?.status === 'available' || previous?.availability?.status === 'stale')
    for (const g of kept) g.availability = this.availability(source, !unconfirmed.has(g.provider_id) && providerState.availability.authoritative, Boolean(previous?.groups.some((old) => old.provider_id === g.provider_id && old.availability?.status !== 'unavailable')))
    const defaults = { availability, active_provider: active, default_model: defaultModel, default_provider_id: defaultProvider, default_bare_id: defaultBare }
    if (!kept.length && pickerDefault) {
      const providerId = active ?? 'default'
      return this.remember(profileHome, { source, generation, unconfirmed, attempt }, { ...defaults, groups: [{ provider: 'Default', provider_id: providerId, models: stampModelEntries([{ id: defaultModel, label: labelForModel(defaultModel, []) }], providerId) }], aliases: {}, configured_model_badges: {} })
    }
    const stamped = kept.map((g) => ({ ...g, models: stampModelEntries(g.models, g.provider_id), ...(g.extra_models ? { extra_models: stampModelEntries(g.extra_models, g.provider_id) } : {}) }))
    return this.remember(profileHome, { source, generation, unconfirmed, attempt }, { ...defaults, groups: stamped, aliases, configured_model_badges: this.badges(kept, active, defaultModel, fallbackCfg) })
  }

  private readonly pickerLimitsCache = new Map<string, { source: string; at?: number; limits: SidecarResult<'usage.limits'>['limits']; read?: Promise<void> }>()

  /** Bounded, shared pool-limit reads; a warm picker serves its snapshot during refresh. */
  private async pickerLimits(profileHome: string, providers: SidecarParams<'usage.limits'>['providers']): Promise<SidecarResult<'usage.limits'>['limits']> {
    const fingerprint = this.sourceFingerprint(profileHome)
    const source = JSON.stringify([fingerprint, providers])
    let cached = this.pickerLimitsCache.get(profileHome)
    if (cached?.source !== source) {
      cached = { source, limits: {} }
      this.pickerLimitsCache.set(profileHome, cached)
    }
    const entry = cached
    if ((entry.at === undefined || this.deps.now() - entry.at >= ACCOUNT_USAGE_CACHE_TTL_S) && !entry.read) {
      entry.read = (async () => {
        try {
          const sidecar = this.deps.sidecar()
          entry.limits = sidecar ? (await sidecar.call('usage.limits', { profile_home: profileHome, providers }, { timeoutMs: 3_000 })).limits : {}
        } catch (error) {
          entry.limits = {}
          this.deps.log(`[catalog] pool limits failed: ${str((error as Error).message)}`)
        }
        entry.at = this.deps.now()
      })().finally(() => { delete entry.read })
    }
    if (entry.at === undefined) await entry.read
    return fingerprint === this.sourceFingerprint(profileHome) && this.pickerLimitsCache.get(profileHome) === entry ? entry.limits : {}
  }

  /** TAL-807: the picker adds pool limits and quota levels without storing them in the model catalog. */
  async pickerModels(profileHome: string, profile: string): Promise<ModelsCatalog> {
    const catalog = await this.models(profileHome)
    const entries = (g: ModelGroup): ModelEntry[] => [...g.models, ...(g.extra_models ?? [])]
    const providers = catalog.groups.map((g) => ({ slug: g.provider_id, models: entries(g).map((e) => e.bare_id ?? e.id) }))
    const limits = await this.pickerLimits(profileHome, providers)
    const active = (resetsAt: string): boolean => Date.parse(resetsAt) / 1000 > this.deps.now()
    for (const g of catalog.groups) {
      const limit = limits[g.provider_id]
      if (limit?.scope === 'account' && active(limit.resets_at)) g.limit = limit
      if (limit?.scope === 'models') {
        // The sidecar answers by bare id; the picker names entries by id.
        const cooled: Record<string, string> = {}
        for (const e of entries(g)) {
          const resetsAt = limit.models[e.bare_id ?? e.id]
          if (resetsAt && active(resetsAt)) { e.limit = { scope: 'model', resets_at: resetsAt }; cooled[e.id] = resetsAt }
        }
        if (Object.keys(cooled).length) g.limit = { scope: 'models', models: cooled }
      }
    }
    const thresholds = (await this.deps.quotaThresholds?.(profile)) ?? QUOTA_THRESHOLD_DEFAULTS
    // An account limit already says the login is out; the quota level would only repeat it.
    const levels = await Promise.all(catalog.groups.map((g) => (g.limit?.scope === 'account' ? Promise.resolve(null) : this.pickerQuotaLevel(profileHome, g.provider_id, thresholds))))
    catalog.groups.forEach((g, i) => { const level = levels[i]; if (level) g.quota_level = level })
    return catalog
  }

  /** TAL-807: account-usage reads the picker started, by `accountUsageCache` key. */
  private readonly pickerUsageReads = new Map<string, Promise<void>>()

  /**
   * TAL-807: the TAL-411 `remaining` level of the tightest account-scope window in the provider's cached account-usage
   * read; a model-family window (Opus or Sonnet weekly) never counts. A read past the cache TTL starts a new one, which
   * the picker waits for only when it has no read at all, and then for at most `PICKER_USAGE_WAIT_MS`; one past
   * `PICKER_USAGE_MAX_AGE_S` shows nothing.
   */
  private async pickerQuotaLevel(profileHome: string, pid: string, t: QuotaThresholds): Promise<QuotaLevel | null> {
    if (!ACCOUNT_USAGE_PROVIDERS.has(pid)) return null
    const key = `${profileHome}\0${pid}\0`
    let cached = this.accountUsageCache.get(key)
    if (cached?.source !== this.sourceFingerprint(profileHome)) cached = undefined
    if (!cached || this.deps.now() - cached.at > ACCOUNT_USAGE_CACHE_TTL_S) {
      let read = this.pickerUsageReads.get(key)
      if (!read) {
        read = this.quota(profileHome, pid).then(() => undefined, () => undefined).finally(() => this.pickerUsageReads.delete(key))
        this.pickerUsageReads.set(key, read)
      }
      if (!cached) {
        let timer: NodeJS.Timeout | undefined
        await Promise.race([read, new Promise<void>((resolve) => { timer = setTimeout(resolve, PICKER_USAGE_WAIT_MS) })])
        clearTimeout(timer)
        cached = this.accountUsageCache.get(key)
      }
    }
    const limits = cached?.limits
    if (cached?.source !== this.sourceFingerprint(profileHome) || !limits?.available || this.deps.now() - cached.at > PICKER_USAGE_MAX_AGE_S) return null
    const raw = (Array.isArray(limits.windows) ? limits.windows : []).filter((w) => isDict(w) && w.scope !== 'model')
    const tightest = normalizeQuotaWindows(raw, this.deps.now()).windows
      .reduce<QuotaWindow | undefined>((a, w) => (w.remaining_percent !== null && w.remaining_percent < (a?.remaining_percent ?? Infinity) ? w : a), undefined)
    return tightest ? quotaLevel(tightest, limits.stale ? 'stale' : 'available', 'remaining', t) : null
  }

  /** Stamps the default's entry id and keeps the catalog for `modelOptionFor`. */
  private async remember(profileHome: string, meta: { source: string; generation: number; unconfirmed: ReadonlySet<string>; attempt: number }, catalog: ModelsCatalog): Promise<ModelsCatalog> {
    if (catalog.availability) for (const group of catalog.groups) group.availability ??= catalog.availability
    await this.stampSpeedTiers(profileHome, catalog.groups.flatMap((g) => [...g.models, ...(g.extra_models ?? [])]))
    if (meta.generation !== this.modelGenerations.get(profileHome) || meta.source !== this.sourceFingerprint(profileHome)) {
      if (meta.attempt === 0) return this.models(profileHome, 1)
      throw new Error('Provider configuration changed during catalog lookup. Try again.')
    }
    catalog.default_option_id = catalogOptionId(catalog, catalog.default_bare_id ?? null, catalog.default_provider_id ?? null)
    this.lastModels.set(profileHome, catalog)
    this.lastModelsMeta.set(profileHome, { source: meta.source, unconfirmed: meta.unconfirmed, at: this.deps.now() })
    return structuredClone(catalog)
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
  async liveModels(profileHome: string, providerRaw: string, attempt = 0): Promise<Dict> {
    const fingerprint = this.sourceFingerprint(profileHome)
    const config = await this.deps.config.read(profileHome)
    let provider = providerRaw.trim().toLowerCase() || str(modelSection(config).provider).trim().toLowerCase()
    if (!provider) return { error: 'no_provider', models: [] }
    provider = resolveProviderAlias(provider)
    let ids = await this.liveModelIds(profileHome, provider)
    if (fingerprint !== this.sourceFingerprint(profileHome)) return attempt === 0 ? this.liveModels(profileHome, providerRaw, 1) : { availability: this.availability(this.sourceFingerprint(profileHome), false, false), provider, source: 'unavailable', models: [], count: 0 }
    let source = this.liveLookupFailed(profileHome, provider, fingerprint) ? 'fallback' : 'live'
    if (!ids.length) {
      const fromConfig: string[] = []
      if (provider === 'custom' || provider.startsWith('custom:')) {
        for (const cp of customProviderEntries(config)) {
          const slug = customProviderSlug(cp.name)
          if ((provider.startsWith('custom:') && slug === provider) || (provider === 'custom' && !slug)) fromConfig.push(...[str(cp.model).trim(), ...configuredModelIds(cp.models)].filter(Boolean))
        }
      }
      if (fromConfig.length) { ids = [...new Set(fromConfig)]; source = 'config' }
      else if (source === 'fallback') { ids = (PROVIDER_MODELS[provider] ?? []).map((m) => m.id); source = 'static' }
    }
    if (provider !== 'nous' && ids.length > MODEL_PICKER_OVERFLOW_THRESHOLD) ids = ids.slice(0, MODEL_PICKER_VISIBLE_TARGET)
    const models = stampModelEntries(ids.filter(Boolean).map((id) => ({ id, label: labelForModel(id, []) })), provider)
    await this.stampSpeedTiers(profileHome, models)
    if (fingerprint !== this.sourceFingerprint(profileHome)) return attempt === 0 ? this.liveModels(profileHome, providerRaw, 1) : { availability: this.availability(this.sourceFingerprint(profileHome), false, false), provider, source: 'unavailable', models: [], count: 0 }
    return { availability: this.availability(fingerprint, source === 'live' || source === 'config', source === 'fallback' && models.length > 0), provider, source, models, count: models.length }
  }

  private async stampSpeedTiers(profileHome: string, entries: ModelEntry[]): Promise<void> {
    if (!entries.length) return
    const config = await this.deps.config.read(profileHome)
    // An unavailable Agent offers no paid tier; writes still require a successful lookup.
    const tiers = await this.deps.config.speedTiers(profileHome, config, entries.map((e) => ({ model: e.bare_id ?? e.id, provider: e.provider_id ?? '' }))).catch(() => [])
    entries.forEach((entry, i) => {
      entry.supported_speed_tiers = tiers[i] ?? []
      entry.supports_fast_tier = entry.supported_speed_tiers.some((t) => t.service_tier === 'priority')
    })
  }

  /**
   * Python `_resolve_model_context_length` inputs: the effective base URL, key, and any configured window for this
   * model under this profile (`model.context_length`, `providers.<p>.models[].context_length`, custom providers).
   */
  async contextLengthInputs(profileHome: string, model: string, provider: string | null): Promise<{ base_url?: string; api_key?: string; config_context_length?: number | null }> {
    // An unreadable config is an error (the caller answers with no context length), never "no custom endpoint".
    const config = await this.deps.config.read(profileHome)
    const section = modelSection(config)
    const pid = canonicaliseProviderId(provider ?? section.provider) || null
    const bare = unqualifiedModelId(model)
    const positive = (v: unknown): number | null => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n > 0 ? n : null }
    const fromModels = (models: unknown): number | null => {
      if (isDict(models)) { for (const key of [model, bare]) { const e = models[key]; const n = positive(isDict(e) ? e.context_length : e); if (n !== null) return n } }
      if (Array.isArray(models)) for (const e of models) if (isDict(e) && [model, bare].includes(str(e.id || e.model || e.name).trim())) { const n = positive(e.context_length); if (n !== null) return n }
      return null
    }
    let baseUrl = ''
    let configContextLength: number | null = null
    const sectionModel = str(section.default || (typeof config.model === 'string' ? config.model : '')).trim()
    if (sectionModel && [model, bare].includes(unqualifiedModelId(sectionModel))) configContextLength = positive(section.context_length)
    if (!pid || canonicaliseProviderId(section.provider) === pid) baseUrl = str(section.base_url).trim()
    if (pid) {
      const providersCfg = dict(config.providers)
      const key = Object.keys(providersCfg).find((k) => canonicaliseProviderId(k) === pid)
      const providerCfg = key ? dict(providersCfg[key]) : {}
      if (!baseUrl) baseUrl = str(providerCfg.base_url).trim()
      configContextLength ??= fromModels(providerCfg.models)
    }
    for (const cp of customProviderEntries(config)) {
      const name = str(cp.name).trim().toLowerCase()
      if (!name || !(pid === name || pid === `custom:${name}` || pid === customProviderSlug(name) || (Boolean(baseUrl) && str(cp.base_url).trim().replace(/\/+$/, '') === baseUrl.replace(/\/+$/, '')))) continue
      if (!baseUrl) baseUrl = str(cp.base_url).trim()
      configContextLength ??= fromModels(cp.models)
    }
    const apiKey = pid ? this.apiKeyFor(pid, profileHome, config) : null
    return { ...(baseUrl ? { base_url: baseUrl } : {}), ...(apiKey ? { api_key: apiKey } : {}), config_context_length: configContextLength }
  }

  private apiKeyFor(pid: string, profileHome: string, config: Config): string | null {
    const envValues = loadEnvFile(join(profileHome, '.env'))
    const envVar = providerEnvVar(pid)
    if (envVar) {
      for (const name of [envVar, ...(PROVIDER_ENV_VAR_ALIASES[pid] ?? [])]) {
        const v = str(envValues[name] ?? this.processEnv(name, profileHome)).trim()
        // A reference owns this slot; only the Agent can resolve it before lower-priority keys.
        if (v) return v.startsWith('op://') ? null : v
      }
    }
    // The same config sources `providerHasKey` counts, so a provider shown as keyed resolves its key.
    const model = modelSection(config)
    if (canonicaliseProviderId(model.provider) === canonicaliseProviderId(pid) && valueCountsAsApiKey(pid, model.api_key)) return str(model.api_key).trim().startsWith('op://') ? null : str(model.api_key).trim()
    for (const [key, value] of Object.entries(dict(config.providers))) {
      if (providerIdentity(key) === providerIdentity(pid) && isDict(value) && valueCountsAsApiKey(pid, value.api_key)) return str(value.api_key).trim().startsWith('op://') ? null : str(value.api_key).trim()
    }
    return null
  }

  /** A raw key or the names the Agent resolves inside the profile's secret scope. */
  private usageKey(pid: string, apiKey: string | null): Pick<SidecarParams<'usage.pool'>, 'api_key' | 'env_vars'> {
    const envVar = providerEnvVar(pid)
    return apiKey ? { api_key: apiKey } : { env_vars: envVar ? [envVar, ...(PROVIDER_ENV_VAR_ALIASES[pid] ?? [])] : [] }
  }

  /** Account-usage snapshots by profile home, provider, and pool account. */
  private readonly accountUsageCache = new Map<string, { at: number; limits: Dict | null; source: string; sequence: number }>()
  private quotaReadSequence = 0

  /**
   * Python `get_provider_quota`. `credential` scopes the read to one credential-pool account (TAL-548): a benched account
   * answers with its local pool state, and every other read uses that account's key.
   */
  async quota(profileHome: string, providerRaw: string | null, opts: { refresh?: boolean; at?: number; credential?: PoolEntry | null; sequence?: number } = {}): Promise<Dict> {
    const sequence = opts.sequence ?? ++this.quotaReadSequence
    const at = opts.at ?? this.deps.now()
    const computed_at = isoAt(at)
    const config = await this.deps.config.read(profileHome)
    const provider = (providerRaw ?? activeProviderFromConfig(config) ?? '').trim().toLowerCase()
    if (!provider) return { computed_at, ok: false, provider: null, display_name: null, supported: false, status: 'unavailable', quota: null, message: 'No active provider is configured.' }
    const name = displayName(provider)
    const credential = opts.credential ?? null
    const answer = (ok: boolean, status: string, message: string, extra: Dict = {}): Dict => ({ computed_at, ok, provider, display_name: name, supported: true, status, quota: null, ...extra, message })
    if (credential && credential.status !== 'available') {
      return answer(false, 'unavailable', `${name} credential is unavailable. ${str(credential.unavailable_reason)}`.trim(), { account_limits: poolEntryLimits(credential, at) })
    }
    if (ACCOUNT_USAGE_PROVIDERS.has(provider)) {
      const sidecar = this.deps.sidecar()
      let limits: Dict | null = null
      // Python `_ACCOUNT_USAGE_CACHE_TTL_SECONDS`: a snapshot answers repeat polls for 45 s unless `refresh` is set.
      const cacheKey = `${profileHome}\0${provider}\0${credential?.credential_id ?? ''}`
      const hit = this.accountUsageCache.get(cacheKey)
      const source = this.sourceFingerprint(profileHome)
      const cached = hit?.source === source ? hit : undefined
      if (cached && !opts.refresh && this.deps.now() - cached.at <= ACCOUNT_USAGE_CACHE_TTL_S) limits = cached.limits
      else if (sidecar) {
        try {
          const params = { profile_home: profileHome, provider, ...(opts.refresh ? { refresh: true } : {}), ...(credential ? { credential_id: credential.credential_id } : {}) }
          const snapshot = (await sidecar.call('usage.account', params, { timeoutMs: 35_000 })).snapshot
          if (snapshot) limits = { ...snapshot, title: str(snapshot.title) || 'Account limits', available: snapshot.available && !str(snapshot.unavailable_reason) }
        } catch (error) {
          limits = { available: false, unavailable_reason: str((error as Error).message), windows: [], details: [] }
        }
        if (source === this.sourceFingerprint(profileHome)) {
          if ((this.accountUsageCache.get(cacheKey)?.sequence ?? -1) <= sequence) this.accountUsageCache.set(cacheKey, { at: this.deps.now(), limits, source, sequence })
        }
        else limits = null
      }
      // The cache keeps the Agent's raw windows; pace is recomputed as of every response.
      if (limits) limits = { ...limits, ...normalizeQuotaWindows(limits.windows, at), fetched_at: isoUtc(limits.fetched_at) }
      if (limits?.available) return answer(true, limits.stale ? 'stale' : 'available', limits.stale ? `${name} refresh failed; showing last-known account limits.` : `${name} account limits loaded.`, { label: limits.title, account_limits: limits })
      const reason = str(limits?.unavailable_reason).trim()
      return answer(false, 'unavailable', reason ? `${name} account limits are unavailable. ${reason}` : `${name} account limits are unavailable. Confirm provider authentication and try again.`, { account_limits: limits })
    }
    if (isBalanceProvider(provider)) {
      const apiKey = this.apiKeyFor(provider, profileHome, config)
      const key = credential ? { credential_id: credential.credential_id } : this.usageKey(provider, apiKey)
      const read = await this.balance(profileHome, provider, key)
      const status = read?.status === 'no_key' ? 'no_key' : read?.status === 'ok' ? 'ok' : read?.status === 'http_error' ? read.http_status : null
      if (provider === 'openrouter') {
        if (status === 'no_key') return answer(false, 'no_key', 'OpenRouter quota status needs an OPENROUTER_API_KEY configured on the server.')
        if (status === 'ok' && read?.quota) {
          // The cost chart follows the configured key, so another pool account's spend never lands in it.
          if (!credential || credential.matches_api_key) this.recordCostSnapshot(profileHome, read.quota, at)
          return answer(true, 'available', 'OpenRouter quota status loaded.', { label: 'OpenRouter credits', quota: read.quota })
        }
        return status === 401 || status === 403 ? answer(false, 'invalid_key', 'OpenRouter rejected the configured API key.') : answer(false, 'unavailable', 'OpenRouter quota status is temporarily unavailable.')
      }
      if (provider === 'deepseek') {
        if (status === 'no_key') return answer(false, 'no_key', 'DeepSeek balance needs a DEEPSEEK_API_KEY configured on the server.', { balances: [] })
        if (status === 'ok' && read) {
          const available = read.is_available === true
          return answer(available, available ? 'available' : 'exhausted', available ? 'DeepSeek balance loaded.' : 'DeepSeek balance is exhausted.', { label: 'DeepSeek balance', balances: read.balances })
        }
        return status === 401 || status === 403 ? answer(false, 'invalid_key', 'DeepSeek rejected the configured API key.', { balances: [] }) : answer(false, 'unavailable', 'DeepSeek balance is temporarily unavailable.', { balances: [] })
      }
      if (status === 'no_key') return answer(false, 'no_key', 'OpenCode Go account limits need an API key configured on the server.', { account_limits: null })
      if (status === 'ok' && read) {
        // Python `_sanitize_opencode_go_account_limits`: the rolling, weekly and monthly windows of the Go plan.
        const windows = read.windows.map((w) => ({ label: OPENCODE_GO_WINDOWS[w.key][0], window_seconds: OPENCODE_GO_WINDOWS[w.key][1], used_percent: w.used_percent, reset_at: w.reset_at, detail: w.rate_limited ? 'Rate limited' : null }))
        const limits = { provider, source: 'usage_api', title: 'Account limits', plan: 'Go', details: [], available: true, unavailable_reason: null, fetched_at: isoAt(at), ...normalizeQuotaWindows(windows, at) }
        return answer(true, 'available', 'OpenCode Go account limits loaded.', { label: 'OpenCode Go usage', account_limits: limits })
      }
      if (status === 401) return answer(false, 'invalid_key', 'OpenCode Go rejected the configured API key.', { account_limits: null })
      return answer(false, 'unavailable', status === 403 ? 'OpenCode Go account limits require an active subscription.' : 'OpenCode Go account limits are temporarily unavailable.', { account_limits: null })
    }
    // Python `_local_pool_snapshot`: any other provider with a credential pool shows its accounts' local state.
    const entries = credential ? [credential] : (await this.poolEntries(profileHome, provider, null)).value?.entries ?? []
    if (entries.length) {
      const limits = credential ? poolEntryLimits(credential, at) : poolLimits(entries, at)
      return limits.available ? answer(true, 'available', `${name} credential pool status loaded.`, { label: 'Credential pool', account_limits: limits }) : answer(false, 'unavailable', `${name} credential pool: all credentials are unavailable.`, { account_limits: limits })
    }
    return { computed_at, ok: false, provider, display_name: name, supported: false, status: 'unsupported', quota: null, message: `No verified server-side quota or balance endpoint is available for ${name}.` }
  }

  /**
   * TAL-548: the provider's credential-pool accounts as the sidecar reads them locally. Each says whether it holds
   * `apiKey`, the provider's configured key. Null when the pool is unknown (see `poolLookup`).
   */
  private poolEntries(profileHome: string, pid: string, apiKey: string | null): Promise<CatalogLookup<SidecarResult<'usage.pool'>>> {
    return this.poolLookup(profileHome, `pool\0${pid}`, (sidecar) => sidecar.call('usage.pool', { profile_home: profileHome, provider: pid, ...this.usageKey(pid, apiKey) }))
  }

  /** The last answer of each credential-pool lookup, by profile home and lookup. */
  private readonly lastPoolAnswers = new Map<string, { source: string; value: unknown }>()

  /**
   * TAL-548: one credential-pool lookup through the sidecar. A failed lookup answers with the last answer to the same
   * lookup, else null: an unknown pool, never an empty one, so no pool account is ever reported as removed.
   */
  private async poolLookup<T>(profileHome: string, lookup: string, call: (sidecar: SidecarLike) => Promise<T>): Promise<CatalogLookup<T>> {
    const source = this.sourceFingerprint(profileHome)
    const key = `${profileHome}\0${lookup}`
    try {
      const sidecar = this.deps.sidecar()
      if (!sidecar) throw new Error('the sidecar is not running')
      const answer = await call(sidecar)
      if (source !== this.sourceFingerprint(profileHome)) return { value: null, authoritative: false }
      this.lastPoolAnswers.set(key, { source, value: answer })
      return { value: answer, authoritative: true }
    } catch (error) {
      this.deps.log(`[catalog] credential pool lookup ${lookup.replace('\0', ' ')} failed: ${str((error as Error).message)}`)
      const hit = this.lastPoolAnswers.get(key)
      return { value: hit?.source === source && source === this.sourceFingerprint(profileHome) ? hit.value as T : null, authoritative: false }
    }
  }

  /** One shared read of pool membership and scoped key revisions before reusing catalog data. */
  private poolProviders(profileHome: string): Promise<CatalogLookup<SidecarResult<'usage.pool_providers'>>> {
    const inputSource = this.sourceFingerprint(profileHome, false)
    const readKey = this.sourceFingerprint(profileHome)
    const pending = this.credentialReads.get(readKey)
    if (pending) return pending
    const read = (async () => {
      const config = await this.deps.config.read(profileHome)
      const key_envs = Object.fromEntries(BALANCE_PROVIDERS.filter((pid) => this.apiKeyFor(pid, profileHome, config) === null).map((pid) => [pid, this.usageKey(pid, null).env_vars ?? []]))
      const result = await this.poolLookup(profileHome, 'providers', (sidecar) => sidecar.call('usage.pool_providers', { profile_home: profileHome, key_envs }))
      if (inputSource !== this.sourceFingerprint(profileHome, false)) return { value: null, authoritative: false }
      this.scopedKeyAuthority.set(profileHome, result.authoritative)
      if (result.authoritative) this.scopedKeyRevisions.set(profileHome, JSON.stringify(Object.entries(result.value?.keys ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([pid, state]) => [pid, state.revision])))
      return result
    })().catch(() => {
      if (inputSource === this.sourceFingerprint(profileHome, false)) this.scopedKeyAuthority.set(profileHome, false)
      return { value: null, authoritative: false }
    }).finally(() => { this.credentialReads.delete(readKey) })
    this.credentialReads.set(readKey, read)
    return read
  }

  /** TAL-548: one key-based balance read through the sidecar, which resolves a pool account's key itself; null when it fails. */
  private async balance(profileHome: string, provider: SidecarParams<'usage.balance'>['provider'], key: Pick<SidecarParams<'usage.balance'>, 'credential_id' | 'api_key' | 'env_vars'>): Promise<SidecarResult<'usage.balance'> | null> {
    const sidecar = this.deps.sidecar()
    if (!sidecar) return null
    try {
      return await sidecar.call('usage.balance', { profile_home: profileHome, provider, ...key }, { timeoutMs: BALANCE_TIMEOUT_MS })
    } catch (error) {
      this.deps.log(`[catalog] ${provider} balance failed: ${str((error as Error).message)}`)
      return null
    }
  }

  private quotaScopeCache: string | null = null

  /** Python `_quota_server_scope_id`: a 32-hex id persisted at `<state>/.quota_scope_id` (created atomically once). */
  private async quotaServerScopeId(): Promise<string> {
    if (this.quotaScopeCache) return this.quotaScopeCache
    const documents = this.deps.documents
    if (!documents) { this.quotaScopeCache = randomUUID().replaceAll('-', ''); return this.quotaScopeCache }
    const stored = await updateDocument(documents, 'catalog', 'quota-scope', (value) => {
      const previous = typeof value === 'string' ? value.trim().toLowerCase() : ''
      if (/^[0-9a-f]{32}$/.test(previous)) return { value, result: previous }
      const id = randomUUID().replaceAll('-', '')
      return { value: `${id}\n`, result: id }
    })
    this.quotaScopeCache = stored
    return stored
  }

  /** Python `_quota_profile_scope_id`. */
  async quotaProfileScopeId(profile: string): Promise<string> {
    return `qscope_${createHash('sha256').update(`${(await this.quotaServerScopeId())}\0${profile}`).digest('hex').slice(0, 32)}`
  }

  /**
   * Python `get_provider_quotas`: the stable-identity envelope the iOS widget persists. A keyed provider is one source per
   * credential-pool account, else one for its own key (Python `_quota_source_descriptors`, TAL-548). Each source id appears
   * once (two custom providers can share a slug), ordered by provider, account label, then source id.
   */
  async quotas(profileHome: string, profile: string, opts: { sourceId?: string | null; refresh?: boolean } = {}, attempt = 0): Promise<Dict> {
    const sequence = ++this.quotaReadSequence
    const source = this.sourceFingerprint(profileHome)
    const at = this.deps.now()
    const { payload: status, pooled: pooledIds } = await this.providerRows(profileHome)
    const active = status.active_provider
    const scopeId = (await this.quotaProfileScopeId(profile))
    // Python `_quota_source_id(profile, provider, credential_id)`: a pool account's id, or "provider" for the provider's own key.
    const sourceId = (pid: string, credential: string): string => `qsrc_${createHash('sha256').update(`${scopeId}\0${pid}\0${credential}`).digest('hex').slice(0, 32)}`
    // A provider configured only through `hermes auth add` has no key in .env or config.yaml, yet its pool accounts are
    // sources, including a signed-out OAuth provider's. An unknown pool (a failed lookup with no earlier answer) never
    // reports a requested source as missing.
    let poolUnknown = !status.availability.authoritative
    const pooled = new Set(pooledIds ?? [])
    const config = await this.deps.config.read(profileHome)
    const perProvider = await Promise.all(status.providers.filter((p) => p.has_key || p.is_custom || pooled.has(str(p.id))).map(async (p) => {
      const pid = str(p.id)
      const label = str(p.display_name) || pid
      const apiKey = this.apiKeyFor(pid, profileHome, config)
      const found = await this.poolEntries(profileHome, pid, apiKey)
      if (!found.authoritative) poolUnknown = true
      const entries = found.value?.entries ?? []
      const accounts = entries.map((e) => ({ source_id: sourceId(pid, e.credential_id), provider_id: pid, provider_label: label, account_label: e.label, credential: e }))
      // The provider's own key is a source unless a pool account already holds it.
      const ownKey = found.authoritative && ((!entries.length && (p.has_key === true || p.is_custom === true) && !pooled.has(pid)) || ((apiKey !== null || found.value?.has_api_key === true) && !entries.some((e) => e.matches_api_key)))
      return ownKey ? [{ source_id: sourceId(pid, 'provider'), provider_id: pid, provider_label: label, account_label: label, credential: null }, ...accounts] : accounts
    }))
    let descriptors = uniqueQuotaSources(perProvider.flat())
    const membership = new Set(descriptors.map((d) => d.source_id))
    const requested = str(opts.sourceId).trim() || null
    if (requested) descriptors = descriptors.filter((d) => d.source_id === requested)
    const thresholds = (await this.deps.quotaThresholds?.(profile)) ?? QUOTA_THRESHOLD_DEFAULTS
    let sources: QuotaSourceRow[] = await Promise.all(descriptors.map(async (d) => {
      const q = await this.quota(profileHome, d.provider_id, { refresh: opts.refresh ?? false, at, credential: d.credential, sequence })
      const limits = dict(q.account_limits)
      return classifyQuotaSource({
        computed_at: isoAt(at), source_id: d.source_id, provider_id: d.provider_id, provider_label: d.provider_label, account_label: d.account_label,
        is_active_provider: d.provider_id === active, supported: q.supported === true, status: str(limits.status) || str(q.status) || 'unavailable',
        plan: limits.plan ?? null, windows: (limits.windows ?? []) as QuotaWindow[], pace_window_index: (limits.pace_window_index ?? null) as number | null, session_window_index: limits.session_window_index ?? null, weekly_window_index: limits.weekly_window_index ?? null, quota: q.quota ?? null, balances: q.balances ?? [], details: limits.details ?? [],
        unavailable_reason: limits.unavailable_reason ?? null, retry_after: limits.retry_after ?? null, fetched_at: limits.fetched_at ?? null, message: q.message ?? null,
      }, thresholds)
    }))
    if (source !== this.sourceFingerprint(profileHome) && attempt === 0) return this.quotas(profileHome, profile, opts, 1)
    poolUnknown ||= source !== this.sourceFingerprint(profileHome)
    const cacheKey = `${profileHome}\0${scopeId}`
    const cached = source === this.sourceFingerprint(profileHome) ? this.lastQuotaSources.get(cacheKey) : undefined
    const prior = cached?.source === source ? cached : undefined
    const previous = prior?.sources ?? []
    if (!poolUnknown) {
      sources = sources.map((s) => {
        const old = previous.find((p) => p.source_id === s.source_id)
        return s.status === 'unavailable' && old ? this.staleQuotaSource(old, str(s.unavailable_reason || s.message)) : s
      })
      const latestMembership = prior && prior.sequence > sequence ? prior.membership : membership
      const sourceSequences = new Map(prior?.sourceSequences)
      const merged = new Map(previous.filter((s) => latestMembership.has(str(s.source_id))).map((s) => [str(s.source_id), s]))
      for (const value of sources) {
        const id = str(value.source_id)
        if (!latestMembership.has(id) || (sourceSequences.get(id) ?? -1) > sequence) continue
        merged.set(id, value)
        sourceSequences.set(id, sequence)
      }
      for (const id of sourceSequences.keys()) if (!latestMembership.has(id)) sourceSequences.delete(id)
      const snapshot = uniqueQuotaSources([...merged.values()])
      this.lastQuotaSources.set(cacheKey, { source, sequence: Math.max(sequence, prior?.sequence ?? -1), membership: latestMembership, sources: snapshot, sourceSequences })
      // A delayed read answers with the newest confirmed projection, including confirmed removals.
      sources = snapshot.filter((s) => !requested || s.source_id === requested)

    } else {
      sources = previous.filter((s) => !requested || s.source_id === requested).map((s) => this.staleQuotaSource(s))
    }
    const currentSource = this.sourceFingerprint(profileHome)
    if (currentSource !== source) { poolUnknown = true; sources = [] }
    const latestMembership = this.lastQuotaSources.get(cacheKey)?.membership
    const availability = this.availability(currentSource, !poolUnknown, sources.length > 0)
    return { availability, version: 1, computed_at: isoAt(at), scope_id: scopeId, profile_id: profile, active_provider: active, requested_source_id: requested, missing_source: Boolean(requested && !poolUnknown && !latestMembership?.has(requested)), sources }
  }

  private readonly lastQuotaSources = new Map<string, { source: string; sequence: number; membership: Set<string>; sources: QuotaSourceRow[]; sourceSequences: Map<string, number> }>()

  private staleQuotaSource(source: QuotaSourceRow, reason = 'Provider data is temporarily unavailable. Showing last-confirmed data.'): QuotaSourceRow {
    return { ...source, status: 'stale', unavailable_reason: reason, message: reason, urgency: { remaining: 'stale', pace: 'stale' } }
  }

  private availability(source: string, authoritative: boolean, cached: boolean): CatalogAvailability {
    return { authoritative, status: authoritative ? 'available' : cached ? 'stale' : 'unavailable',
      unavailable_reason: authoritative ? null : cached ? 'Provider data is temporarily unavailable. Showing last-confirmed data.' : 'Provider data is temporarily unavailable. Try again.',
      generation: createHash('sha256').update(source).digest('hex') }
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
    const info = await this.balance(profileHome, 'openrouter', this.usageKey('openrouter', apiKey))
    if (info?.status === 'no_key') return { ok: false, provider, display_name: name, supported: true, status: 'no_key', monthly_budget: budget, message: 'OpenRouter cost history needs an OPENROUTER_API_KEY configured on the server.' }
    if (info?.status !== 'ok' || !info.quota) {
      return { ok: false, provider, display_name: name, supported: true, status: 'unavailable', window_days: days, ...costHistoryView(this.readCostSnapshots(profileHome), days, budget), limit: null, label: null, monthly_budget: budget, message: 'OpenRouter cost history is temporarily unavailable. Showing last known data.' }
    }
    const snapshots = this.recordCostSnapshot(profileHome, info.quota, this.deps.now())
    return { ok: true, provider, display_name: name, supported: true, status: 'available', window_days: days, ...costHistoryView(snapshots, days, budget), limit: info.quota.limit, label: info.label ?? 'OpenRouter credits', monthly_budget: budget, message: 'OpenRouter cost history loaded.' }
  }

  private readCostSnapshots(profileHome: string): CostSnapshot[] {
    try {
      const data = JSON.parse(readFileSync(join(profileHome, 'cost-snapshots', 'openrouter.json'), 'utf8')) as { snapshots?: unknown }
      return (Array.isArray(data.snapshots) ? data.snapshots : []).filter(isDict).map((e) => ({ date: str(e.date).trim(), used: typeof e.used === 'number' ? e.used : null, limit: typeof e.limit === 'number' ? e.limit : null })).filter((e) => e.date).sort((a, b) => (a.date < b.date ? -1 : 1))
    } catch {
      return []
    }
  }

  /** Writes or updates the UTC day's OpenRouter usage snapshot; every successful key read (quota or cost history) records one. */
  private recordCostSnapshot(profileHome: string, quota: Dict, at: number): CostSnapshot[] {
    let snapshots = this.readCostSnapshots(profileHome)
    try {
      const today = isoAt(at).slice(0, 10)
      const used = finite(quota.usage)
      const limit = finite(quota.limit)
      const existing = snapshots.find((e) => e.date === today)
      if (existing) { existing.used = used; existing.limit = limit } else snapshots.push({ date: today, used, limit })
      snapshots.sort((a, b) => (a.date < b.date ? -1 : 1))
      if (snapshots.length > COST_SNAPSHOT_MAX_DAYS) snapshots = snapshots.slice(-COST_SNAPSHOT_MAX_DAYS)
      mkdirSync(join(profileHome, 'cost-snapshots'), { recursive: true })
      atomicWriteText(join(profileHome, 'cost-snapshots', 'openrouter.json'), JSON.stringify({ provider: 'openrouter', snapshots }, null, 2))
      return snapshots
    } catch {
      return this.readCostSnapshots(profileHome)
    }
  }
}

export const envFileExists = (profileHome: string): boolean => existsSync(join(profileHome, '.env'))
