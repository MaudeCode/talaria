import { oc } from '@orpc/contract'
import { z } from 'zod'

/** Settings, profiles, models, providers, reasoning, personalities, and onboarding. */

const Json = z.unknown()
const Loose = z.record(z.string(), z.unknown())
const tags = ['settings']

export const ErrorSchema = z.object({ error: z.string() })
export const SettingsSchema = Loose
export const MaxTokensSchema = z.object({ max_tokens: z.number().int().nullable(), max_tokens_effective: z.number().int().nullable(), max_tokens_fallback: z.number().int().nullable() })
export const ReasoningStatusSchema = z.object({ show_reasoning: z.boolean(), reasoning_effort: z.string(), supported_efforts: z.array(z.string()), supports_reasoning_effort: z.boolean(), supports_thinking_toggle: z.boolean() })
export const PersonalitiesSchema = z.object({ personalities: z.array(z.object({ name: z.string(), description: z.string() })) })
export const ModelEntrySchema = z.object({ id: z.string(), label: z.string(), supports_fast_tier: z.boolean().optional() })
export const ModelGroupSchema = z.object({ provider: z.string(), provider_id: z.string(), models: z.array(ModelEntrySchema) })
export const ModelsSchema = z.object({
  active_provider: z.string().nullable(), default_model: z.string(), groups: z.array(ModelGroupSchema), aliases: z.record(z.string(), z.string()),
  configured_model_badges: z.record(z.string(), z.object({ role: z.string(), label: z.string(), provider: z.string() })),
})
export const ProviderSchema = z.object({
  id: z.string(), display_name: z.string(), has_key: z.boolean(), configurable: z.boolean(), is_oauth: z.boolean(), is_plugin_provider: z.boolean(), is_self_hosted: z.boolean(), is_custom: z.boolean(),
  key_source: z.string(), base_url: z.string().nullable(), auth_error: z.string().nullable(), env_var: z.string().nullable(), models: z.array(ModelEntrySchema), models_total: z.number().int(),
})
export const ProvidersSchema = z.object({ providers: z.array(ProviderSchema), active_provider: z.string().nullable() })
export const ProfileSchema = z.object({
  name: z.string(), path: z.string(), is_default: z.boolean(), is_active: z.boolean(), gateway_running: z.boolean(), model: z.string().nullable(), provider: z.string().nullable(),
  has_env: z.boolean(), visible: z.boolean(), skill_count: z.number().int(), enabled_skills: z.number().int(), total_skills: z.number().int(),
})
export const ProfilesSchema = z.object({ profiles: z.array(ProfileSchema), active: z.string(), single_profile_mode: z.boolean() })
export const ActiveProfileSchema = z.object({ name: z.string(), path: z.string(), is_default: z.boolean(), default_workspace: z.string().nullable() })
export const ProfileSwitchSchema = z.object({ profiles: z.array(ProfileSchema), active: z.string(), is_default: z.boolean(), default_model: Json, default_model_provider: Json, default_workspace: z.string().nullable() })
export const AuxiliaryTaskSchema = z.object({
  task: z.string(), provider: z.string(), model: z.string(), base_url: z.string(), timeout: Json, download_timeout: Json, max_concurrency: Json, extra_body: Loose, api_key_set: z.boolean(), label: z.string(), description: z.string(),
})
export const AuxiliaryModelsSchema = z.object({ tasks: z.array(AuxiliaryTaskSchema), main: Loose })
export const QuotaSourceSchema = z.object({
  source_id: z.string(), provider_id: z.string(), provider_label: z.string(), account_label: z.string(), is_active_provider: z.boolean(), supported: z.boolean(), status: z.string(),
  plan: Json, windows: Json, quota: Json, balances: Json, details: Json, unavailable_reason: Json, retry_after: Json, fetched_at: Json, message: Json,
})
export const ProviderQuotasSchema = z.object({ sources: z.array(QuotaSourceSchema), active_provider: z.string().nullable(), version: z.number().int() })
export const OnboardingStatusSchema = z.object({
  completed: z.boolean(), settings: z.object({ default_model: z.string(), default_workspace: z.string(), password_enabled: z.boolean(), bot_name: z.string() }),
  system: Loose, setup: Loose, workspaces: z.object({ items: z.array(z.object({ path: z.string(), name: z.string() })), last: z.string().nullable() }), models: ModelsSchema,
})

const AdvancedBody = z.object({ advanced: Loose.nullable().optional() })

export const settingsContract = {
  settings: {
    get: oc.route({ method: 'GET', path: '/api/settings', tags, summary: 'Server settings plus auth-state, max_tokens, and version badges.' }).output(SettingsSchema),
    save: oc.route({ method: 'POST', path: '/api/settings', tags, summary: 'Save settings; `_set_password`, `_clear_password`, `_passwordless`, `_current_password`, and `max_tokens` are handled specially.' }).input(Loose).output(SettingsSchema),
  },
  profiles: {
    list: oc.route({ method: 'GET', path: '/api/profiles', tags }).output(ProfilesSchema),
    active: oc.route({ method: 'GET', path: '/api/profile/active', tags }).output(ActiveProfileSchema),
    switch: oc.route({ method: 'POST', path: '/api/profile/switch', tags, summary: 'Per-client switch: sets the profile cookie; never mutates the process-wide profile.' }).input(z.object({ name: z.string().optional(), profile: z.string().optional() })).output(ProfileSwitchSchema),
    create: oc.route({ method: 'POST', path: '/api/profile/create', tags }).input(z.object({ name: z.string().optional(), clone_from: z.string().nullable().optional(), clone_config: Json.optional(), base_url: z.string().nullable().optional(), api_key: z.string().nullable().optional(), default_model: z.string().nullable().optional(), model_provider: z.string().nullable().optional() })).output(z.object({ ok: z.literal(true), profile: ProfileSchema })),
    delete: oc.route({ method: 'POST', path: '/api/profile/delete', tags }).input(z.object({ name: z.string().optional(), profile: z.string().optional() })).output(z.object({ ok: z.literal(true), name: z.string() })),
  },
  models: {
    list: oc.route({ method: 'GET', path: '/api/models', tags }).input(z.object({ freshness: z.string().optional() })).output(ModelsSchema),
    live: oc.route({ method: 'GET', path: '/api/models/live', tags }).input(z.object({ provider: z.string().optional() })).output(Loose),
    refresh: oc.route({ method: 'POST', path: '/api/models/refresh', tags, summary: 'Evict the live model cache for one provider (or all when omitted) and answer the rebuilt catalog.' }).input(z.object({ provider: z.string().optional() })).output(z.object({ ok: z.literal(true), provider: z.string().nullable(), models: ModelsSchema })),
    auxiliary: oc.route({ method: 'GET', path: '/api/model/auxiliary', tags }).output(AuxiliaryModelsSchema),
    set: oc.route({ method: 'POST', path: '/api/model/set', tags, summary: 'scope=main sets config.yaml model.default; scope=auxiliary assigns one task slot (`__reset__` clears all).' }).input(AdvancedBody.extend({ scope: z.string().optional(), task: z.string().optional(), provider: z.string().optional(), model: z.string().optional() })).output(Loose),
    setDefault: oc.route({ method: 'POST', path: '/api/default-model', tags }).input(AdvancedBody.extend({ model: z.string().optional(), provider: z.string().nullable().optional() })).output(z.object({ ok: z.literal(true), model: z.string(), provider: z.string().nullable() })),
  },
  providers: {
    list: oc.route({ method: 'GET', path: '/api/providers', tags }).output(ProvidersSchema),
    setKey: oc.route({ method: 'POST', path: '/api/providers', tags, summary: 'Write (or clear when api_key is empty) a provider API key in the profile .env.' }).input(z.object({ provider: z.string().optional(), api_key: z.string().nullable().optional() })).output(z.object({ ok: z.literal(true), provider: z.string(), display_name: z.string(), action: z.string() })),
    delete: oc.route({ method: 'POST', path: '/api/providers/delete', tags }).input(z.object({ provider: z.string().optional() })).output(z.object({ ok: z.literal(true), provider: z.string(), display_name: z.string(), action: z.string() })),
    selfHosted: oc.route({ method: 'POST', path: '/api/providers/self-hosted', tags }).input(Loose).output(Loose),
    quota: oc.route({ method: 'GET', path: '/api/provider/quota', tags }).input(z.object({ provider: z.string().optional(), refresh: z.string().optional() })).output(Loose),
    quotas: oc.route({ method: 'GET', path: '/api/provider/quotas', tags }).input(z.object({ source: z.string().optional(), refresh: z.string().optional() })).output(ProviderQuotasSchema),
    costHistory: oc.route({ method: 'GET', path: '/api/provider/cost-history', tags }).input(z.object({ provider: z.string().optional(), days: z.string().optional() })).output(Loose),
  },
  reasoning: {
    get: oc.route({ method: 'GET', path: '/api/reasoning', tags }).input(z.object({ model: z.string().optional(), provider: z.string().optional(), base_url: z.string().optional() })).output(ReasoningStatusSchema),
    set: oc.route({ method: 'POST', path: '/api/reasoning', tags, summary: 'Body is `{display: show|hide}` or `{effort, model?, provider?, base_url?}`.' }).input(z.object({ display: Json.optional(), effort: Json.optional(), model: z.string().nullable().optional(), provider: z.string().nullable().optional(), base_url: z.string().nullable().optional() })).output(ReasoningStatusSchema),
  },
  personalities: {
    list: oc.route({ method: 'GET', path: '/api/personalities', tags }).output(PersonalitiesSchema),
    set: oc.route({ method: 'POST', path: '/api/personality/set', tags }).input(z.object({ session_id: z.string().optional(), name: z.string().optional() })).output(z.object({ ok: z.literal(true), personality: z.string().nullable(), prompt: z.string() })),
  },
  onboarding: {
    status: oc.route({ method: 'GET', path: '/api/onboarding/status', tags }).output(OnboardingStatusSchema),
    setup: oc.route({ method: 'POST', path: '/api/onboarding/setup', tags }).input(Loose).output(Loose),
    complete: oc.route({ method: 'POST', path: '/api/onboarding/complete', tags }).input(Loose.optional()).output(OnboardingStatusSchema),
    probe: oc.route({ method: 'POST', path: '/api/onboarding/probe', tags }).input(z.object({ provider: z.string().optional(), base_url: z.string().optional(), api_key: z.string().nullable().optional() })).output(Loose),
    oauthStart: oc.route({ method: 'POST', path: '/api/onboarding/oauth/start', tags, summary: 'Browser OAuth flows are not available in this release (501).' }).input(Loose).output(Loose),
    oauthCancel: oc.route({ method: 'POST', path: '/api/onboarding/oauth/cancel', tags }).input(Loose).output(Loose),
    oauthPoll: oc.route({ method: 'GET', path: '/api/onboarding/oauth/poll', tags }).input(z.object({ flow_id: z.string().optional() })).output(Loose),
  },
}
