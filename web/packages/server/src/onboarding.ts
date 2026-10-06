/** First-run wizard: status, setup, self-hosted providers, endpoint probe (Python `api/onboarding.py`). */
import { readCapped } from './http/capped.js'
import { RuntimeCredentialError, writeRuntimeCredential } from './providers/runtime-env.js'
import type { SidecarLike } from './sidecar/client.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { AgentConfig, Config, Dict } from './config/agent-config.js'
import { canonicaliseProviderId, dict, isDict, modelSection, parseProviderQualifiedModel } from './config/agent-config.js'
import { loadEnvFile, writeEnvFile } from './providers/env-file.js'
import { PROVIDER_CATEGORIES, PROVIDER_DISPLAY, SUPPORTED_PROVIDER_SETUPS, UNSUPPORTED_PROVIDER_NOTE } from './providers/tables.js'
import type { ModelsCatalog } from './providers/catalog.js'
import { displayBotName, type SettingsStore } from './settings.js'
import { str } from './util.js'

export class OnboardingError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export interface OnboardingDeps {
  settings: SettingsStore
  config: AgentConfig
  env: Record<string, string | undefined>
  profileHome: () => string
  isRootProfileHome: (home: string) => boolean
  sidecar: () => SidecarLike | null
  /** Whether the Agent runtime imports (sidecar handshake compatible). */
  agentStatus: () => { found: boolean; importsOk: boolean; missing: string[]; errors: Record<string, string> }
  isAuthEnabled: () => Promise<boolean>
  workspaces: () => { items: { path: string; name: string }[]; last: string | null }
  models: (profileHome: string) => Promise<ModelsCatalog>
  defaultWorkspace: () => string
  defaultModel: () => string
  fetch?: typeof fetch
  log: (line: string) => void
}

const PROBE_TIMEOUT_MS = 5_000
const PROBE_MAX_BYTES = 256 * 1024

const currentProvider = (cfg: Config): string => str(modelSection(cfg).provider).trim().toLowerCase()
const currentModel = (cfg: Config): string => (typeof cfg.model === 'string' ? cfg.model.trim() : str(modelSection(cfg).default).trim())
const normalizeBaseUrl = (v: unknown): string => str(v).trim().replace(/\/+$/, '')
const currentBaseUrl = (cfg: Config): string => normalizeBaseUrl(modelSection(cfg).base_url)

/** A picked `/api/models` id (`@provider:model`) is saved as its bare model, like `setDefaultModel`; one qualified for another provider is refused. */
function normalizeModelForProvider(provider: string, model: string): string {
  let clean = model.trim()
  const qualified = parseProviderQualifiedModel(clean)
  if (qualified) {
    if (canonicaliseProviderId(qualified[1]) !== canonicaliseProviderId(provider)) throw new OnboardingError(`Model '${clean}' belongs to another provider than '${provider}'.`)
    clean = qualified[0].trim()
  }
  if (!clean) return ''
  if ((provider === 'anthropic' || provider === 'openai') && clean.startsWith(`${provider}/`)) return clean.slice(provider.length + 1)
  return clean
}

/** Python `_provider_api_key_present`. */
export function providerApiKeyPresent(provider: string, cfg: Config, envValues: Record<string, string>): boolean {
  const pid = provider.trim().toLowerCase()
  if (!pid) return false
  const setup = SUPPORTED_PROVIDER_SETUPS[pid]
  if (setup?.env_var && envValues[setup.env_var]) return true
  for (const alias of setup?.env_var_aliases ?? []) if (envValues[alias]) return true
  if (str(modelSection(cfg).api_key).trim()) return true
  const providers = dict(cfg.providers)
  const p = providers[pid]
  if (isDict(p) && str(p.api_key).trim()) return true
  if (pid === 'custom') {
    const c = providers.custom
    if (isDict(c) && str(c.api_key).trim()) return true
  }
  return false
}

/** Python `_oauth_payload_has_token`: token material at the top level or under a nested `tokens` dict. */
function oauthPayloadHasToken(state: unknown): boolean {
  if (!isDict(state)) return false
  const candidates = [state, isDict(state.tokens) ? state.tokens : {}]
  return candidates.some((c) => ['access_token', 'refresh_token', 'api_key'].some((k) => str(c[k]).trim()))
}

/** Python `_provider_oauth_authenticated`: reads the profile's auth.json directly. */
export function providerOauthAuthenticated(providerRaw: string, home: string): boolean {
  let provider = providerRaw.trim().toLowerCase()
  provider = ({ claude: 'anthropic', 'claude-code': 'anthropic' } as Record<string, string>)[provider] ?? provider
  if (!['openai-codex', 'copilot', 'copilot-acp', 'qwen-oauth', 'nous', 'xai-oauth', 'minimax-oauth', 'anthropic'].includes(provider)) return false
  try {
    const store = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')) as Dict
    const providers = store.providers
    if (isDict(providers) && oauthPayloadHasToken(providers[provider])) return true
    const pool = store.credential_pool
    if (isDict(pool) && Array.isArray(pool[provider])) {
      for (const entry of pool[provider] as unknown[]) {
        if (oauthPayloadHasToken(entry)) return true
        if (provider === 'anthropic' && isDict(entry) && entry.auth_type === 'oauth' && entry.source === 'claude_code_linked') return true
      }
    }
  } catch {
    return false
  }
  return false
}

export class Onboarding {
  constructor(private readonly deps: OnboardingDeps) {}

  private skipRequested(): boolean {
    return ['1', 'true', 'yes'].includes((this.deps.env.HERMES_WEBUI_SKIP_ONBOARDING ?? '').trim())
  }

  private runtimeStatus(cfg: Config, home: string, agent: ReturnType<OnboardingDeps['agentStatus']>): Dict {
    const provider = currentProvider(cfg)
    const model = currentModel(cfg)
    const baseUrl = currentBaseUrl(cfg)
    const envValues = loadEnvFile(join(home, '.env'))
    const configured = Boolean(provider && model)
    let ready = false
    if (configured) {
      const meta = SUPPORTED_PROVIDER_SETUPS[provider]
      if (meta) {
        if (meta.key_optional) ready = meta.requires_base_url ? Boolean(baseUrl) : true
        else {
          ready = meta.requires_base_url ? Boolean(baseUrl && providerApiKeyPresent(provider, cfg, envValues)) : providerApiKeyPresent(provider, cfg, envValues)
          if (!ready && meta.oauth_provider) ready = providerOauthAuthenticated(meta.oauth_provider, home)
        }
      } else ready = providerApiKeyPresent(provider, cfg, envValues) || providerOauthAuthenticated(provider, home)
    }
    const chatReady = agent.found && agent.importsOk && ready
    let state: string
    let noteKey: string
    let note: string
    const noteArgs: string[] = []
    if (!agent.found || !agent.importsOk) {
      state = 'agent_unavailable'
      noteKey = 'onboarding_notice_system_unavailable'
      note = 'Hermes is not fully importable from the Web UI yet. Finish bootstrap or fix the agent install before provider setup will work.'
    } else if (chatReady) {
      state = 'ready'
      noteKey = 'onboarding_notice_system_ready'
      const name = PROVIDER_DISPLAY[provider] ?? (provider ? provider[0]!.toUpperCase() + provider.slice(1) : 'Hermes')
      note = `Hermes is minimally configured and ready to chat via ${name}.`
    } else if (configured) {
      state = 'provider_incomplete'
      if (provider === 'custom' && !baseUrl) {
        noteKey = 'onboarding_notice_custom_base_url_required'
        note = 'Hermes has a saved provider/model selection, but the custom provider still needs a base URL. Add the API key too if that server requires one.'
      } else if (!(provider in SUPPORTED_PROVIDER_SETUPS)) {
        noteKey = 'onboarding_notice_provider_auth_required'
        noteArgs.push(provider)
        note = `Provider '${provider}' is configured but not yet authenticated. Run 'hermes auth' or 'hermes model' in a terminal to complete setup, then reload the Web UI.`
      } else if (SUPPORTED_PROVIDER_SETUPS[provider]?.oauth_flow) {
        noteKey = 'onboarding_notice_provider_sign_in_required'
        const name = SUPPORTED_PROVIDER_SETUPS[provider]?.oauth_label ?? provider
        noteArgs.push(name)
        note = `Hermes has a saved provider/model selection but still needs you to sign in to ${name}.`
      } else {
        noteKey = 'onboarding_notice_provider_api_key_required'
        note = 'Hermes has a saved provider/model selection but still needs the API key required to chat.'
      }
    } else {
      state = 'needs_provider'
      noteKey = 'onboarding_notice_provider_choice_required'
      note = 'Hermes is installed, but you still need to choose a provider and save working credentials.'
    }
    return { provider_configured: configured, provider_ready: ready, chat_ready: chatReady, setup_state: state, provider_note: note, provider_note_key: noteKey, provider_note_args: noteArgs, current_provider: provider || null, current_model: model || null, current_base_url: baseUrl || null, env_path: join(home, '.env') }
  }

  private setupCatalog(cfg: Config, home: string): Dict {
    const provider = currentProvider(cfg) || 'openrouter'
    const model = currentModel(cfg)
    const order = new Map(PROVIDER_CATEGORIES.map((c) => [c.id, c.order]))
    const providers = Object.entries(SUPPORTED_PROVIDER_SETUPS).map(([id, meta]) => ({
      id, label: meta.label, env_var: meta.env_var, default_model: meta.default_model, default_base_url: meta.default_base_url ?? '', requires_base_url: meta.requires_base_url,
      key_optional: Boolean(meta.key_optional), models: [...meta.models], category: meta.category, quick: Boolean(meta.quick), oauth_provider: meta.oauth_provider ?? '', oauth_label: meta.oauth_label ?? '', oauth_flow: meta.oauth_flow ?? null,
      ...(meta.oauth_flow ? { signed_in: providerOauthAuthenticated(meta.oauth_provider ?? id, home) } : {}),
    })).sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    const categories = [...PROVIDER_CATEGORIES].sort((a, b) => a.order - b.order).map((c) => ({ id: c.id, label: c.label, providers: providers.filter((p) => p.category === c.id).map((p) => p.id) }))
    const currentIsOauth = (!(provider in SUPPORTED_PROVIDER_SETUPS) && provider !== '') || providerOauthAuthenticated(provider, home)
    return { providers, categories, unsupported_note: UNSUPPORTED_PROVIDER_NOTE, current_is_oauth: currentIsOauth, current: { provider, model: model || (SUPPORTED_PROVIDER_SETUPS[provider]?.default_model ?? ''), base_url: currentBaseUrl(cfg) } }
  }

  async status(): Promise<Dict> {
    const home = this.deps.profileHome()
    const settings = this.deps.settings.load()
    let cfg: Config = {}
    try { cfg = await this.deps.config.read(home) } catch (error) { this.deps.log(`[onboarding] config.yaml unavailable: ${str((error as Error).message)}`) }
    const agent = this.deps.agentStatus()
    const runtime = this.runtimeStatus(cfg, home, agent)
    const configPath = this.deps.config.path(home)
    const configExists = existsSync(configPath)
    const provider = currentProvider(cfg)
    const nonWizard = Boolean(provider && !(provider in SUPPORTED_PROVIDER_SETUPS))
    const configAutoCompleted = configExists && (Boolean(runtime.chat_ready) || (nonWizard && Boolean(runtime.provider_configured)))
    if (configAutoCompleted && !settings.onboarding_completed) {
      try { await this.deps.settings.save({ onboarding_completed: true }); settings.onboarding_completed = true } catch { /* best effort */ }
    }
    let models: ModelsCatalog
    try { models = await this.deps.models(home) } catch { models = { active_provider: null, default_model: '', groups: [], aliases: {}, configured_model_badges: {} } }
    return {
      completed: Boolean(settings.onboarding_completed) || this.skipRequested() || configAutoCompleted,
      settings: { default_model: str(settings.default_model) || this.deps.defaultModel(), default_workspace: str(settings.default_workspace) || this.deps.defaultWorkspace(), password_enabled: await this.deps.isAuthEnabled(), bot_name: displayBotName(settings.bot_name) },
      system: { hermes_found: agent.found, imports_ok: agent.importsOk, missing_modules: agent.missing, import_errors: agent.errors, config_path: configPath, config_exists: configExists, ...runtime },
      setup: this.setupCatalog(cfg, home),
      workspaces: this.deps.workspaces(),
      models,
    }
  }

  async complete(): Promise<Dict> {
    await this.deps.settings.save({ onboarding_completed: true })
    return this.status()
  }

  /** Python `apply_onboarding_setup`. */
  async setup(body: Dict): Promise<Dict> {
    if (this.skipRequested()) return this.complete()
    const provider = str(body.provider).trim().toLowerCase()
    const model = str(body.model).trim()
    const apiKey = str(body.api_key).trim()
    const baseUrl = normalizeBaseUrl(body.base_url)
    const meta = SUPPORTED_PROVIDER_SETUPS[provider]
    if (!meta) return this.complete()
    if (!model) throw new OnboardingError('model is required')
    if (meta.requires_base_url) {
      if (!baseUrl) throw new OnboardingError('base_url is required for custom endpoints')
      if (!/^https?:\/\//.test(baseUrl)) throw new OnboardingError('base_url must start with http:// or https://')
    }
    const home = this.deps.profileHome()
    if (existsSync(this.deps.config.path(home)) && !body.confirm_overwrite) {
      return { error: 'config_exists', message: 'Hermes is already configured (config.yaml exists). Pass confirm_overwrite=true to overwrite it.', requires_confirm: true }
    }
    const envPath = join(home, '.env')
    const cfg = await this.deps.config.read(home)
    const oauthReady = Boolean(meta.oauth_provider) && providerOauthAuthenticated(meta.oauth_provider ?? '', home)
    if (meta.oauth_flow) {
      if (!oauthReady) throw new OnboardingError(`Sign in to ${meta.oauth_label ?? meta.label} before continuing.`)
    } else if (!apiKey && !providerApiKeyPresent(provider, cfg, loadEnvFile(envPath))) {
      if (!meta.key_optional && !oauthReady) throw new OnboardingError(`${meta.env_var} is required`)
    }
    await this.deps.config.update(home, (c) => {
      const m = modelSection(c)
      m.provider = provider
      m.default = normalizeModelForProvider(provider, model)
      if (meta.requires_base_url) m.base_url = baseUrl
      else if (meta.default_base_url) m.base_url = meta.default_base_url
      else Reflect.deleteProperty(m, 'base_url')
      c.model = m
    })
    // A sign-in provider has no API key: its credential is the Agent's own auth-store entry.
    if (apiKey && meta.env_var) await this.writeCredential(home, meta.env_var, apiKey)
    return this.status()
  }

  /** A root-profile key written by setup reaches the running process and sidecar like a settings-panel edit does. */
  private async writeCredential(home: string, envVar: string, apiKey: string): Promise<void> {
    const rootProfile = this.deps.isRootProfileHome(home)
    try {
      await writeRuntimeCredential({ env: this.deps.env, sidecar: this.deps.sidecar, log: this.deps.log }, rootProfile, envVar, apiKey, () => { writeEnvFile(join(home, '.env'), { [envVar]: apiKey }) })
    } catch (error) {
      if (error instanceof RuntimeCredentialError) throw new OnboardingError(error.message, 503)
      throw error
    }
  }

  /** Python `apply_self_hosted_provider_setup`. */
  async selfHosted(body: Dict): Promise<Dict> {
    const provider = str(body.provider).trim().toLowerCase()
    const model = str(body.model).trim()
    const apiKey = str(body.api_key).trim()
    const baseUrl = normalizeBaseUrl(body.base_url)
    const activate = body.activate === undefined || body.activate === null || Boolean(body.activate)
    if (provider !== 'ollama' && provider !== 'lmstudio') throw new OnboardingError(`unsupported self-hosted provider: ${provider}`)
    if (!model) throw new OnboardingError('model is required')
    const meta = SUPPORTED_PROVIDER_SETUPS[provider]
    if (meta?.requires_base_url) {
      if (!baseUrl) throw new OnboardingError('base_url is required for this provider')
      if (!/^https?:\/\//.test(baseUrl)) throw new OnboardingError('base_url must start with http:// or https://')
    }
    // Like onboarding, an endpoint that does not answer never replaces a working default.
    const probe = await this.probe(baseUrl, apiKey || null)
    if (probe.ok !== true) throw new OnboardingError(str(probe.detail) || 'the endpoint did not answer')
    const home = this.deps.profileHome()
    let persisted = ''
    await this.deps.config.update(home, (c) => {
      const providers = dict(c.providers)
      providers[provider] = { ...dict(providers[provider]), base_url: baseUrl }
      c.providers = providers
      if (activate) {
        const m = modelSection(c)
        m.provider = provider
        m.default = normalizeModelForProvider(provider, model)
        m.base_url = baseUrl
        c.model = m
        persisted = str(m.default)
      }
    })
    if (apiKey && meta?.env_var) await this.writeCredential(home, meta.env_var, apiKey)
    const result: Dict = { ok: true, provider, base_url: baseUrl }
    if (activate) result.model = persisted
    return result
  }

  /** Python `probe_provider_endpoint`: one GET of `<base_url>/models`, no redirects, 5 s, 256 KB. */
  async probe(baseUrlRaw: string, apiKey: string | null): Promise<Dict> {
    const baseUrl = normalizeBaseUrl(baseUrlRaw)
    if (!baseUrl) return { ok: false, error: 'invalid_url', detail: 'base_url is required' }
    let parsed: URL
    try { parsed = new URL(baseUrl) } catch { return { ok: false, error: 'invalid_url', detail: 'base_url must start with http:// or https://' } }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'invalid_url', detail: 'base_url must start with http:// or https://' }
    if (!parsed.hostname) return { ok: false, error: 'invalid_url', detail: 'base_url has no host' }
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'hermes-webui-onboarding-probe' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const f = this.deps.fetch ?? fetch
    let res: Response
    try {
      res = await f(`${baseUrl}/models`, { headers, redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    } catch (error) {
      const err = error as Error & { cause?: { code?: string; errors?: { code?: string }[] } }
      const code = err.cause?.code ?? err.cause?.errors?.[0]?.code ?? ''
      const text = `${err.name} ${err.message} ${code}`.toLowerCase()
      if (err.name === 'TimeoutError' || text.includes('timed out')) return { ok: false, error: 'timeout', detail: `connection timed out after ${String(PROBE_TIMEOUT_MS / 1000)}s` }
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { ok: false, error: 'dns', detail: `could not resolve host '${parsed.hostname}'` }
      if (code === 'ECONNREFUSED' || text.includes('refused')) return { ok: false, error: 'connect_refused', detail: `connection refused at ${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}` }
      return { ok: false, error: 'unreachable', detail: err.message.slice(0, 200) }
    }
    if (res.status >= 300 && res.status < 400) return { ok: false, error: 'unreachable', detail: `HTTP ${String(res.status)} — endpoint returned a redirect (probe does not follow redirects).  Point base_url at the final URL directly.`, status: res.status }
    if (res.status >= 400) {
      const body = ((await readCapped(res, 2048).catch(() => null)) ?? Buffer.alloc(0)).toString('utf8').trim()
      const first = body.split('\n')[0]?.slice(0, 200) ?? ''
      return { ok: false, error: res.status < 500 ? 'http_4xx' : 'http_5xx', detail: first ? `HTTP ${String(res.status)}: ${first}` : `HTTP ${String(res.status)}`, status: res.status }
    }
    // Read incrementally and cancel past the cap so the advertised limit bounds memory (shared capped reader).
    const raw = await readCapped(res, PROBE_MAX_BYTES)
    if (!raw) return { ok: false, error: 'parse', detail: `response exceeded ${String(PROBE_MAX_BYTES / 1024)} KB cap` }
    let payload: unknown
    try { payload = JSON.parse(raw.toString('utf8')) } catch (error) { return { ok: false, error: 'parse', detail: `response is not JSON (${(error as Error).name})` } }
    let entries: unknown[]
    if (isDict(payload) && Array.isArray(payload.data)) entries = payload.data
    else if (Array.isArray(payload)) entries = payload
    else return { ok: false, error: 'parse', detail: "response is not in OpenAI /models shape (expected {'data': [...]} or [...])" }
    const models: { id: string; label: string }[] = []
    for (const entry of entries) {
      const id = isDict(entry) ? str(entry.id ?? entry.name).trim() : str(entry).trim()
      if (id && !models.some((m) => m.id === id)) models.push({ id, label: id })
    }
    return { ok: true, models, status: res.status }
  }
}
