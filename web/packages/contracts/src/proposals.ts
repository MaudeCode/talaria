import { z } from 'zod'
import { DiffLineSchema } from './diff-line.js'

/**
 * TAL-1967: a change the agent asks the owner to make for it. The agent calls the `harness` toolset's `propose`; the
 * transcript shows the proposal's card; the owner approves or rejects it once; the server applies an approved proposal
 * through the route that owns that kind of change and tells the session. The server owns the summary, diff, field list,
 * risk notes, actions, status and outcome; clients render them.
 */
export const PROPOSAL_KINDS = ['plugin_install', 'mcp_server', 'setting', 'cron_job'] as const
export const ProposalKindSchema = z.enum(PROPOSAL_KINDS)
export type ProposalKind = z.infer<typeof ProposalKindSchema>
export const ProposalIdSchema = z.string().regex(/^pr_[0-9a-f]{8}$/)
/** `approved` is the moment between the owner's approval and the route's answer; `expired` is a pending proposal past `expires_at`. */
export const ProposalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'applied', 'failed', 'expired'])
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>

/**
 * Each kind's payload as the server stored it after validating the agent's. An `mcp_server` names the `.env` variables
 * its process reads (`env_names`), never their values; `url` and `command` are exclusive. A `cron_job`'s
 * `context_sources` are the job ids whose last output it reads.
 */
export const PluginInstallPayloadSchema = z.object({ catalog_id: z.string(), pin: z.string() })
export const McpServerPayloadSchema = z.object({ name: z.string(), url: z.string().nullable(), command: z.string().nullable(), args: z.array(z.string()), env_names: z.array(z.string()) })
export const SettingPayloadSchema = z.object({ key: z.string(), value: z.unknown() })
export const CronJobPayloadSchema = z.object({ title: z.string(), schedule: z.string(), prompt: z.string(), context_sources: z.array(z.string()) })
/** One labelled value of a plugin or cron proposal's field list. */
export const ProposalFieldSchema = z.object({ label: z.string(), value: z.string() })
/** Why the requester cannot act: `not_owner` (only the server owner approves or rejects), `closed` or `expired`. */
export const ProposalActionsSchema = z.object({ can_approve: z.boolean(), can_reject: z.boolean(), reason: z.enum(['not_owner', 'closed', 'expired']).nullable() })
/** `text` is the route's result on `applied`, `error` its refusal on `failed`; both null until the proposal is decided. */
export const ProposalOutcomeSchema = z.object({ text: z.string().nullable(), error: z.string().nullable() })

/**
 * A proposal as clients and the agent read it. `diff` holds `setting` and `mcp_server` changes as current (deletion) and
 * proposed (addition) lines; `fields` holds the `plugin_install` and `cron_job` field list. `payload_hash` binds an
 * approval to exactly what was reviewed. `expires_at` is null when the session's clarify timeout never expires.
 */
const ProposalBase = z.object({
  proposal_id: ProposalIdSchema, session_id: z.string(), profile: z.string(), summary: z.string(),
  diff: z.array(DiffLineSchema), fields: z.array(ProposalFieldSchema), risk_notes: z.array(z.string()),
  payload_hash: z.string(), actions: ProposalActionsSchema, status: ProposalStatusSchema, outcome: ProposalOutcomeSchema,
  created_at: z.number(), updated_at: z.number(), expires_at: z.number().nullable(), decided_at: z.number().nullable(),
})
export const ProposalSchema = z.discriminatedUnion('kind', [
  ProposalBase.extend({ kind: z.literal('plugin_install'), payload: PluginInstallPayloadSchema }),
  ProposalBase.extend({ kind: z.literal('mcp_server'), payload: McpServerPayloadSchema }),
  ProposalBase.extend({ kind: z.literal('setting'), payload: SettingPayloadSchema }),
  ProposalBase.extend({ kind: z.literal('cron_job'), payload: CronJobPayloadSchema }),
])
export type Proposal = z.infer<typeof ProposalSchema>

/** `POST /api/proposals/{proposal_id}/approve`: the `payload_hash` the owner reviewed. */
export const ProposalApproveInputSchema = z.object({ proposal_id: z.string(), payload_hash: z.string() })

/** The transcript card's reference from a `propose` result, set by the server; the card loads the proposal and follows `proposal` events. */
export const ProposalRefSchema = z.object({ proposal_id: ProposalIdSchema, kind: ProposalKindSchema, summary: z.string() })
export type ProposalRef = z.infer<typeof ProposalRefSchema>
/** The `proposal` session stream event, after each change of the session's proposal. */
export const ProposalEventSchema = z.object({ session_id: z.string(), proposal_id: ProposalIdSchema, status: ProposalStatusSchema })
