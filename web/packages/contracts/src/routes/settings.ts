import { DelegationWriteSchema } from '../delegation.js'
import { AgentImportSourceSchema, AgentImportResultSchema } from '../agent-imports.js'
import { oc } from '@orpc/contract'
import { z } from 'zod'
import { SettingsSchema, ReasoningStatusSchema, PersonalitiesSchema, ModelsSchema, ModelsLiveSchema, ProvidersSchema, ProfileSchema, ProfilesSchema, ActiveProfileSchema, ProfileSwitchSchema, AuxiliaryModelsSchema, ProviderQuotaSchema, ProviderQuotasSchema, ProviderCostHistorySchema, OnboardingStatusSchema, OnboardingProbeSchema, OnboardingOAuthSchema } from '../views.js'

/** Settings, profiles, models, providers, reasoning, personalities, and onboarding. */

const Json = z.unknown()
const Loose = z.record(z.string(), z.unknown())
const tags = ['settings']

export const ErrorSchema = z.object({ error: z.string() })

/** Mirror of `contracts/fixtures/feedback-attachment-limits.json`, which Relay enforces; a contract test keeps them equal. */
export const FEEDBACK_ATTACHMENT_LIMITS = {
  maxAttachments: 5,
  maxVideosPerReport: 1,
  maxVideoSeconds: 120,
  types: {
    'image/png': { kind: 'image', maxBytes: 10_000_000 },
    'image/jpeg': { kind: 'image', maxBytes: 10_000_000 },
    'image/heic': { kind: 'image', maxBytes: 10_000_000 },
    'image/webp': { kind: 'image', maxBytes: 10_000_000 },
    'video/mp4': { kind: 'video', maxBytes: 20_000_000 },
    'video/quicktime': { kind: 'video', maxBytes: 20_000_000 },
    'video/webm': { kind: 'video', maxBytes: 20_000_000 },
  },
  tierKinds: { verified: ['image', 'video'], unverified: [] },
} as const satisfies { maxAttachments: number; maxVideosPerReport: number; maxVideoSeconds: number; types: Record<string, { kind: 'image' | 'video'; maxBytes: number }>; tierKinds: Record<'verified' | 'unverified', readonly ('image' | 'video')[]> }
export type FeedbackAttachmentType = keyof typeof FEEDBACK_ATTACHMENT_LIMITS.types
export const FeedbackAttachmentTypeSchema = z.enum(Object.keys(FEEDBACK_ATTACHMENT_LIMITS.types) as [FeedbackAttachmentType, ...FeedbackAttachmentType[]])

const feedbackText = (max: number) => z.string().max(max).regex(/\S/, 'Must not be blank')
export const FeedbackSubmitSchema = z.strictObject({
  requestId: z.uuid(), kind: z.enum(['bug', 'feature', 'other']),
  title: feedbackText(120), body: feedbackText(8000),
  includeDiagnostics: z.boolean(),
  client: z.strictObject({ platform: z.enum(['web', 'ios']), appVersion: feedbackText(64).optional(), osVersion: feedbackText(64).optional(), deviceModel: feedbackText(64).optional() }),
  attachmentIds: z.array(z.uuid()).min(1).max(FEEDBACK_ATTACHMENT_LIMITS.maxAttachments).refine((ids) => new Set(ids).size === ids.length, 'Must not repeat').optional(),
})
export const FeedbackDiagnosticsSchema = z.object({ text: z.string().max(16384), bytes: z.number().int().min(0).max(16384) })
/** What this server lets its clients attach; `enabled` is false unless this server is a registered (signed) Relay publisher. */
export const FeedbackOptionsSchema = z.object({
  attachments: z.object({
    enabled: z.boolean(), videoAllowed: z.boolean(),
    maxCount: z.number().int().nonnegative(), maxVideoCount: z.number().int().nonnegative(), maxImageBytes: z.number().int().nonnegative(), maxVideoBytes: z.number().int().nonnegative(), maxVideoSeconds: z.number().int().nonnegative(),
    acceptedTypes: z.array(FeedbackAttachmentTypeSchema),
  }),
})
/** One staged file from `POST /api/feedback/attachments`, referenced by `attachmentIds` within an hour. */
export const FeedbackAttachmentStagedSchema = z.object({ attachmentId: z.uuid(), contentType: FeedbackAttachmentTypeSchema, bytes: z.number().int().positive() })
export const FeedbackAttachmentResultSchema = z.object({ attachmentId: z.uuid(), status: z.enum(['sent', 'refused']), reason: z.enum(['tier', 'quota', 'disabled', 'invalid', 'expired']).optional() })
export const FeedbackResultSchema = z.object({ status: z.literal('sent'), reportId: z.string().min(1), attachments: z.array(FeedbackAttachmentResultSchema).max(FEEDBACK_ATTACHMENT_LIMITS.maxAttachments) })
export const FeedbackErrorSchema = z.discriminatedUnion('error', [
  ErrorSchema.extend({ error: z.literal('rate_limited'), retryAfterSeconds: z.number().int().nonnegative() }),
  ErrorSchema.extend({ error: z.enum(['feedback_unavailable', 'relay_unreachable', 'invalid']) }),
])

export const ReasoningUnsupportedSchema = ErrorSchema.extend({ code: z.literal('reasoning_unsupported') })

const AdvancedBody = z.object({ advanced: Loose.nullable().optional() })

export const settingsContract = {
  feedback: {
    diagnostics: oc.route({ method: 'GET', path: '/api/feedback/diagnostics', tags, summary: 'Preview the redacted diagnostics attached to feedback.' }).output(FeedbackDiagnosticsSchema),
    options: oc.route({ method: 'GET', path: '/api/feedback/options', tags, summary: 'Attachment limits for this server: attachments are enabled only for a registered Relay publisher.' }).output(FeedbackOptionsSchema),
    submit: oc.route({ method: 'POST', path: '/api/feedback/submit', tags, summary: 'Forward feedback and its staged attachments to Relay; `attachments` reports each one as sent or refused with a reason. Reuse requestId after an unknown outcome. Errors: rate_limited with retryAfterSeconds (429), feedback_unavailable (503), relay_unreachable (502), invalid (400, including unknown, expired or another member\'s attachmentIds).' }).input(FeedbackSubmitSchema).output(FeedbackResultSchema),
  },
  settings: {
    get: oc.route({ method: 'GET', path: '/api/settings', tags, summary: 'Server settings plus auth-state, max_tokens, and version badges.' }).output(SettingsSchema),
    save: oc.route({ method: 'POST', path: '/api/settings', tags, summary: 'Save settings; `_set_password`, `_clear_password`, `_passwordless`, `_current_password`, and `max_tokens` are handled specially.' }).input(Loose).output(SettingsSchema),
    linkCheck: oc.route({ method: 'POST', path: '/api/settings/link-check', tags, summary: 'Whether a clicked chat link opens without the confirmation dialog (only absolute HTTP(S) URLs, when `confirm_external_links` is off or the exact hostname is in `trusted_link_hosts`), and the hostname that dialog names (null when the URL has none).' }).input(z.object({ url: z.string().max(16384) })).output(z.object({ opens_directly: z.boolean(), host: z.string().nullable() })),
  },
  profileImport: {
    discover: oc.route({ method: 'GET', path: '/api/profile/import', tags, summary: 'Owner only: permitted local coding-agent sources and reviewed importer availability.' }).output(AgentImportResultSchema),
    preview: oc.route({ method: 'POST', path: '/api/profile/import/preview', tags, summary: 'Owner only: preview with no source or profile writes. Consent binds the active profile, reviewed plugin and source/target snapshots.' }).input(z.strictObject({ agent: AgentImportSourceSchema })).output(AgentImportResultSchema),
    result: oc.route({ method: 'GET', path: '/api/profile/import/result', tags, summary: 'Owner only: read back a consumed import. Never runs the importer.' }).input(z.strictObject({ receipt: z.string().min(1).max(128) })).output(AgentImportResultSchema),
    apply: oc.route({ method: 'POST', path: '/api/profile/import/apply', tags, summary: 'Owner only: consume preview consent once, or reconcile its recorded outcome. Never replays an unknown import.' }).input(z.strictObject({ receipt: z.string().min(1).max(128) })).output(AgentImportResultSchema),
  },
  profiles: {
    list: oc.route({ method: 'GET', path: '/api/profiles', tags }).output(ProfilesSchema),
    active: oc.route({ method: 'GET', path: '/api/profile/active', tags }).output(ActiveProfileSchema),
    switch: oc.route({ method: 'POST', path: '/api/profile/switch', tags, summary: 'Per-client switch: sets the profile cookie; never mutates the process-wide profile.' }).input(z.object({ name: z.string().optional(), profile: z.string().optional() })).output(ProfileSwitchSchema),
    create: oc.route({ method: 'POST', path: '/api/profile/create', tags }).input(z.object({ name: z.string().optional(), clone_from: z.string().nullable().optional(), clone_config: Json.optional(), base_url: z.string().nullable().optional(), api_key: z.string().nullable().optional(), default_model: z.string().nullable().optional(), model_provider: z.string().nullable().optional() })).output(z.object({ ok: z.literal(true), profile: ProfileSchema })),
    delete: oc.route({ method: 'POST', path: '/api/profile/delete', tags }).input(z.object({ name: z.string().optional(), profile: z.string().optional() })).output(z.object({ ok: z.literal(true), name: z.string() })),
  },
  models: {
    delegation: oc.route({ method: 'POST', path: '/api/model/auxiliary/delegation', tags, summary: 'Persist a native delegation backend or replace one complete named route block.' }).input(DelegationWriteSchema).output(AuxiliaryModelsSchema),
    list: oc.route({ method: 'GET', path: '/api/models', tags }).input(z.object({ freshness: z.string().optional() })).output(ModelsSchema),
    live: oc.route({ method: 'GET', path: '/api/models/live', tags }).input(z.object({ provider: z.string().optional() })).output(ModelsLiveSchema),
    refresh: oc.route({ method: 'POST', path: '/api/models/refresh', tags, summary: "Evict the live model cache for one provider (or all when omitted) and answer the rebuilt catalog; a named provider is re-read past the Agent's own catalog cache." }).input(z.object({ provider: z.string().optional() })).output(z.object({ ok: z.literal(true), provider: z.string().nullable(), models: ModelsSchema })),
    auxiliary: oc.route({ method: 'GET', path: '/api/model/auxiliary', tags }).output(AuxiliaryModelsSchema),
    set: oc.route({ method: 'POST', path: '/api/model/set', tags, summary: 'scope=main sets config.yaml model.default; scope=auxiliary assigns one task slot (`__reset__` clears all) and answers the refreshed auxiliary state. An auxiliary `model` may be a `/api/models` entry id; provider `auto` with an empty model clears the override.' }).input(AdvancedBody.extend({ scope: z.string().optional(), task: z.string().optional(), provider: z.string().optional(), model: z.string().optional(), session_id: z.string().optional(), model_provider: z.string().nullable().optional(), explicit: z.boolean().optional() })).output(z.looseObject({ ok: z.boolean().optional(), session: Json.optional(), error: z.string().optional(), auxiliary: AuxiliaryModelsSchema.optional() })),
    setDefault: oc.route({ method: 'POST', path: '/api/default-model', tags }).input(AdvancedBody.extend({ model: z.string().optional(), provider: z.string().nullable().optional() })).output(z.object({ ok: z.literal(true), model: z.string(), provider: z.string().nullable() })),
  },
  providers: {
    list: oc.route({ method: 'GET', path: '/api/providers', tags }).output(ProvidersSchema),
    setKey: oc.route({ method: 'POST', path: '/api/providers', tags, summary: 'Write (or clear when api_key is empty) a provider API key in the profile .env.' }).input(z.object({ provider: z.string().optional(), api_key: z.string().nullable().optional() })).output(z.object({ ok: z.literal(true), provider: z.string(), display_name: z.string(), action: z.string() })),
    delete: oc.route({ method: 'POST', path: '/api/providers/delete', tags }).input(z.object({ provider: z.string().optional() })).output(z.object({ ok: z.literal(true), provider: z.string(), display_name: z.string(), action: z.string() })),
    selfHosted: oc.route({ method: 'POST', path: '/api/providers/self-hosted', tags, summary: 'Save an Ollama or LM Studio endpoint (optional key) and make `model` the default; an endpoint whose `/models` does not answer is refused with 400 and nothing is saved.' }).input(Loose).output(Loose),
    quota: oc.route({ method: 'GET', path: '/api/provider/quota', tags }).input(z.object({ provider: z.string().optional(), refresh: z.string().optional() })).output(ProviderQuotaSchema),
    quotas: oc.route({ method: 'GET', path: '/api/provider/quotas', tags }).input(z.object({ source: z.string().optional(), refresh: z.string().optional() })).output(ProviderQuotasSchema),
    costHistory: oc.route({ method: 'GET', path: '/api/provider/cost-history', tags }).input(z.object({ provider: z.string().optional(), days: z.string().optional() })).output(ProviderCostHistorySchema),
  },
  reasoning: {
    get: oc.route({ method: 'GET', path: '/api/reasoning', tags }).input(z.object({ model: z.string().optional(), provider: z.string().optional(), base_url: z.string().optional() })).output(ReasoningStatusSchema),
    set: oc.route({ method: 'POST', path: '/api/reasoning', tags, summary: 'Body is `{display: show|hide}` or `{effort, session_id?, model?, provider?, base_url?}`. Chat effort changes carry session_id; read-only/native targets return 409 reasoning_unsupported without changing profile defaults. Omit session_id only for explicit profile settings.' }).input(z.object({ display: Json.optional(), effort: Json.optional(), session_id: z.string().trim().min(1).optional(), model: z.string().nullable().optional(), provider: z.string().nullable().optional(), base_url: z.string().nullable().optional() })).output(ReasoningStatusSchema),
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
    oauthStart: oc.route({ method: 'POST', path: '/api/onboarding/oauth/start', tags, summary: "Start a device-code sign-in for a provider whose onboarding entry has `oauth_flow: 'device_code'`, or (TAL-1276, operator only) the browser sign-in of a plugin OAuth client with provider `plugin:<key>:<id>`." }).input(z.looseObject({ provider: z.string().optional() })).output(OnboardingOAuthSchema),
    oauthCancel: oc.route({ method: 'POST', path: '/api/onboarding/oauth/cancel', tags, summary: 'Cancel a pending device-code sign-in; nothing is saved after it.' }).input(z.looseObject({ flow_id: z.string().optional() })).output(OnboardingOAuthSchema),
    oauthPoll: oc.route({ method: 'GET', path: '/api/onboarding/oauth/poll', tags, summary: 'Report a device-code sign-in; `approved` means the Agent saved the credential.' }).input(z.object({ flow_id: z.string().optional() })).output(OnboardingOAuthSchema),
  },
}
