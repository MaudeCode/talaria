import { z } from 'zod'

export const RuntimeHandshakeParamsSchema = z.object({
  rpc_version: z.number().int().positive(),
})

/** What the sidecar reports about itself and the loaded Agent. */
export const RuntimeDescribeSchema = z.object({
  rpc_version: z.number().int().positive(),
  python: z.string(),
  python_version: z.string(),
  agent_dir: z.string().nullable(),
  agent_revision: z.string().nullable(),
  agent_version: z.string().nullable(),
  pinned_revision: z.string().regex(/^[a-f0-9]{40}$/),
  pinned_version: z.string(),
  pinned_image: z.string(),
  // Agent imports succeeded; this is not an exact match with the officially tested pin.
  compatible: z.boolean(),
  stale: z.boolean(),
  agent_source_changed: z.boolean().optional(),
  update_state: z.enum(['absent', 'active', 'stale', 'unknown', 'incomplete', 'unverified']),
  import_error: z.string().nullable(),
})
export type RuntimeDescribe = z.infer<typeof RuntimeDescribeSchema>

export const RuntimeEnsureCurrentResultSchema = z.object({ current: z.literal(true), agent_revision: z.string().nullable() })
export const RuntimeShutdownParamsSchema = z.object({ exit_code: z.number().int().optional() })
/** Mutate the sidecar's own process environment (Web-owned `.env` values it inherited at spawn); never Agent state. */
export const RuntimeEnvParamsSchema = z.object({ set: z.record(z.string(), z.string()).optional(), unset: z.array(z.string()).optional() })
export const OkResultSchema = z.object({ ok: z.literal(true) })
export const RpcCancelParamsSchema = z.object({ id: z.number().int() })
export const RpcCancelResultSchema = z.object({ cancelled: z.boolean(), reason: z.string().optional() })
export const RpcMethodsResultSchema = z.object({ methods: z.array(z.string()) })

/** Explicit update repair, bound to the sidecar's configured checkout, without importing updated Agent code. */
export const RuntimeSyncDependenciesParamsSchema = z.object({ agent_dir: z.string().min(1) })
export const RuntimeSyncDependenciesResultSchema = z.object({ ok: z.boolean(), skipped: z.boolean(), detail: z.string() })

/** Continue retained work only; never resolve a release or accept interruption consent. */
export const RuntimeAgentRecoveryParamsSchema = z.object({ probe: z.boolean().optional(), complete_revision: z.string().regex(/^[a-f0-9]{40}$/).optional() })
export const RuntimeAgentRecoveryResultSchema = z.object({
  ok: z.boolean(), owed: z.boolean(), fingerprint: z.string(), detail: z.string(),
  local_restore: z.boolean().optional(), revision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  runtime_pending: z.boolean().optional(),
  /** An acknowledged native gateway drain is still within its native budget: progress, not a failed attempt. */
  draining: z.boolean().optional(),
})

/** A single-use interruption consent; the sidecar binds it to the operator intent and attested services. */
export const AgentRefreshConfirmationSchema = z.object({ token: z.string().regex(/^[a-f0-9]{32}$/), services: z.array(z.string().min(1)).min(1) })

/** A held writer lease spans compatibility inspection, source mutation, repair, and durable resume. */
export const RuntimeAgentMutationParamsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('begin'), agent_dir: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{40}$/), homes: z.array(z.string().min(1)).min(1), intent: z.string().min(1).max(1024).optional(), refresh_token: z.string().regex(/^[a-f0-9]{32}$/).optional() }),
  z.object({ action: z.literal('git'), agent_dir: z.string().min(1), token: z.string().regex(/^[a-f0-9]{32}$/), args: z.array(z.string().max(65536)).min(1).max(1000), timeout_ms: z.number().int().min(100).max(300000) }),
  z.object({ action: z.enum(['sync', 'finish']), agent_dir: z.string().min(1), token: z.string().regex(/^[a-f0-9]{32}$/) }),
])
export const RuntimeAgentMutationResultSchema = RuntimeSyncDependenciesResultSchema.extend({ token: z.string().regex(/^[a-f0-9]{32}$/).optional(), refresh_confirmation: AgentRefreshConfirmationSchema.optional() })
/**
 * TAL-1429: `begin` reports the shared native gateway drain it waits for. `deadline_seconds` is the worker's
 * bounded drain budget from this frame; the caller keeps custody until it passes plus the ordinary lease margin.
 */
export const RuntimeAgentMutationStreamSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('progress'), data: z.object({ phase: z.literal('gateway_drain'), deadline_seconds: z.number().min(0), services: z.array(z.string()) }) }),
])
