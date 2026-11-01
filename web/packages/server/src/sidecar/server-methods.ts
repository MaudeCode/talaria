/**
 * Requests the sidecar sends the server (TAL-1164): the `server.*` allowlist, answered in-process by the same service
 * functions the HTTP routes call. Nothing outside `SIDECAR_SERVER_METHODS` with a registered handler is dispatched.
 */
import {
  RPC_ERROR_CODES, SIDECAR_SERVER_METHODS, SidecarRequestSchema,
  type RpcErrorObject, type SidecarServerMethodName, type SidecarServerParams, type SidecarServerResultInput,
} from '@maudecode/talaria-web-contracts'

export type SidecarServerHandlers = { [M in SidecarServerMethodName]?: (params: SidecarServerParams<M>) => Promise<SidecarServerResultInput<M>> }

/** A refusal the sidecar's tool reports as its error; `condition` names it for the agent. */
export class SidecarServerError extends Error {
  constructor(message: string, readonly condition: string) {
    super(message)
    this.name = 'SidecarServerError'
  }
}

export type SidecarReply = { jsonrpc: '2.0'; id: string; result: unknown } | { jsonrpc: '2.0'; id: string; error: RpcErrorObject }

/** The reply to one parsed sidecar line, or null when the line is not a sidecar request (then it is the caller's). */
export async function answerSidecarRequest(handlers: SidecarServerHandlers, message: unknown): Promise<SidecarReply | null> {
  const request = SidecarRequestSchema.safeParse(message)
  if (!request.success) return null
  const { id, method, params } = request.data
  const error = (code: number, text: string, condition: string): SidecarReply => ({ jsonrpc: '2.0', id, error: { code, message: text, data: { condition } } })
  const definition = Object.hasOwn(SIDECAR_SERVER_METHODS, method) ? SIDECAR_SERVER_METHODS[method as SidecarServerMethodName] : undefined
  const handler = definition ? handlers[method as SidecarServerMethodName] : undefined
  if (!definition || !handler) return error(RPC_ERROR_CODES.methodNotFound, `unknown method ${method}`, 'method_not_found')
  const parsed = definition.params.safeParse(params)
  if (!parsed.success) return error(RPC_ERROR_CODES.invalidParams, parsed.error.message, 'invalid_params')
  try {
    return { jsonrpc: '2.0', id, result: definition.result.parse(await (handler as (p: unknown) => Promise<unknown>)(parsed.data)) }
  } catch (caught) {
    if (caught instanceof SidecarServerError) return error(RPC_ERROR_CODES.application, caught.message, caught.condition)
    return error(RPC_ERROR_CODES.internal, `${method} failed: ${(caught as Error).message}`, 'server_error')
  }
}
