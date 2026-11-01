import { z } from 'zod'

/**
 * Sidecar-to-server requests (TAL-1164): the sidecar asks the server on the same stdio pipe, in the `server.*`
 * namespace, with `s:`-prefixed string ids that never collide with the server's integer request ids. The server
 * answers on the sidecar's stdin with the usual JSON-RPC result or error envelope.
 */
export const SidecarRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string().regex(/^s:\d+$/),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
})
export type SidecarRequest = z.infer<typeof SidecarRequestSchema>

/** The sidebar attention summary the server computes for every `/api/sessions` row: approvals outrank questions. */
export const SessionAttentionSchema = z.object({
  kind: z.enum(['approval', 'clarify']),
  count: z.number().int().positive(),
  severity: z.enum(['critical', 'question']),
})

/** `caller_session_id` is the Web session whose agent called the tool; the server resolves its profile and scopes to it. */
export const ServerSessionListParamsSchema = z.object({
  caller_session_id: z.string().min(1),
  query: z.string().nullable().optional(),
})

export const AGENT_SESSION_LIST_LIMIT = 50

export const ServerSessionListResultSchema = z.object({
  sessions: z.array(z.object({
    session_id: z.string(),
    title: z.string(),
    /** Seconds since the epoch of the row's latest activity, the order the list is in (newest first). */
    updated_at: z.number(),
    is_caller: z.boolean(),
    is_streaming: z.boolean(),
    pending_steer_count: z.number().int().nonnegative(),
    attention: SessionAttentionSchema.nullable(),
  })).max(AGENT_SESSION_LIST_LIMIT),
  /** More sessions matched than the list carries. */
  truncated: z.boolean(),
})

/** Every method the server answers for the sidecar; anything else is METHOD_NOT_FOUND. */
export const SIDECAR_SERVER_METHODS = {
  'server.session_list': { params: ServerSessionListParamsSchema, result: ServerSessionListResultSchema },
} as const

export type SidecarServerMethods = typeof SIDECAR_SERVER_METHODS
export type SidecarServerMethodName = keyof SidecarServerMethods
export type SidecarServerParams<M extends SidecarServerMethodName> = z.output<SidecarServerMethods[M]['params']>
export type SidecarServerResultInput<M extends SidecarServerMethodName> = z.input<SidecarServerMethods[M]['result']>
