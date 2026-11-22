import { z } from 'zod'

/**
 * TAL-2380: the sidecar's proxy for the profile owner's `display.*` (the Agent's Bot Screen). Server-only, in its own module
 * so browser bundles never carry it. Every call reaches the owner already running for `profile_home`; none starts one.
 */
const ProfileHome = z.object({ profile_home: z.string().min(1) })
/** The lease as the owner shows it: `viewer_hash` lets a viewer recognise itself; the viewer id itself never leaves the sidecar. */
export const DisplayLeaseSchema = z.object({ holder: z.enum(['agent', 'human']), viewer_hash: z.string().nullable() })
export const DisplayStatusSchema = z.object({
  supported: z.boolean(), installed: z.boolean(), running: z.boolean(), install_command: z.string().nullable(), lease: DisplayLeaseSchema,
})
/**
 * `ready` carries the owner's `display.status`. `unavailable`: no owner runs or it cannot be reached (`reason` names why),
 * or it has no `display.*` (`display_unsupported`, a JSON-RPC -32601 from an older owner).
 */
export const DisplayStatusResultSchema = z.object({ state: z.enum(['ready', 'unavailable']), reason: z.string().nullable(), status: DisplayStatusSchema.nullable() })
export const DisplayLeaseResultSchema = z.object({ lease: DisplayLeaseSchema })
const ViewId = z.object({ view_id: z.string().min(1) })

export const DISPLAY_METHODS = {
  'display.status': { params: ProfileHome, result: DisplayStatusResultSchema },
  /**
   * One viewer: holds an owner connection, mints its single-use display ticket and emits `ready` with `rfb_url` (the
   * owner's display socket with that ticket, for the server alone), the sidecar's `view_id` that the lease calls name and
   * the viewer's `viewer_hash`. Runs until cancelled, then hands back control the viewer still holds.
   */
  'display.view': {
    params: ProfileHome, result: z.object({ ended: z.literal(true) }),
    stream: z.discriminatedUnion('event', [z.object({ event: z.literal('ready'), data: z.object({ rfb_url: z.string(), view_id: z.string(), viewer_hash: z.string() }) })]),
  },
  /** Take over: the open view's viewer controls the screen. */
  'display.lease.acquire': { params: ViewId, result: DisplayLeaseResultSchema },
  /** Hand back to the agent, when the open view's viewer holds control. */
  'display.lease.release': { params: ViewId, result: DisplayLeaseResultSchema },
} as const
