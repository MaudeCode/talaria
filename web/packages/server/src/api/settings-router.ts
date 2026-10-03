/** Settings, profiles, models, providers, reasoning, personalities, onboarding (Python `api/routes.py` handlers of the same paths). */
import { implement } from '@orpc/server'
import { RuntimeCredentialError, writeRuntimeCredential } from '../providers/runtime-env.js'
import { settingsContract } from '@maudecode/talaria-web-contracts'
import { join } from 'node:path'
import { HttpError, type ApiContext } from './router.js'
import { requestSessionIdGuard } from './session-visibility.js'
import type { RequestContext } from '../http/context.js'
import { activeProfileName, buildProfileCookie, ensureTrustedAuthSession, sessionCanManageServer } from '../auth/gate.js'
import { forwardedClientIp, isLoopback, rawPeerIsTrustedProxy } from '../http/origin.js'
import { isNonGlobalAddress } from '../http/addresses.js'
import { isIP } from 'node:net'
import { HttpFailure } from '../sessions/service.js'
import { SessionNotFound } from '../sessions/store.js'
import { auxiliaryModels, canonicaliseProviderId, ConfigUnavailable, maxTokensStatus, personalityPrompt, personalityRows, reasoningStatus, setAuxiliaryModel, setDefaultModel, setMaxTokens, validReasoningEffort, type Dict } from '../config/agent-config.js'
import { ProfileError, validateProfileName } from '../profiles/profiles.js'
import { OnboardingError } from '../onboarding.js'
import { writeEnvFile } from '../providers/env-file.js'
import { displayName, providerEnvVar, stampAuxiliarySelections } from '../providers/catalog.js'
import { OAUTH_PROVIDERS } from '../providers/tables.js'
import { displayBotName, SETTINGS_SPEECH_KEYS, pyBool } from '../settings.js'
import { str } from '../util.js'

const os = implement(settingsContract).$context<ApiContext>().use(requestSessionIdGuard)

function failure(error: unknown): never {
  if (error instanceof HttpError) throw error
  if (error instanceof HttpFailure) throw new HttpError(error.status, error.message, error.extra ?? {})
  if (error instanceof ProfileError || error instanceof OnboardingError) throw new HttpError(error.status, error.message)
  if (error instanceof SessionNotFound) throw new HttpError(404, 'Session not found')
  if (error instanceof ConfigUnavailable) throw new HttpError(503, error.message)
  throw error
}

/** Handler boundary: contract outputs are pinned loose objects (index signatures), so the concrete return type is erased here like the `as never` casts elsewhere. */
async function run<T>(fn: () => Promise<T> | T): Promise<never> {
  try {
    return (await fn()) as never
  } catch (error) {
    return failure(error)
  }
}

const home = (ctx: RequestContext): string => ctx.deps.profileHome(activeProfileName(ctx))
/** The active profile's auxiliary slots, stamped against the same catalog `/api/models` answers. */
const auxiliaryState = async (ctx: RequestContext): Promise<Dict> => stampAuxiliarySelections(auxiliaryModels(await ctx.deps.agentConfig.read(home(ctx))), await ctx.deps.catalog.models(home(ctx)))
const truthy = (v: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())

/** Python `addr.is_loopback or addr.is_private` (`ipaddress` treats every non-global range as private). */
function ipIsLoopbackOrPrivate(addr: string): boolean {
  const ip = addr.trim()
  if (!isIP(ip)) return false
  return isLoopback(ip) || isNonGlobalAddress(ip)
}

/** Python `_onboarding_request_is_local`: forwarded headers count only behind a trusted proxy with the opt-in. */
export function onboardingRequestIsLocal(ctx: RequestContext): boolean {
  const env = ctx.deps.config.env
  const trustForwarded = truthy(env.HERMES_WEBUI_TRUST_FORWARDED_FOR)
  const peerTrusted = rawPeerIsTrustedProxy(ctx.peer, env)
  if (trustForwarded && peerTrusted) {
    const client = forwardedClientIp(ctx.headerAll('x-forwarded-for'), ctx.header('x-real-ip'), ctx.peer, env)
    return client !== null && ipIsLoopbackOrPrivate(client)
  }
  if (!ipIsLoopbackOrPrivate(ctx.peer)) return false
  if (isLoopback(ctx.peer)) return true
  // A (non-empty) forwarded header on a non-loopback peer means an untrusted relay: fail closed.
  return !(ctx.headerAll('x-forwarded-for').some((v) => v.trim()) || (ctx.header('x-real-ip') ?? '').trim())
}

/** Python `_onboarding_gate_allows`. */
export async function onboardingGateAllows(ctx: RequestContext, authEnabled?: boolean): Promise<boolean> {
  const enabled = authEnabled ?? (await ctx.deps.auth.isAuthEnabled())
  if (enabled || truthy(ctx.deps.config.env.HERMES_WEBUI_ONBOARDING_OPEN)) return true
  return onboardingRequestIsLocal(ctx)
}

async function canManageServer(ctx: RequestContext): Promise<boolean> {
  return sessionCanManageServer(ctx, await ensureTrustedAuthSession(ctx))
}

async function authFields(ctx: RequestContext, into: Dict): Promise<void> {
  const auth = ctx.deps.auth
  into.auth_enabled = await auth.isAuthEnabled()
  into.password_auth_enabled = (await auth.getPasswordHash()) !== null
  if (auth.passkeyFeatureFlagEnabled()) {
    const registered = auth.passkeysEnabled()
    into.passkeys_enabled = registered
    into.passwordless_enabled = registered && !into.password_auth_enabled
  } else {
    into.passkeys_enabled = false
    into.passwordless_enabled = false
  }
}

async function settingsPayload(ctx: RequestContext): Promise<Dict> {
  const deps = ctx.deps
  const settings: Dict = deps.settings.load()
  settings.persisted_speech_keys = [...SETTINGS_SPEECH_KEYS].filter((k) => k in deps.settings.readRaw()).sort()
  Reflect.deleteProperty(settings, 'password_hash')
  Object.assign(settings, { max_tokens: null, max_tokens_effective: null, max_tokens_fallback: null })
  try { Object.assign(settings, maxTokensStatus(await deps.agentConfig.read(home(ctx)))) } catch { /* unavailable: nulls stand */ }
  await authFields(ctx, settings)
  derivedFields(ctx, settings)
  return settings
}

/** Fields computed from the environment, not stored: load and save both return them so a save never blanks them in the client cache. */
function derivedFields(ctx: RequestContext, into: Dict): void {
  const deps = ctx.deps
  into.password_env_var = Boolean((deps.config.env.HERMES_WEBUI_PASSWORD ?? '').trim())
  into.webui_version = deps.version
  into.agent_version = deps.agentVersion()
  into.update_channel = str(into.update_channel) || 'stable'
  into.update_channel_version = deps.version
}

async function saveSettings(ctx: RequestContext, input: Dict): Promise<Dict> {
  const deps = ctx.deps
  const auth = deps.auth
  const body: Dict = { ...input }
  if (['auto_apply_updates', 'update_channel', 'agent_update_channel', 'check_for_updates'].some((key) => key in body) && !(await canManageServer(ctx))) throw new HttpError(403, 'An owner session is required to manage updates')
  if ('bot_name' in body) body.bot_name = displayBotName(body.bot_name)
  const authEnabledBefore = await auth.isAuthEnabled()
  const passwordAuthBefore = authEnabledBefore && (await auth.getPasswordHash()) !== null
  const cookie = ctx.authCookie()
  const loggedInBefore = Boolean(cookie && auth.verifySession(cookie))
  const requestedPassword = typeof body._set_password === 'string' && body._set_password.trim() !== ''
  const requestedPasswordless = pyBool(body._passwordless)
  Reflect.deleteProperty(body, '_passwordless')
  const requestedClear = pyBool(body._clear_password) || requestedPasswordless
  if (requestedPasswordless) body._clear_password = true
  if ((requestedPassword || requestedClear) && !(await canManageServer(ctx))) throw new HttpError(403, 'An owner session is required to manage owner authentication credentials')
  const currentPassword = body._current_password
  Reflect.deleteProperty(body, '_current_password')
  if ((requestedPassword || requestedClear) && (deps.config.env.HERMES_WEBUI_PASSWORD ?? '').trim()) {
    throw new HttpError(409, 'HERMES_WEBUI_PASSWORD env var is set — it overrides the settings password. Unset the env var and restart the server before changing the password here.')
  }
  const maxTokensProvided = 'max_tokens' in body
  const maxTokensValue = body.max_tokens
  Reflect.deleteProperty(body, 'max_tokens')
  if (requestedPassword && !authEnabledBefore && !(await onboardingGateAllows(ctx, authEnabledBefore))) {
    throw new HttpError(403, 'First password setup is only available from local networks when auth is not enabled. To bootstrap this on a remote server, set HERMES_WEBUI_ONBOARDING_OPEN=1.')
  }
  if (authEnabledBefore && passwordAuthBefore && (requestedPassword || requestedClear)) {
    if (typeof currentPassword !== 'string' || !currentPassword) throw new HttpError(403, 'Current password is required to change or disable authentication.')
    if (!(await auth.verifyPassword(currentPassword))) throw new HttpError(403, 'Current password is incorrect.')
  }
  if (requestedPasswordless) {
    if (!auth.passkeyFeatureFlagEnabled()) throw new HttpError(409, 'Passkey support is disabled. Enable HERMES_WEBUI_PASSKEY before going passwordless.')
    if (!auth.passkeysEnabled()) throw new HttpError(409, 'Register a passkey before going passwordless.')
  } else if (requestedClear) deps.clearPasskeys()
  const ack = body._auth_disabled_acknowledged
  Reflect.deleteProperty(body, '_auth_disabled_acknowledged')
  if (ack !== undefined && ack !== null && !(await auth.isAuthEnabled())) body.auth_disabled_acknowledged = pyBool(ack)
  else if ((await auth.isAuthEnabled()) || requestedPassword) body.auth_disabled_acknowledged = false

  const saved: Dict = await deps.settings.save(body)
  saved.persisted_speech_keys = [...SETTINGS_SPEECH_KEYS].filter((k) => k in deps.settings.readRaw()).sort()
  Reflect.deleteProperty(saved, 'password_hash')
  const cfgHome = home(ctx)
  try {
    Object.assign(saved, maxTokensProvided ? await setMaxTokens(deps.agentConfig, cfgHome, maxTokensValue) : maxTokensStatus(await deps.agentConfig.read(cfgHome)))
  } catch (error) {
    if (maxTokensProvided) failure(error)
    Object.assign(saved, { max_tokens: null, max_tokens_effective: null, max_tokens_fallback: null })
  }
  const authEnabledAfter = await auth.isAuthEnabled()
  const authJustEnabled = requestedPassword && authEnabledAfter && !authEnabledBefore
  let loggedInAfter = loggedInBefore
  if (authJustEnabled && !loggedInBefore) {
    ctx.queueCookie(ctx.authCookieHeader(auth.createSession({ authType: 'password' })))
    loggedInAfter = true
  }
  saved.auth_enabled = authEnabledAfter
  saved.logged_in = loggedInAfter
  saved.auth_just_enabled = authJustEnabled
  await authFields(ctx, saved)
  saved.auth_enabled = authEnabledAfter
  derivedFields(ctx, saved)
  return saved
}

const effortsResolver = (ctx: RequestContext) => async (model: string, provider: string): Promise<string[]> => {
  const sidecar = ctx.deps.sidecar()
  if (!sidecar) return []
  try {
    return (await sidecar.call('models.reasoning_efforts', { profile_home: home(ctx), model, provider })).efforts
  } catch {
    return []
  }
}

const OAUTH_UNAVAILABLE = 'Browser OAuth onboarding is not available in this release. Run `hermes auth` in a terminal, then reload.'

export const settingsRouter = os.router({
  settings: {
    get: os.settings.get.handler(({ context: { ctx } }) => run(() => settingsPayload(ctx))),
    save: os.settings.save.handler(({ input, context: { ctx } }) => run(() => saveSettings(ctx, input))),
  },
  profiles: {
    list: os.profiles.list.handler(({ context: { ctx } }) => run(async () => ({ profiles: await ctx.deps.profiles.list(activeProfileName(ctx)) as never[], active: activeProfileName(ctx), single_profile_mode: ctx.deps.isolatedProfileMode() }))),
    active: os.profiles.active.handler(({ context: { ctx } }) => run(() => ctx.deps.profiles.activePayload(activeProfileName(ctx)) as never)),
    switch: os.profiles.switch.handler(({ input, context: { ctx } }) => run(async () => {
      const name = str(input.name ?? input.profile).trim()
      if (!name) throw new HttpError(400, 'name is required')
      // Python `switch_profile`: an invalid name is a `ValueError`, which the route answered as 404.
      if (name !== 'default') { try { validateProfileName(name) } catch (error) { throw new HttpError(404, (error as Error).message) } }
      const info = await ensureTrustedAuthSession(ctx)
      if (ctx.trusted.rejected) throw new HttpError(401, 'Authentication required')
      const bound = str(info?.bound_profile).trim() || null
      if (bound && name !== bound) throw new HttpError(403, 'Profile is bound to the current session')
      const result = await ctx.deps.profiles.switch(name)
      ctx.deps.catalog.invalidate()
      const sessionCookie = ctx.trusted.cookieValue ?? null
      if (!(sessionCookie && bound && name === bound)) ctx.queueCookie(await buildProfileCookie(ctx, name, sessionCookie))
      return result as never
    })),
    create: os.profiles.create.handler(({ input, context: { ctx } }) => run(async () => {
      if (!(await canManageServer(ctx))) throw new HttpError(403, 'An owner session is required to manage profiles')
      const name = str(input.name).trim()
      if (!name) throw new HttpError(400, 'name is required')
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new HttpError(400, 'Invalid profile name: lowercase letters, numbers, hyphens, underscores only')
      const cloneFrom = input.clone_from === null || input.clone_from === undefined ? null : str(input.clone_from).trim()
      if (cloneFrom !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(cloneFrom)) throw new HttpError(400, 'Invalid clone_from name')
      const baseUrl = str(input.base_url).trim() || null
      if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new HttpError(400, 'base_url must start with http:// or https://')
      const profile = await ctx.deps.profiles.create({ name, clone_from: cloneFrom, clone_config: pyBool(input.clone_config), base_url: baseUrl, api_key: str(input.api_key).trim() || null, default_model: str(input.default_model).trim() || null, model_provider: str(input.model_provider).trim() || null })
      return { ok: true as const, profile: profile as never }
    })),
    delete: os.profiles.delete.handler(({ input, context: { ctx } }) => run(async () => {
      if (!(await canManageServer(ctx))) throw new HttpError(403, 'An owner session is required to manage profiles')
      const name = str(input.name ?? input.profile).trim()
      if (!name) throw new HttpError(400, 'name is required')
      const active = activeProfileName(ctx)
      const result = await ctx.deps.profiles.delete(name, active)
      // A client scoped to the profile it just deleted goes back to `default`; a later write under the stale cookie
      // would otherwise recreate `profiles/<name>` through the config writer.
      if (active === name) ctx.queueCookie(await buildProfileCookie(ctx, 'default', ctx.trusted.cookieValue ?? null))
      return result
    })),
  },
  models: {
    list: os.models.list.handler(({ input, context: { ctx } }) => run(() => {
      const freshness = str(input.freshness).trim().toLowerCase()
      if (freshness && freshness !== 'session_visit') throw new HttpError(400, `unknown models freshness: ${freshness}`)
      return ctx.deps.catalog.models(home(ctx))
    })),
    live: os.models.live.handler(({ input, context: { ctx } }) => run(() => ctx.deps.catalog.liveModels(home(ctx), str(input.provider)))),
    refresh: os.models.refresh.handler(({ input, context: { ctx } }) => run(async () => {
      const provider = str(input.provider).trim().toLowerCase() || null
      ctx.deps.catalog.invalidate(home(ctx), provider ?? undefined)
      ctx.deps.agentConfig.invalidate(home(ctx))
      return { ok: true as const, provider, models: await ctx.deps.catalog.models(home(ctx)) }
    })),
    auxiliary: os.models.auxiliary.handler(({ context: { ctx } }) => run(() => auxiliaryState(ctx) as never)),
    set: os.models.set.handler(({ input, context: { ctx } }) => run(async () => {
      const scope = str(input.scope).trim()
      const provider = str(input.provider).trim() || 'auto'
      const model = str(input.model).trim()
      try {
        if (scope === 'auxiliary') {
          const saved = await setAuxiliaryModel(ctx.deps.agentConfig, home(ctx), str(input.task).trim(), provider, model, input.advanced)
          ctx.deps.catalog.invalidate()
          // The write is saved; a catalog failure only drops the refreshed state, and clients then reread it.
          const auxiliary = await auxiliaryState(ctx).catch(() => undefined)
          return { ...saved, ...(auxiliary ? { auxiliary: auxiliary as never } : {}) }
        }
        if (scope === 'main') return await setDefaultModel(ctx.deps.agentConfig, home(ctx), model, provider === 'auto' ? null : provider, input.advanced)
      } catch (error) {
        if (error instanceof ConfigUnavailable) throw error
        throw new HttpError(400, str((error as Error).message))
      } finally {
        ctx.deps.catalog.invalidate()
      }
      throw new HttpError(400, `unknown scope: ${scope}`)
    })),
    setDefault: os.models.setDefault.handler(({ input, context: { ctx } }) => run(async () => {
      const provider = str(input.provider).trim().toLowerCase() === 'auto' ? null : input.provider ?? null
      try {
        return await setDefaultModel(ctx.deps.agentConfig, home(ctx), input.model, provider, input.advanced)
      } catch (error) {
        if (error instanceof ConfigUnavailable) throw error
        throw new HttpError(400, str((error as Error).message))
      } finally {
        ctx.deps.catalog.invalidate()
      }
    })),
  },
  providers: {
    list: os.providers.list.handler(({ context: { ctx } }) => run(() => ctx.deps.catalog.providers(home(ctx)) as Promise<never>)),
    setKey: os.providers.setKey.handler(({ input, context: { ctx } }) => run(() => setProviderKey(ctx, str(input.provider).trim().toLowerCase(), input.api_key === null || input.api_key === undefined ? null : str(input.api_key).trim() || null))),
    delete: os.providers.delete.handler(({ input, context: { ctx } }) => run(async () => {
      const pid = str(input.provider).trim().toLowerCase()
      // The YAML copy goes first and its failure is the response: a credential deletion is only "removed" once every
      // persisted source is clear. Provider detection canonicalises ids, so every alias block (`providers.ramp` for
      // `router`) must go too.
      const canonical = canonicaliseProviderId(pid)
      await ctx.deps.agentConfig.update(home(ctx), (c) => {
        let changed = false
        const providers = c.providers
        if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
          for (const [key, p] of Object.entries(providers as Dict)) {
            if (canonicaliseProviderId(key) !== canonical) continue
            if (p && typeof p === 'object' && 'api_key' in (p as Dict)) { Reflect.deleteProperty(p, 'api_key'); changed = true }
          }
        }
        const model = c.model
        if (model && typeof model === 'object' && !Array.isArray(model) && canonicaliseProviderId((model as Dict).provider) === canonical && 'api_key' in (model as Dict)) { Reflect.deleteProperty(model, 'api_key'); changed = true }
        return changed
      })
      return setProviderKey(ctx, pid, null)
    })),
    selfHosted: os.providers.selfHosted.handler(({ input, context: { ctx } }) => run(async () => { const r = await ctx.deps.onboarding.selfHosted(input); ctx.deps.catalog.invalidate(); return r })),
    quota: os.providers.quota.handler(({ input, context: { ctx } }) => run(() => ctx.deps.catalog.quota(home(ctx), str(input.provider).trim() || null, { refresh: truthy(input.refresh) }))),
    quotas: os.providers.quotas.handler(({ input, context: { ctx } }) => run(() => ctx.deps.catalog.quotas(home(ctx), activeProfileName(ctx), { sourceId: str(input.source).trim() || null, refresh: truthy(input.refresh) }) as Promise<never>)),
    costHistory: os.providers.costHistory.handler(({ input, context: { ctx } }) => run(() => {
      const parsed = Number.parseInt(str(input.days ?? '7').trim() || '7', 10)
      const days = Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 365)) : 7
      return ctx.deps.catalog.costHistory(home(ctx), str(input.provider).trim() || null, days)
    })),
  },
  reasoning: {
    get: os.reasoning.get.handler(({ input, context: { ctx } }) => run(async () => reasoningStatus(await ctx.deps.agentConfig.read(home(ctx)), effortsResolver(ctx), { model: input.model ?? null, provider: input.provider ?? null, baseUrl: input.base_url ?? null }))),
    set: os.reasoning.set.handler(({ input, context: { ctx } }) => run(async () => {
      const h = home(ctx)
      if (input.display !== undefined && input.display !== null) {
        const flag = str(input.display).trim().toLowerCase()
        let show: boolean
        if (['show', 'on', 'true', '1'].includes(flag)) show = true
        else if (['hide', 'off', 'false', '0'].includes(flag)) show = false
        else throw new HttpError(400, `display must be show|hide|on|off (got '${str(input.display)}')`)
        const config = await ctx.deps.agentConfig.update(h, (c) => { c.display = { ...(c.display && typeof c.display === 'object' && !Array.isArray(c.display) ? (c.display) : {}), show_reasoning: show } })
        return reasoningStatus(config, effortsResolver(ctx))
      }
      if (input.effort !== undefined && input.effort !== null) {
        const raw = str(input.effort).trim().toLowerCase()
        if (!validReasoningEffort(raw)) throw new HttpError(400, `Unknown reasoning effort '${str(input.effort)}'. Valid: none, minimal, low, medium, high, xhigh, max, ultra.`)
        const config = await ctx.deps.agentConfig.update(h, (c) => {
          const agent = c.agent && typeof c.agent === 'object' && !Array.isArray(c.agent) ? (c.agent as Dict) : {}
          if (raw) agent.reasoning_effort = raw
          else Reflect.deleteProperty(agent, 'reasoning_effort')
          c.agent = agent
        })
        return reasoningStatus(config, effortsResolver(ctx), { model: input.model ?? null, provider: input.provider ?? null, baseUrl: input.base_url ?? null })
      }
      throw new HttpError(400, "reasoning: must supply 'display' or 'effort'")
    })),
  },
  personalities: {
    list: os.personalities.list.handler(({ context: { ctx } }) => run(async () => ({ personalities: personalityRows(await ctx.deps.agentConfig.read(home(ctx))) }))),
    set: os.personalities.set.handler(({ input, context: { ctx } }) => run(async () => {
      const sid = str(input.session_id).trim()
      if (!sid) throw new HttpError(400, 'Missing required field: session_id')
      if (input.name === undefined) throw new HttpError(400, 'Missing required field: name')
      const name = str(input.name).trim()
      if (!ctx.deps.sessions.sessionIdVisible(sid)) throw new HttpError(404, 'Session not found')
      let prompt = ''
      if (name) {
        const resolved = personalityPrompt(await ctx.deps.agentConfig.read(home(ctx)), name)
        if (resolved === null) throw new HttpError(404, `Personality "${name}" not found in config.yaml`)
        prompt = resolved
      }
      const personality = await ctx.deps.sessions.setPersonality(sid, name || null)
      return { ok: true as const, personality, prompt }
    })),
  },
  onboarding: {
    status: os.onboarding.status.handler(({ context: { ctx } }) => run(() => ctx.deps.onboarding.status() as Promise<never>)),
    setup: os.onboarding.setup.handler(({ input, context: { ctx } }) => run(async () => {
      if (!(await onboardingGateAllows(ctx))) throw new HttpError(403, 'Onboarding setup is only available from local networks when auth is not enabled. To bypass this on a remote server, set HERMES_WEBUI_ONBOARDING_OPEN=1.')
      const result = await ctx.deps.onboarding.setup(input)
      ctx.deps.catalog.invalidate()
      return result
    })),
    complete: os.onboarding.complete.handler(({ context: { ctx } }) => run(async () => {
      if (!(await onboardingGateAllows(ctx))) throw new HttpError(403, 'Onboarding is only available from local networks when auth is not enabled. To bypass this on a remote server, set HERMES_WEBUI_ONBOARDING_OPEN=1.')
      return ctx.deps.onboarding.complete() as Promise<never>
    })),
    probe: os.onboarding.probe.handler(({ input, context: { ctx } }) => run(async () => {
      if (!(await onboardingGateAllows(ctx))) throw new HttpError(403, 'Onboarding probe is only available from local networks when auth is not enabled. To bypass this on a remote server, set HERMES_WEBUI_ONBOARDING_OPEN=1.')
      try {
        return await ctx.deps.onboarding.probe(str(input.base_url), str(input.api_key).trim() || null)
      } catch (error) {
        throw new HttpError(500, `probe failed: ${str((error as Error).message)}`)
      }
    })),
    oauthStart: os.onboarding.oauthStart.handler(({ context: { ctx } }) => run(async () => {
      if (!(await onboardingGateAllows(ctx))) throw new HttpError(403, 'Onboarding OAuth is only available from local networks when auth is not enabled. To bypass this on a remote server, set HERMES_WEBUI_ONBOARDING_OPEN=1.')
      throw new HttpError(501, OAUTH_UNAVAILABLE)
    })),
    oauthCancel: os.onboarding.oauthCancel.handler(() => run(() => { throw new HttpError(501, OAUTH_UNAVAILABLE) })),
    oauthPoll: os.onboarding.oauthPoll.handler(() => run(() => { throw new HttpError(501, OAUTH_UNAVAILABLE) })),
  },
})

/** Python `set_provider_key`: `.env` write; `null` removes the key. */
async function setProviderKey(ctx: RequestContext, pid: string, apiKey: string | null): Promise<{ ok: true; provider: string; display_name: string; action: string }> {
  if (!pid) throw new HttpError(400, 'provider is required')
  if (OAUTH_PROVIDERS.has(pid)) throw new HttpError(400, `'${displayName(pid)}' uses OAuth authentication. Use \`hermes model\` in the terminal to configure it.`)
  const envVar = providerEnvVar(pid)
  if (!envVar) throw new HttpError(400, `Cannot configure API key for '${displayName(pid)}'. This provider does not have a known env var mapping.`)
  if (apiKey) {
    if (apiKey.includes('\n') || apiKey.includes('\r')) throw new HttpError(400, 'API key must not contain newline characters.')
    if (apiKey.length < 8) throw new HttpError(400, 'API key appears too short.')
  }
  const envPath = join(home(ctx), '.env')
  // The running sidecar must confirm the change first: a credential the file no longer holds may not linger in it.
  try {
    await writeRuntimeCredential({ env: ctx.deps.config.env, sidecar: ctx.deps.sidecar, log: ctx.deps.log }, ctx.deps.isRootProfile(activeProfileName(ctx)), envVar, apiKey, () => { writeEnvFile(envPath, { [envVar]: apiKey }) })
  } catch (error) {
    if (error instanceof RuntimeCredentialError) throw new HttpError(503, error.message)
    throw new HttpError(400, `Failed to save API key: ${str((error as Error).message)}`)
  }
  ctx.deps.catalog.invalidate()
  return { ok: true, provider: pid, display_name: displayName(pid), action: apiKey ? 'updated' : 'removed' }
}
