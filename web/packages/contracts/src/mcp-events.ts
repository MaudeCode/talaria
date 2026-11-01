import { z } from 'zod'

const Count = z.number().int().nonnegative()
/**
 * TAL-1510: the Agent's durable event-subscription records for one MCP server, counted by state. `active` holds a grant
 * whose refresh is not yet due; `refresh_overdue` passed its refresh time without a new grant (the refresh is failing,
 * or no process holds the connection); `lapsed` passed its grant's expiry; `pending` has no grant on record; `paused`
 * was turned off in the Agent's webhook dashboard. No route names, secrets, grants or cursors leave the sidecar.
 */
export const McpEventSubscriptionsSchema = z.object({ active: Count, refresh_overdue: Count, lapsed: Count, pending: Count, paused: Count })

/** Sidecar `mcp.events`: native event support, the webhook callback prerequisite, and per-server utilities and subscriptions. */
export const McpEventsDataSchema = z.object({
  supported: z.boolean().describe('The installed Agent ships MCP events (`tools.mcp_tool_events`).'),
  callback: z.enum(['ready', 'missing', 'not_https']).describe('`platforms.webhook.extra.public_url`: an https origin, absent, or set but not https.'),
  servers: z.array(z.object({ name: z.string(), utilities: Count, subscriptions: McpEventSubscriptionsSchema })),
})

/**
 * Server-derived event state, in precedence order once opted in: `needs_public_url` / `invalid_public_url` (the callback
 * prerequisite), `lapsed`, `refresh_overdue`, `subscribed`, then `ready` (connected, nothing subscribed) or `unavailable`
 * (not connected in this runtime: idle, lazy, connecting or failed). `off` is not opted in, `unsupported` an Agent
 * without MCP events, `error` an unreadable native state.
 */
export const McpEventsStateSchema = z.enum(['unsupported', 'off', 'needs_public_url', 'invalid_public_url', 'unavailable', 'ready', 'subscribed', 'refresh_overdue', 'lapsed', 'error'])

/** TAL-1510: one MCP server's experimental events opt-in and native subscription health. */
export const McpEventsSchema = z.object({
  supported: z.boolean(),
  enabled: z.boolean().describe('Configured opt-in (`mcp_servers.<name>.events`). It never implies a live subscription.'),
  can_edit: z.boolean().describe('PUT `{events}` may change the opt-in: a config.yaml server on an Agent with events, or an opted-in one to turn off.'),
  state: McpEventsStateSchema,
  detail: z.string().describe('Redacted native reason for `unavailable` or `error`; empty otherwise.'),
  utilities: Count.describe('Event utility tools (`list_event_types`, `subscribe_event`, `unsubscribe_event`) this runtime registered.'),
  subscriptions: McpEventSubscriptionsSchema,
})
