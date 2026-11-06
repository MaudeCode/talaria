import { z } from 'zod'
import { MessageSchema } from './views.js'
import { GroupIdSchema, GroupMemberSchema, GroupTaskActionSchema, GroupTaskFenceSchema, GroupAttachmentSchema, NativeGroupContextSchema } from './groups-native.js'
export * from './groups-native.js'
const Id = GroupIdSchema

export const GroupRoomSchema = z.object({ id: Id, name: z.string(), identity: z.string(), revision: z.number().int(), disbanded: z.boolean(), max_upload_bytes: z.number().int().positive(), attachment_limit: z.number().int().positive(), members: z.array(GroupMemberSchema.extend({ phase: z.enum(['idle', 'queued', 'running', 'stopping', 'unknown', 'failed', 'approval']), tool: z.string().nullable(), started_at: z.number().nullable(), stalled: z.boolean(), actions: z.array(GroupTaskActionSchema),
    /** The member routing this room's messages; true for exactly one member of a lead room. */
    lead: z.boolean() })), actions: z.array(z.enum(['send', 'rename', 'disband', 'stop', 'context'])),
  /** The room's purpose, shared notes and routing; null when the gateway offers none, on catalog rows, and for a routing this contract does not know. */
  context: NativeGroupContextSchema.nullable(), purpose_limit: z.number().int().positive(), notes_limit_bytes: z.number().int().positive(),
  round: z.object({ current: z.number().int().positive(), max: z.number().int().positive() }).nullable(),
  /** The room's own Retry after the Agent stopped waking its members; null when none is offered. Send it back unchanged as a `retry` operation. */
  retry_task: GroupTaskFenceSchema.nullable() })
export const GroupRowSchema = z.object({ key: z.string(), index: z.number().int(), author: z.string(),
  /** A scheduled job's post or failure notice: `author` names the job and clients add their localized "Scheduled" label. */
  scheduled: z.boolean(), message: MessageSchema, attachments: z.array(GroupAttachmentSchema.extend({ event_id: Id, download_url: z.string() })) })
export const GroupViewSchema = z.object({ available: z.boolean(), reason: z.enum(['unsupported', 'stopped', 'refused', 'unavailable', 'unknown', 'driver_inactive']).nullable(), room: GroupRoomSchema.nullable(), rows: z.array(GroupRowSchema), cursor: z.number().int().nonnegative(), has_more: z.boolean(), next_before_seq: z.number().int().positive().nullable() })
export const GroupCatalogSchema = z.object({ identity: z.string().nullable(), available: z.boolean(), reason: GroupViewSchema.shape.reason, profiles: z.array(z.object({ profile: z.string(), label: z.string() })), rooms: z.array(GroupRoomSchema), actions: z.array(z.literal('create')), next_offset: z.number().int().nullable() })
export const GroupWriteResultSchema = z.object({ outcome: z.enum(['confirmed', 'refused', 'unknown']), reason: GroupViewSchema.shape.reason, room_id: Id, event_id: Id.nullable(), attachment: GroupAttachmentSchema.nullable() })
export type GroupView = z.infer<typeof GroupViewSchema>
export type GroupRoom = z.infer<typeof GroupRoomSchema>
export type GroupCatalog = z.infer<typeof GroupCatalogSchema>
export type GroupWriteResult = z.infer<typeof GroupWriteResultSchema>
export const GroupStreamEventSchema = z.object({ event: z.literal('snapshot'), data: GroupViewSchema })
