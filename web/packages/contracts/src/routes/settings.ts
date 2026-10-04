import { oc } from '@orpc/contract'
import { z } from 'zod'
import { SettingsSchema, ReasoningStatusSchema, PersonalitiesSchema, ModelsSchema, ProvidersSchema, ProfileSchema, ProfilesSchema, ActiveProfileSchema, ProfileSwitchSchema, AuxiliaryModelsSchema, ProviderQuotaSchema, ProviderQuotasSchema, OnboardingStatusSchema, OnboardingProbeSchema, OnboardingOAuthSchema } from '../views.js'

/** Settings, profiles, models, providers, reasoning, personalities, and onboarding. */

const Json = z.unknown()
const Loose = z.record(z.string(), z.unknown())
const tags = ['settings']

export const ErrorSchema = z.object({ error: z.string() })

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
    set: oc.route({ method: 'POST', path: '/api/model/set', tags, summary: 'scope=main sets config.yaml model.default; scope=auxiliary assigns one task slot (`__reset__` clears all) and answers the refreshed auxiliary state. An auxiliary `model` may be a `/api/models` entry id; provider `auto` with an empty model clears the override.' }).input(AdvancedBody.extend({ scope: z.string().optional(), task: z.string().optional(), provider: z.string().optional(), model: z.string().optional(), session_id: z.string().optional(), model_provider: z.string().nullable().optional(), explicit: z.boolean().optional() })).output(z.looseObject({ ok: z.boolean().optional(), session: Json.optional(), error: z.string().optional(), auxiliary: AuxiliaryModelsSchema.optional() })),
    setDefault: oc.route({ method: 'POST', path: '/api/default-model', tags }).input(AdvancedBody.extend({ model: z.string().optional(), provider: z.string().nullable().optional() })).output(z.object({ ok: z.literal(true), model: z.string(), provider: z.string().nullable() })),
  },
  providers: {
    list: oc.route({ method: 'GET', path: '/api/providers', tags }).output(ProvidersSchema),
    setKey: oc.route({ method: 'POST', path: '/api/providers', tags, summary: 'Write (or clear when api_key is empty) a provider API key in the profile .env.' }).input(z.object({ provider: z.string().optional(), api_key: z.string().nullable().optional() })).output(z.object({ ok: z.literal(true), provider: z.string(), display_name: z.string(), action: z.string() })),
    delete: oc.route({ method: 'POST', path: '/api/providers/delete', tags }).input(z.object({ provider: z.string().optional() })).output(z.object({ ok: z.literal(true), provider: z.string(), display_name: z.string(), action: z.string() })),
    selfHosted: oc.route({ method: 'POST', path: '/api/providers/self-hosted', tags }).input(Loose).output(Loose),
    quota: oc.route({ method: 'GET', path: '/api/provider/quota', tags }).input(z.object({ provider: z.string().optional(), refresh: z.string().optional() })).output(ProviderQuotaSchema),
    quotas: oc.route({ method: 'GET', path: '/api/provider/quotas', tags }).input(z.object({ source: z.string().optional(), refresh: z.string().optional() })).output(ProviderQuotasSchema),
    costHistory: oc.route({ method: 'GET', path: '/api/provider/cost-history', tags }).input(z.object({ provider: z.string().optional(), days: z.string().optional() })).output(z.looseObject({ history: z.array(Json).optional(), days: z.array(Json).optional() })),
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
    setup: oc.route({ method: 'POST', path: '/api/onboarding/setup', tags }).input(Loose).output(z.looseObject({ ok: z.boolean().optional(), error: z.string().optional(), status: Json.optional() })),
    complete: oc.route({ method: 'POST', path: '/api/onboarding/complete', tags }).input(Loose.optional()).output(OnboardingStatusSchema),
    probe: oc.route({ method: 'POST', path: '/api/onboarding/probe', tags }).input(z.object({ provider: z.string().optional(), base_url: z.string().optional(), api_key: z.string().nullable().optional() })).output(OnboardingProbeSchema),
    oauthStart: oc.route({ method: 'POST', path: '/api/onboarding/oauth/start', tags, summary: "Start a device-code sign-in for a provider whose onboarding entry has `oauth_flow: 'device_code'`." }).input(z.looseObject({ provider: z.string().optional() })).output(OnboardingOAuthSchema),
    oauthCancel: oc.route({ method: 'POST', path: '/api/onboarding/oauth/cancel', tags, summary: 'Cancel a pending device-code sign-in; nothing is saved after it.' }).input(z.looseObject({ flow_id: z.string().optional() })).output(OnboardingOAuthSchema),
    oauthPoll: oc.route({ method: 'GET', path: '/api/onboarding/oauth/poll', tags, summary: 'Report a device-code sign-in; `approved` means the Agent saved the credential.' }).input(z.object({ flow_id: z.string().optional() })).output(OnboardingOAuthSchema),
  },
}
