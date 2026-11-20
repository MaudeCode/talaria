import { z } from 'zod'
import { MessageSchema } from './views.js'
import { GroupIdSchema, GroupMemberSchema, GroupTaskActionSchema, GroupTaskFenceSchema, GroupAttachmentSchema, NativeGroupContextSchema } from './groups-native.js'
export * from './groups-native.js'
const Id = GroupIdSchema

export const GroupRoomSchema = z.object({ id: Id, name: z.string(), identity: z.string(), revision: z.number().int(), disbanded: z.boolean(), max_upload_bytes: z.number().int().positive(), attachment_limit: z.number().int().positive(), members: z.array(GroupMemberSchema.extend({ phase: z.enum(['idle', 'queued', 'running', 'stopping', 'unknown', 'failed', 'approval']), tool: z.string().nullable(), started_at: z.number().nullable(), stalled: z.boolean(), actions: z.array(GroupTaskActionSchema),
    /** The member routing this room's messages; true for exactly one member of a lead room. */
    lead: z.boolean(),
    /**
     * A seat served by another computer's gateway; null for a profile on this one. `computer_label` names that computer when the
     * room carries its name, else null and clients word it generically. `reachability` is the home gateway's route state: `offline`
     * when it has no usable route; null on catalog rows, which carry no driver status.
     */
    remote: z.object({ computer_label: z.string().nullable(), reachability: z.enum(['ready', 'offline', 'needs_reauthorization']).nullable() }).nullable() })), actions: z.array(z.enum(['send', 'rename', 'disband', 'stop', 'context'])),
  /** Selectable modes from the driver; everyone and lead on gateways predating routing_modes. */
  routing_modes: z.array(NativeGroupContextSchema.shape.routing),
  /** The room's purpose, shared notes and routing; null when the gateway offers none, on catalog rows, and for a routing this contract does not know. */
  context: NativeGroupContextSchema.nullable(), purpose_limit: z.number().int().positive(), notes_limit_bytes: z.number().int().positive(),
  round: z.object({ current: z.number().int().positive(), max: z.number().int().positive() }).nullable(),
  /** The room's own Retry after the Agent stopped waking its members; null when none is offered. Send it back unchanged as a `retry` operation. */
  retry_task: GroupTaskFenceSchema.nullable() })
export const GroupRowSchema = z.object({ key: z.string(), index: z.number().int(), author: z.string(),
  /** Native discussion identity, sent back unchanged when replying; null for notices and unthreaded messages. */
  thread_id: z.string().nullable(),
  /** A scheduled job's post or failure notice: `author` names the job and clients add their localized "Scheduled" label. */
  scheduled: z.boolean(), message: MessageSchema, attachments: z.array(GroupAttachmentSchema.extend({ event_id: Id, download_url: z.string() })) })
/**
 * One discussion stopped at its cap and waiting. `event_id` is the row carrying its notice, when that row is on this page.
 * `continue_state`: `offered` when clients show Continue, `stop_pending` when they show it disabled, `none` when they show
 * no control (a gateway without Continue, an inactive room, or `continues_left` spent). `excerpt` names the discussion by
 * its opening message when several are paused, so their Continues can be told apart; clients then show it instead of the
 * cap. Send `discussion_event_id` back unchanged as a `continue` operation.
 */
export const GroupPausedSchema = z.object({ discussion_event_id: Id, event_id: Id, cap: z.enum(['max_rounds', 'max_messages']), continues_left: z.number().int().nonnegative(), continue_state: z.enum(['offered', 'stop_pending', 'none']), excerpt: z.string().nullable() })
export const GroupViewSchema = z.object({ available: z.boolean(), reason: z.enum(['unsupported', 'stopped', 'refused', 'unavailable', 'unknown', 'driver_inactive']).nullable(), room: GroupRoomSchema.nullable(), rows: z.array(GroupRowSchema),
  /** Every paused discussion in the room, oldest first, whichever history page `rows` holds. */
  paused: z.array(GroupPausedSchema), cursor: z.number().int().nonnegative(), has_more: z.boolean(), next_before_seq: z.number().int().positive().nullable() })
export const GroupCatalogSchema = z.object({ identity: z.string().nullable(), available: z.boolean(), reason: GroupViewSchema.shape.reason, profiles: z.array(z.object({ profile: z.string(), label: z.string() })), rooms: z.array(GroupRoomSchema), actions: z.array(z.literal('create')), next_offset: z.number().int().nullable() })
export const GroupWriteResultSchema = z.object({ outcome: z.enum(['confirmed', 'refused', 'unknown']), reason: GroupViewSchema.shape.reason,
  /** Why the Agent refused, when it named a reason clients word: `stop_pending` (Disband waits until Stop finishes), `member_home_unknown` (a member's profile is no longer configured, so its Stop cannot be confirmed), `disbanding_retry` (already disbanding; Disband again). Null otherwise. */
  refusal: z.enum(['stop_pending', 'member_home_unknown', 'disbanding_retry']).nullable(),
  room_id: Id, event_id: Id.nullable(), attachment: GroupAttachmentSchema.nullable() })
export type GroupView = z.infer<typeof GroupViewSchema>
export type GroupRoom = z.infer<typeof GroupRoomSchema>
export type GroupPaused = z.infer<typeof GroupPausedSchema>
export type GroupCatalog = z.infer<typeof GroupCatalogSchema>
export type GroupWriteResult = z.infer<typeof GroupWriteResultSchema>
export const GroupStreamEventSchema = z.object({ event: z.literal('snapshot'), data: GroupViewSchema })
