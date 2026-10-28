import { implement } from '@orpc/server'
import { groupsContract, GroupIdSchema } from '@maudecode/talaria-web-contracts'
import type { RequestContext } from '../http/context.js'
import { activeProfileName } from '../auth/gate.js'
import { HttpError, type ApiContext } from './router.js'
import { HttpFailure } from '../sessions/service.js'
import { claimOrReject } from './sse-routes.js'
import { nextItem } from '../sessions/streams.js'
import { contentDispositionValue, INLINE_IMAGE_TYPES } from '../workspace/media.js'

const os = implement(groupsContract).$context<ApiContext>()
export const groupScope = (ctx: RequestContext) => ctx.deps.groups.scope(activeProfileName(ctx), ctx.notificationOwner ?? 'local-owner')
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() }
  catch (error) {
    if (error instanceof HttpFailure) throw new HttpError(error.status, error.message, error.extra)
    throw new HttpError(503, 'Discussion unavailable')
  }
}
export const groupsRouter = os.router({ groups: {
  sendIdentity: os.groups.sendIdentity.handler(({ input, context: { ctx } }) => ctx.deps.groups.sendIdentity(input.request_id)),
  list: os.groups.list.handler(({ input, context: { ctx } }) => run(() => ctx.deps.groups.catalog(groupScope(ctx), input.offset))),
  view: os.groups.view.handler(({ input, context: { ctx } }) => run(() => ctx.deps.groups.view(groupScope(ctx), input.room_id, input.before_seq))),
  receipt: os.groups.receipt.handler(({ input, context: { ctx } }) => run(() => ctx.deps.groups.receipt(groupScope(ctx), input.room_id, input.request_id))),
  write: os.groups.write.handler(({ input, context: { ctx } }) => run(() => ctx.deps.groups.write(groupScope(ctx), input.identity, input.operation))),
  upload: os.groups.upload.handler(({ input, context: { ctx } }) => run(() => {
    const { identity, ...fields } = input
    const kind = input.mime.startsWith('image/') ? 'image' : input.mime === 'application/pdf' ? 'pdf' : 'file'
    return ctx.deps.groups.write(groupScope(ctx), identity, { action: 'attachment.upload', ...fields, kind })
  })),
} })

export async function handleGroupStream(ctx: RequestContext): Promise<void> {
  const roomId = GroupIdSchema.safeParse(ctx.query.get('room_id'))
  if (!roomId.success) { await ctx.json({ error: 'Invalid discussion' }, { status: 400 }); return }
  const scope = groupScope(ctx)
  const initial = await ctx.deps.groups.view(scope, roomId.data).catch(async (error: unknown) => {
    await ctx.json({ error: 'Discussion unavailable' }, { status: error instanceof HttpFailure ? error.status : 503 })
    return null
  })
  if (!initial) return
  const writer = await claimOrReject(ctx, false)
  if (!writer) return
  const watch = ctx.deps.groups.watch(scope, roomId.data)
  const release = () => { watch.release(); watch.subscriber.wake?.() }
  ctx.res.once('close', release)
  try {
    writer.start()
    writer.event('snapshot', initial, initial.room ? `${initial.room.identity}:${initial.cursor}` : null)
    while (await writer.ready()) {
      const item = await nextItem(watch.subscriber, 5000)
      if (writer.isClosed) break
      if (item) writer.event(item[0], item[1], item[2])
      else writer.comment('keepalive')
    }
  } finally { ctx.res.off('close', release); release(); writer.end() }
}

export async function handleGroupFile(ctx: RequestContext): Promise<void> {
  const ids = ['room_id', 'event_id', 'attachment_id'].map((key) => GroupIdSchema.safeParse(ctx.query.get(key)))
  if (ids.some((id) => !id.success)) throw new HttpError(400, 'Invalid attachment')
  const [roomId, eventId, attachmentId] = ids.map((id) => id.data!)
  const { attachment, bytes } = await run(() => ctx.deps.groups.download(groupScope(ctx), roomId!, ctx.query.get('identity') ?? '', eventId!, attachmentId!))
  await ctx.send({ body: bytes, headers: { 'Content-Type': attachment.mime, 'Cache-Control': 'no-store', 'Content-Disposition': contentDispositionValue(INLINE_IMAGE_TYPES.has(attachment.mime) ? 'inline' : 'attachment', attachment.name), 'Content-Security-Policy': "sandbox; default-src 'none'" } })
}
