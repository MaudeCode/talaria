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

/** A held writer lease spans compatibility inspection, source mutation, repair, and durable resume. */
export const RuntimeAgentMutationParamsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('begin'), agent_dir: z.string().min(1), revision: z.string().regex(/^[a-f0-9]{40}$/), homes: z.array(z.string().min(1)).min(1) }),
  z.object({ action: z.literal('git'), agent_dir: z.string().min(1), token: z.string().regex(/^[a-f0-9]{32}$/), args: z.array(z.string().max(65536)).min(1).max(1000), timeout_ms: z.number().int().min(100).max(300000) }),
  z.object({ action: z.enum(['sync', 'finish']), agent_dir: z.string().min(1), token: z.string().regex(/^[a-f0-9]{32}$/) }),
])
export const RuntimeAgentMutationResultSchema = RuntimeSyncDependenciesResultSchema.extend({ token: z.string().regex(/^[a-f0-9]{32}$/).optional() })
