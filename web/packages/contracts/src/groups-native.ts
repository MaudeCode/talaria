import { z } from 'zod'
export const GROUP_ROOM_NAME_LIMIT = 200
export const GROUP_ATTACHMENT_BYTES = 15_000_000
export const GROUP_ATTACHMENT_LIMIT = 8
export const GROUP_ATTACHMENT_BASE64_LIMIT = Math.ceil(GROUP_ATTACHMENT_BYTES / 3) * 4

export const GroupIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const Id = GroupIdSchema
export const GroupAttachmentSchema = z.object({ attachment_id: Id, kind: z.enum(['image', 'pdf', 'file']), name: z.string().min(1).max(255).regex(/^[^/\\\x00\r\n]+$/), mime: z.string().max(127).regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/), size: z.number().int().positive().max(GROUP_ATTACHMENT_BYTES) })
export const GroupMemberSchema = z.object({ member_id: Id, profile: z.string().min(1).max(128), handle: Id, display_name: z.string().max(128).optional() })
const NativeMember = GroupMemberSchema.extend({ target: z.object({ kind: z.enum(['local', 'peer']), profile: z.string() }).optional() })
const Room = z.object({ room_id: Id, name: z.string().max(GROUP_ROOM_NAME_LIMIT), members: z.array(NativeMember).max(6), authority_gateway_id: z.string(), authority_epoch: z.number().int(), revision: z.number().int(), latest_seq: z.number().int().optional(), disbanded_at: z.number().optional() })
export const GroupTaskActionSchema = z.object({ kind: z.enum(['retry', 'discard', 'approval']), member_id: Id, task_id: Id, execution_generation: z.number().int().positive(), request_id: z.string().optional(), approval: z.object({ command: z.string().optional(), description: z.string().optional(), choices: z.array(z.enum(['once', 'deny'])).optional() }).optional() })
const Driver = z.object({ running: z.boolean(), working: z.boolean(), blocked: z.boolean(), pending_actions: z.array(GroupTaskActionSchema), member_activity: z.array(z.object({ member_id: Id, status: z.enum(['queued', 'running', 'stopping', 'indeterminate', 'deferred']) })).optional() })
export const NativeGroupCapabilitiesSchema = z.object({ driver: z.boolean(), authority_gateway_id: z.string(), methods: z.array(z.string()), seatable_profiles: z.array(z.string()), max_log_limit: z.number().int().positive() })
export const NativeGroupStateSchema = z.object({ room: Room, driver_status: Driver.optional() })
export const NativeGroupListSchema = z.object({ rooms: z.array(Room), next_offset: z.number().int().nullable() })
export const NativeGroupEventSchema = z.object({ room_id: Id, seq: z.number().int().positive(), event_id: Id, kind: z.string(), authority_epoch: z.number().int().nullable(), actor: z.object({ kind: z.string(), id: z.string(), profile: z.string().optional() }), payload: z.object({ text: z.string().optional(), member_id: Id.optional(), discussion_event_id: Id.optional(), task_id: Id.optional(), turn_id: Id.optional(), error: z.string().optional(), reason_code: z.string().optional(), attachments: z.array(GroupAttachmentSchema).optional() }), created_at: z.number() })
export const NativeGroupLogSchema = z.object({ events: z.array(NativeGroupEventSchema), cursor: z.number().int().nonnegative(), latest_seq: z.number().int().nonnegative(), has_more: z.boolean(), authority: z.object({ gateway_id: z.string(), epoch: z.number().int() }) })
const Task = z.object({ member_id: Id, task_id: Id, execution_generation: z.number().int().positive() })
export const GroupOperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('capabilities') }),
  z.object({ action: z.literal('list'), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().max(100).optional() }),
  z.object({ action: z.literal('create'), room_id: Id, name: z.string().trim().min(1).max(GROUP_ROOM_NAME_LIMIT), members: z.array(GroupMemberSchema).min(2).max(6) }),
  z.object({ action: z.literal('state'), room_id: Id, include_disbanded: z.boolean().optional() }),
  z.object({ action: z.literal('log'), room_id: Id, since_seq: z.number().int().nonnegative(), limit: z.number().int().positive().max(100).optional() }),
  z.object({ action: z.literal('rename'), room_id: Id, event_id: Id, name: z.string().trim().min(1).max(GROUP_ROOM_NAME_LIMIT) }),
  z.object({ action: z.literal('disband'), room_id: Id, cancel_id: Id }),
  z.object({ action: z.literal('send'), room_id: Id, event_id: Id, payload: z.object({ text: z.string().max(64 * 1024), attachments: z.array(GroupAttachmentSchema).max(GROUP_ATTACHMENT_LIMIT).optional() }) }),
  z.object({ action: z.literal('stop'), room_id: Id, cancel_id: Id }),
  Task.extend({ action: z.literal('retry'), room_id: Id }),
  Task.extend({ action: z.literal('discard'), room_id: Id }),
  Task.extend({ action: z.literal('approve'), room_id: Id, request_id: Id, choice: z.enum(['once', 'deny']) }),
  z.object({ action: z.literal('attachment.upload'), room_id: Id, upload_id: Id, kind: z.enum(['image', 'pdf', 'file']), name: z.string().min(1).max(255), mime: z.string().max(127), data_base64: z.string().max(GROUP_ATTACHMENT_BASE64_LIMIT) }),
  z.object({ action: z.literal('attachment.download'), room_id: Id, event_id: Id, attachment_id: Id }),
])
export type GroupOperation = z.infer<typeof GroupOperationSchema>
export const GroupOwnerFenceSchema = z.object({ room_id: Id, gateway_id: z.string(), authority_epoch: z.number().int() })
export const GroupSidecarParamsSchema = z.object({ profile_home: z.string().min(1), subject: z.string().min(1).max(128), operation: GroupOperationSchema, expected_room: GroupOwnerFenceSchema.optional() })
/** Private native receipts are parsed by their operation-specific schema in the server. Never an HTTP response. */
export const GroupSidecarResultSchema = z.object({ state: z.enum(['available', 'unavailable', 'refused', 'unknown']), reason: z.string().nullable(), value: z.record(z.string(), z.unknown()).nullable() })
