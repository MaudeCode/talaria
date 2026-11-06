import { z } from 'zod'

/**
 * TAL-1907: what an MCP target will run (`stdio`) or contact (`remote`), as the Agent worded it for consent. `target` is the
 * Agent's scrubbed line, never cut or masked further, so it reads back as the exact argv. `env` holds names only.
 */
export const ConnectorLaunchSchema = z.object({ kind: z.enum(['stdio', 'remote']), target: z.string(), env: z.array(z.string()), cwd: z.string().nullable() })
/** A connection operation's target (`tools/connectors/operation.py`): a hosted app account, or an MCP server the card approves. `launch` is absent on an older Agent. */
export const ConnectorOperationTargetSchema = z.object({
  name: z.string(), kind: z.string(), state: z.enum(['pending', 'initiated', 'connected', 'skipped', 'failed', 'expired', 'not_connected']), detail: z.string(),
  connect_url: z.string().nullable().optional(),
  required_env: z.array(z.object({ name: z.string(), prompt: z.string(), required: z.boolean(), secret: z.boolean() })),
  launch: ConnectorLaunchSchema.optional(),
})
/** `owner`: `account` for the Connectors page's connect, `session` for a chat card, which `tool_call_id` opened. `seq`: the operation's write counter on a canonical owner. */
export const ConnectorOperationSnapshotSchema = z.object({ op_id: z.string(), seq: z.number().int().optional(), settled: z.boolean(), owner: z.enum(['account', 'session']), tool_call_id: z.string().nullable(), targets: z.array(ConnectorOperationTargetSchema) })
export type ConnectorOperationSnapshot = z.infer<typeof ConnectorOperationSnapshotSchema>
/**
 * TAL-818: a connection operation, from the Connectors page's Connect or a chat's `manage_connections` card. Each target's
 * `connect_url` is the authorization link while it waits on one; `actions` are the moves the user may make on it now, and
 * `env_fields` the credentials an `approve` sends, each with its `label`. `launch` is what an MCP target will run or contact
 * while it is unresolved in an open operation, null otherwise or when the Agent sends none. `can_continue`: the card may end the wait for the
 * rest (chat only). `outcome` is null while the operation is open, then `connected` when every target connected.
 * TAL-1317: `owner` names the canonical owner that holds the operation; a client echoes it on every read and move of that
 * operation, which then never reach the sidecar's own registry. `can_wake`: the client may ask that owner to look again
 * when the user returns from an authorization link. Both are absent on a direct operation.
 */
export const ConnectorOperationViewSchema = z.object({
  op_id: z.string(), settled: z.boolean(), outcome: z.enum(['connected', 'not_connected']).nullable(), can_continue: z.boolean(), tool_call_id: z.string().nullable(),
  owner: z.object({ session_id: z.string(), authority_epoch: z.number().int().nonnegative() }).optional(), can_wake: z.boolean().optional(),
  targets: z.array(z.object({
    name: z.string(), title: z.string(), kind: z.string(), state: ConnectorOperationTargetSchema.shape.state,
    detail: z.string(), connect_url: z.string().nullable(), launch: ConnectorLaunchSchema.nullable(), actions: z.array(z.enum(['skip', 'retry', 'approve'])),
    env_fields: z.array(z.object({ name: z.string(), label: z.string(), required: z.boolean(), secret: z.boolean() })),
  })),
})
export type ConnectorOperationView = z.infer<typeof ConnectorOperationViewSchema>
