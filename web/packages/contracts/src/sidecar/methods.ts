import { z } from 'zod'
import {
  AUX_METHODS, COMMANDS_METHODS, CRON_METHODS, GATEWAY_METHODS, GOALS_METHODS, KANBAN_METHODS, MCP_METHODS, PROCESS_METHODS, PROFILES_METHODS,
  PROVIDERS_METHODS, SKILLS_METHODS, STATE_DB_METHODS, STT_METHODS, OAUTH_METHODS, TEXT_METHODS, USAGE_METHODS, WORKTREE_METHODS, CHAT_METHODS, CONFIG_METHODS,
} from './namespaces.js'
import {
  OkResultSchema, RpcCancelParamsSchema, RpcCancelResultSchema, RpcMethodsResultSchema, RuntimeDescribeSchema,
  RuntimeEnsureCurrentResultSchema, RuntimeEnvParamsSchema, RuntimeHandshakeParamsSchema, RuntimeShutdownParamsSchema,
} from './runtime.js'

const Empty = z.object({})

/**
 * Every sidecar method: params, result, and (for streamed calls) the event
 * union of its stream frames. The server client, the fake sidecar, the JSON
 * Schema export for the Python tests, and the fixture tests all read this map.
 */
export const SIDECAR_METHODS = {
  'rpc.cancel': { params: RpcCancelParamsSchema, result: RpcCancelResultSchema },
  'rpc.methods': { params: Empty, result: RpcMethodsResultSchema },
  'runtime.handshake': { params: RuntimeHandshakeParamsSchema, result: RuntimeDescribeSchema },
  'runtime.status': { params: Empty, result: RuntimeDescribeSchema },
  'runtime.ensure_current': { params: Empty, result: RuntimeEnsureCurrentResultSchema },
  'runtime.shutdown': { params: RuntimeShutdownParamsSchema, result: OkResultSchema },
  'runtime.env': { params: RuntimeEnvParamsSchema, result: OkResultSchema },
  ...GOALS_METHODS,
  ...COMMANDS_METHODS,
  ...KANBAN_METHODS,
  ...STATE_DB_METHODS,
  ...PROFILES_METHODS,
  ...SKILLS_METHODS,
  ...MCP_METHODS,
  ...STT_METHODS,
  ...CRON_METHODS,
  ...PROVIDERS_METHODS,
  ...OAUTH_METHODS,
  ...AUX_METHODS,
  ...TEXT_METHODS,
  ...PROCESS_METHODS,
  ...USAGE_METHODS,
  ...GATEWAY_METHODS,
  ...WORKTREE_METHODS,
  ...CONFIG_METHODS,
  ...CHAT_METHODS,
} as const

export type SidecarMethods = typeof SIDECAR_METHODS
export type SidecarMethodName = keyof SidecarMethods
export type SidecarParams<M extends SidecarMethodName> = z.input<SidecarMethods[M]['params']>
export type SidecarResult<M extends SidecarMethodName> = z.output<SidecarMethods[M]['result']>
/** A result before its schema applies defaults (what a fake sidecar may answer; the call parses it). */
export type SidecarResultInput<M extends SidecarMethodName> = z.input<SidecarMethods[M]['result']>
export type SidecarStreamEvent<M extends SidecarMethodName> = SidecarMethods[M] extends { stream: infer S extends z.ZodType } ? z.output<S> : never

export const SIDECAR_METHOD_NAMES = Object.keys(SIDECAR_METHODS) as SidecarMethodName[]
