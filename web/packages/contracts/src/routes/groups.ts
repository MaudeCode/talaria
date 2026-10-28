import { oc } from '@orpc/contract'
import { z } from 'zod'
import { GROUP_ATTACHMENT_BASE64_LIMIT, GroupCatalogSchema, GroupIdSchema, GroupOperationSchema, GroupViewSchema, GroupWriteResultSchema } from '../groups.js'

export const GroupWriteInputSchema = z.object({ identity: z.string().nullable(), operation: GroupOperationSchema })
export const groupsContract = { groups: {
  sendIdentity: oc.route({ method: 'GET', path: '/api/groups/send-identity', tags: ['groups'] }).input(z.object({ request_id: GroupIdSchema })).output(z.object({ event_id: GroupIdSchema })),
  list: oc.route({ method: 'GET', path: '/api/groups', tags: ['groups'] }).input(z.object({ offset: z.coerce.number().int().nonnegative().optional() })).output(GroupCatalogSchema),
  view: oc.route({ method: 'GET', path: '/api/groups/view', tags: ['groups'] }).input(z.object({ room_id: GroupIdSchema, before_seq: z.coerce.number().int().positive().optional() })).output(GroupViewSchema),
  receipt: oc.route({ method: 'GET', path: '/api/groups/receipt', tags: ['groups'] }).input(z.object({ room_id: GroupIdSchema, request_id: GroupIdSchema })).output(GroupWriteResultSchema),
  write: oc.route({ method: 'POST', path: '/api/groups/action', tags: ['groups'] }).input(GroupWriteInputSchema).output(GroupWriteResultSchema),
  upload: oc.route({ method: 'POST', path: '/api/groups/upload', tags: ['groups'] }).input(z.object({ room_id: GroupIdSchema, identity: z.string(), upload_id: GroupIdSchema, name: z.string().min(1).max(255), mime: z.string().max(127), data_base64: z.string().max(GROUP_ATTACHMENT_BASE64_LIMIT) })).output(GroupWriteResultSchema),
} }
