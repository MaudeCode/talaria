import { z } from 'zod'
import {
  OkResultSchema, RpcCancelParamsSchema, RpcCancelResultSchema, RpcMethodsResultSchema, RuntimeDescribeSchema,
  RuntimeEnsureCurrentResultSchema, RuntimeHandshakeParamsSchema, RuntimeShutdownParamsSchema,
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
} as const

export type SidecarMethods = typeof SIDECAR_METHODS
export type SidecarMethodName = keyof SidecarMethods
export type SidecarParams<M extends SidecarMethodName> = z.input<SidecarMethods[M]['params']>
export type SidecarResult<M extends SidecarMethodName> = z.output<SidecarMethods[M]['result']>
export type SidecarStreamEvent<M extends SidecarMethodName> = SidecarMethods[M] extends { stream: infer S extends z.ZodType } ? z.output<S> : never

export const SIDECAR_METHOD_NAMES = Object.keys(SIDECAR_METHODS) as SidecarMethodName[]
