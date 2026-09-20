import { z } from 'zod'

/** JSON-RPC 2.0 envelopes on the sidecar stdio transport (docs/architecture/sidecar-rpc.md). */
export const RpcIdSchema = z.number().int().nonnegative()

export const RpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: RpcIdSchema,
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
})
export type RpcRequest = z.infer<typeof RpcRequestSchema>

export const RpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
})

export const RpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.object({ condition: z.string().optional() }).catchall(z.unknown()).optional(),
})
export type RpcErrorObject = z.infer<typeof RpcErrorObjectSchema>

export const RpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: RpcIdSchema.nullable(), result: z.unknown() }),
  z.object({ jsonrpc: z.literal('2.0'), id: RpcIdSchema.nullable(), error: RpcErrorObjectSchema }),
])
export type RpcResponse = z.infer<typeof RpcResponseSchema>

/** A streamed frame the sidecar emits for a long-running request. */
export const RpcStreamFrameSchema = z.object({
  id: RpcIdSchema,
  seq: z.number().int().positive(),
  event: z.string().min(1),
  data: z.unknown(),
})
export type RpcStreamFrame = z.infer<typeof RpcStreamFrameSchema>

export const RpcIncomingSchema = z.union([
  RpcResponseSchema,
  z.object({ jsonrpc: z.literal('2.0'), method: z.literal('stream'), params: RpcStreamFrameSchema }),
  RpcNotificationSchema,
])
export type RpcIncoming = z.infer<typeof RpcIncomingSchema>

/** Reserved and application error codes (sidecar/talaria_sidecar/errors.py). */
export const RPC_ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  application: -32000,
  cancelled: -32001,
} as const

/** Conditions the server forwards to HTTP clients as a 503 `condition`. */
export const SIDECAR_CONDITIONS = ['sidecar_unavailable', 'sidecar_rpc_version_mismatch', 'agent_runtime_stale', 'agent_incompatible', 'cancelled'] as const
export const SidecarConditionSchema = z.enum(SIDECAR_CONDITIONS)
export type SidecarCondition = z.infer<typeof SidecarConditionSchema>
