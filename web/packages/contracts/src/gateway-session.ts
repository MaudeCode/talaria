import { z } from 'zod'

const ObjectSchema = z.record(z.string(), z.unknown())
export const GatewayAdmissionSchema = z.object({
  admission_id: z.string(), sequence: z.number().int(), status: z.enum(['queued', 'started', 'unknown', 'terminal']),
  outcome: z.string().nullable(), authority_epoch: z.number().int(), execution_generation: z.number().int().nullable(),
  controls: z.array(z.string()).optional(), steering: z.boolean().optional(),
  text: z.string().optional(), input_id: z.string().optional(),
})
export const GatewaySnapshotSchema = z.object({
  session_id: z.string(), stored_session_id: z.string(), messages: z.array(ObjectSchema), message_count: z.number().int(),
  running: z.boolean(), authority_epoch: z.number().int(), replay_epoch: z.string(), last_sequence: z.number().int(),
  subscription_id: z.string(), revision: z.number().int(), execution_generation: z.number().int(),
  pending: z.array(GatewayAdmissionSchema), prompts: z.array(ObjectSchema), info: ObjectSchema,
})
export const GatewaySessionResultSchema = z.object({
  state: z.enum(['attached', 'stopped', 'unavailable', 'incompatible', 'refused']), reason: z.string().nullable(),
  replay_gap: z.boolean().optional(), snapshot: GatewaySnapshotSchema.nullable(), receipt: GatewayAdmissionSchema.nullable(),
})
export const GatewaySessionParamsSchema = z.object({
  profile_home: z.string().min(1), session_id: z.string().min(1),
  action: z.enum(['snapshot', 'watch', 'submit', 'receipt', 'cancel', 'steer_queued', 'replace_queued', 'interrupt', 'approval', 'clarify', 'discard', 'mutate']),
  request_id: z.string().min(1).max(128).optional(), text: z.string().optional(),
  submission_id: z.string().min(1).max(128).optional(),
  show_reasoning: z.boolean().optional().describe('The profile display preference negotiated for an owner watch.'),
  admission_id: z.string().optional(), execution_generation: z.number().int().nonnegative().optional(),
  prompt_id: z.string().optional(), choice: z.enum(['once', 'session', 'always', 'deny']).optional(),
  expected_revision: z.number().int().nonnegative().optional(),
  operation: z.enum(['rename', 'archive', 'sidebar', 'branch', 'delete', 'rewind', 'reset', 'model', 'workspace', 'compress']).optional(),
  payload: ObjectSchema.optional(),
})
/**
 * TAL-1040: how a fresh chat's Agent runs, frozen at creation. `ignore_config` runs explicit settings without the profile's
 * config.yaml/.env; `safe` also leaves out plugins, MCP, hooks, rules, soul, skills and memory. Troubleshooting isolation,
 * not a security sandbox.
 */
export const ExecutionModeSchema = z.enum(['normal', 'ignore_config', 'safe'])
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>
/** `probe` asks whether the owner can create diagnostic sessions and creates nothing. Never carries a credential. */
export const GatewayCreateParamsSchema = z.object({
  profile_home: z.string().min(1), probe: z.boolean().optional(),
  request_id: z.string().min(1).max(128).optional(), execution_mode: ExecutionModeSchema.exclude(['normal']).optional(),
  cwd: z.string().min(1).optional(), model: z.string().min(1).optional(), provider: z.string().min(1).optional(), base_url: z.string().min(1).optional(),
  toolsets: z.array(z.string().min(1)).optional(),
})
export type GatewayCreateParams = z.infer<typeof GatewayCreateParamsSchema>
/** Why the server cannot start a fresh chat in a mode; clients word each code. */
export const ExecutionModeUnavailableSchema = z.enum(['agent_unsupported', 'served_profile', 'gateway_stopped', 'gateway_unavailable'])
export const ExecutionModesSchema = z.object({
  modes: z.array(z.object({ mode: ExecutionModeSchema, available: z.boolean(), reason: ExecutionModeUnavailableSchema.nullable(),
    can_attach: z.boolean().describe('A fresh chat in this mode accepts file attachments.') })),
})
export type ExecutionModes = z.infer<typeof ExecutionModesSchema>
const OwnerActionBase = z.object({ session_id: z.string().min(1) })
const RecoveryAction = OwnerActionBase.extend({ admission_id: z.string().min(1), execution_generation: z.number().int().positive() })
export const OwnerActionRequestSchema = z.discriminatedUnion('action', [
  OwnerActionBase.extend({ action: z.literal('cancel'), admission_id: z.string().min(1) }),
  OwnerActionBase.extend({ action: z.literal('steer_queued'), admission_id: z.string().min(1) }),
  OwnerActionBase.extend({ action: z.literal('replace_queued'), admission_id: z.string().min(1),
    submission_id: z.string().min(1).max(128), text: z.string().trim().min(1) }),
  RecoveryAction.extend({ action: z.literal('discard') }),
  RecoveryAction.extend({ action: z.literal('retry') }),
  OwnerActionBase.extend({ action: z.literal('mutate'), request_id: GatewaySessionParamsSchema.shape.request_id.unwrap(),
    expected_revision: z.number().int().nonnegative(), execution_generation: z.number().int().nonnegative(),
    operation: z.enum(['rename', 'rewind', 'reset', 'model', 'workspace', 'compress']), payload: ObjectSchema }),
])
export type OwnerActionRequest = z.infer<typeof OwnerActionRequestSchema>
/** The server decides every action. Native paths, principal bindings and transport tickets stay private. */
export const OwnerAttachmentSchema = z.object({
  state: GatewaySessionResultSchema.shape.state, reason: z.string().nullable(),
  can_submit: z.boolean(), can_interrupt: z.boolean(), can_attach: z.boolean(),
  revision: z.number().int().nullable(), execution_generation: z.number().int().nullable(),
  active_admission: GatewayAdmissionSchema.nullable().optional(),
  admissions: z.array(GatewayAdmissionSchema.extend({ actions: z.array(z.enum(['cancel', 'steer', 'edit', 'retry', 'discard'])) })),
})
export type OwnerAttachment = z.infer<typeof OwnerAttachmentSchema>
export type GatewaySnapshot = z.infer<typeof GatewaySnapshotSchema>
export type GatewaySessionResult = z.infer<typeof GatewaySessionResultSchema>
export type GatewaySessionParams = z.infer<typeof GatewaySessionParamsSchema>
