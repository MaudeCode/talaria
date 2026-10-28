/** Native rooms own their durable log/tasks; this service owns bounded display observations only. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { GROUP_ATTACHMENT_BYTES, GROUP_ATTACHMENT_LIMIT, GROUP_ATTACHMENT_BASE64_LIMIT, GroupAttachmentSchema, GroupMemberSchema, NativeGroupCapabilitiesSchema, NativeGroupListSchema, NativeGroupLogSchema, NativeGroupStateSchema, NativeGroupEventSchema, type SidecarParams, type GroupCatalog, type GroupOperation, type GroupRoom, type GroupView, type GroupWriteResult } from '@maudecode/talaria-web-contracts'
import type { AppDeps } from '../http/context.js'
import { HttpFailure } from './service.js'
import { StreamChannel, type StreamSubscriber } from './streams.js'
import { redactString } from '../redact.js'

export interface GroupScope { home: string; subject: string; profile: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const nativeEventId = (requestId: string) => `user:${createHash('sha256').update(requestId).digest('hex')}`
type State = z.infer<typeof NativeGroupStateSchema>
type NativeEvent = z.infer<typeof NativeGroupLogSchema>['events'][number]
type Capabilities = z.infer<typeof NativeGroupCapabilitiesSchema>
interface Observation { identity: string; cursor: number; events: NativeEvent[] }
const empty = (reason: GroupView['reason']): GroupView => ({ available: false, reason, room: null, rows: [], cursor: 0, has_more: false, next_before_seq: null })
const reasons = new Set(['unsupported', 'stopped', 'refused', 'unavailable', 'unknown', 'driver_inactive'])
const safeReason = (reason: string | null): GroupView['reason'] => reasons.has(reason ?? '') ? reason as GroupView['reason'] : 'unavailable'
const sameMembers = (left: State['room']['members'], right: State['room']['members']) => left.length === right.length && left.every((m, i) => m.member_id === right[i]?.member_id && m.profile === right[i]?.profile && m.handle === right[i]?.handle)
const localMembers = (members: State['room']['members']) => members.every((m) => !m.target || m.target.kind === 'local' && m.target.profile === m.profile)

export class Groups {
  private readonly watchers = new Map<string, { channel: StreamChannel; controller: AbortController; done: Promise<void> }>()
  constructor(private readonly deps: () => AppDeps, private readonly pollMs = 1000) {}

  /** Resolve protocol identity before dispatch so SSE can confirm an in-flight occurrence. No owner access. */
  sendIdentity(requestId: string): { event_id: string } { return { event_id: nativeEventId(requestId) } }

  scope(profile: string, owner: string): GroupScope {
    return { home: this.deps().profileHome(profile), subject: hash(['talaria', owner]), profile }
  }

  private async call(scope: GroupScope, operation: GroupOperation, signal?: AbortSignal, expectedRoom?: SidecarParams<'gateway.groups'>['expected_room']) {
    const sidecar = this.deps().sidecar()
    if (!sidecar) return { state: 'unavailable' as const, reason: 'unsupported', value: null }
    try { return await sidecar.call('gateway.groups', { profile_home: scope.home, subject: scope.subject, operation, ...(expectedRoom ? { expected_room: expectedRoom } : {}) }, { timeoutMs: 35_000, ...(signal ? { signal } : {}) }) }
    catch { return { state: ['capabilities', 'list', 'state', 'log', 'attachment.download'].includes(operation.action) ? 'unavailable' as const : 'unknown' as const, reason: 'unknown', value: null } }
  }

  private async supported(scope: GroupScope, signal?: AbortSignal) {
    const response = await this.call(scope, { action: 'capabilities' }, signal)
    if (response.state !== 'available') return { caps: null, reason: safeReason(response.reason) }
    const parsed = NativeGroupCapabilitiesSchema.safeParse(response.value)
    if (!parsed.success) return { caps: null, reason: 'unsupported' as const }
    if (!parsed.data.driver) return { caps: null, reason: 'driver_inactive' as const }
    return { caps: parsed.data, reason: null }
  }

  private async profiles(scope: GroupScope) {
    const rows = await this.deps().profiles.list(scope.profile)
    return rows.flatMap((row) => typeof row.name === 'string' ? [{ profile: row.is_default === true ? 'default' : row.name, label: typeof row.display_name === 'string' && row.display_name ? redactString(row.display_name) : row.name }] : [])
  }

  private authorityIdentity(scope: GroupScope, gatewayId: string): string { return hash([scope, gatewayId]) }
  private identity(scope: GroupScope, room: State['room']): string { return hash([this.authorityIdentity(scope, room.authority_gateway_id), room.room_id, room.authority_epoch]) }

  private project(scope: GroupScope, state: State, caps: Capabilities, events: NativeEvent[] = []): GroupRoom {
    const room = state.room, driver = state.driver_status
    const active = !room.disbanded_at && driver?.running === true
    const actions = new Set(caps.methods)
    return { id: room.room_id, name: redactString(room.name), identity: this.identity(scope, room), revision: room.revision, disbanded: room.disbanded_at !== undefined,
      max_upload_bytes: Math.min(GROUP_ATTACHMENT_BYTES, this.deps().config.maxUploadBytes), attachment_limit: GROUP_ATTACHMENT_LIMIT,
      members: room.members.map((member) => {
        const pending = active ? (driver?.pending_actions ?? []).filter((a) => a.member_id === member.member_id && actions.has(`groups.${a.kind === 'approval' ? 'approve' : a.kind}`)) : []
        const status = driver?.member_activity?.find((a) => a.member_id === member.member_id)?.status
        const terminal = events.findLast((e) => e.payload.member_id === member.member_id && ['turn.failed', 'turn.settled', 'turn.cancelled', 'turn.deferred'].includes(e.kind))
        const phase = pending.some((a) => a.kind === 'approval') ? 'approval' as const : status === 'indeterminate' || pending.some((a) => a.kind === 'discard') ? 'unknown' as const : status === 'deferred' || pending.some((a) => a.kind === 'retry') ? 'failed' as const : status ?? (driver?.working && driver.member_activity === undefined ? 'unknown' as const : terminal?.kind === 'turn.failed' ? 'failed' as const : 'idle' as const)
        return { ...GroupMemberSchema.parse(member), display_name: redactString(member.display_name || member.profile), phase,
          actions: pending.map((a) => ({ ...a, approval: a.approval ? { ...a.approval, command: a.approval.command ? redactString(a.approval.command) : undefined, description: a.approval.description ? redactString(a.approval.description) : undefined } : undefined })) }
      }),
      actions: active ? (['send', 'rename', 'disband', 'stop'] as const).filter((action) => actions.has(`groups.${action}`) && (action !== 'stop' || driver.working || driver.blocked)) : [],
    }
  }

  async catalog(scope: GroupScope, offset = 0): Promise<GroupCatalog> {
    const { caps, reason } = await this.supported(scope)
    const unavailable: GroupCatalog = { identity: null, available: false, reason, profiles: [], rooms: [], actions: [], next_offset: null }
    if (!caps) return unavailable
    const [profiles, response] = await Promise.all([this.profiles(scope), this.call(scope, { action: 'list', offset, limit: 50 })])
    const parsed = NativeGroupListSchema.safeParse(response.value)
    if (response.state !== 'available' || !parsed.success) return { ...unavailable, reason: safeReason(response.reason) }
    const managed = new Set(profiles.map((p) => p.profile))
    return { identity: this.authorityIdentity(scope, caps.authority_gateway_id), available: true, reason: null, profiles: profiles.filter((p) => caps.seatable_profiles.includes(p.profile)),
      rooms: parsed.data.rooms.filter((r) => localMembers(r.members) && r.members.every((m) => managed.has(m.profile))).map((room) => this.project(scope, { room }, caps)), actions: caps.methods.includes('groups.create') ? ['create'] : [], next_offset: parsed.data.next_offset }
  }

  private async state(scope: GroupScope, roomId: string, caps: Capabilities, signal?: AbortSignal) {
    const response = await this.call(scope, { action: 'state', room_id: roomId, include_disbanded: true }, signal)
    if (response.state !== 'available') throw new HttpFailure(409, 'Discussion unavailable', { reason: safeReason(response.reason) })
    const state = NativeGroupStateSchema.parse(response.value)
    const managed = new Set((await this.profiles(scope)).map((p) => p.profile))
    if (state.room.room_id !== roomId || state.room.authority_gateway_id !== caps.authority_gateway_id || !localMembers(state.room.members) || !state.room.members.every((m) => managed.has(m.profile))) throw new HttpFailure(404, 'Discussion not found')
    return state
  }

  private rows(scope: GroupScope, state: State, events: NativeEvent[]): GroupView['rows'] {
    return events.flatMap((event) => {
      const member = state.room.members.find((m) => m.member_id === event.actor.id && m.member_id === event.payload.member_id && m.profile === event.actor.profile)
      const user = event.kind === 'message.user' && event.actor.kind === 'user'
      if (!user && (event.kind !== 'message.member' || event.actor.kind !== 'member' || !member)) return []
      const attachments = (event.payload.attachments ?? []).map((a) => ({ ...a, event_id: event.event_id, download_url: `/api/groups/file?${new URLSearchParams({ room_id: state.room.room_id, event_id: event.event_id, attachment_id: a.attachment_id, identity: this.identity(scope, state.room) }).toString()}` }))
      return [{ key: `${event.seq}:${event.event_id}`, index: event.seq, author: user ? '' : redactString(member?.display_name || member?.profile || ''),
        message: { role: user ? 'user' as const : 'assistant' as const, content: redactString(event.payload.text ?? ''), message_id: event.event_id, timestamp: event.created_at, _turn_id: event.event_id, attachments: attachments.map((a) => ({ name: a.name, mime: a.mime, size: a.size, is_image: a.kind === 'image', download_url: a.download_url })) }, attachments }]
    })
  }

  private async log(scope: GroupScope, room: State['room'], cursor: number, limit: number, signal?: AbortSignal) {
    const response = await this.call(scope, { action: 'log', room_id: room.room_id, since_seq: cursor, limit }, signal)
    const parsed = NativeGroupLogSchema.safeParse(response.value)
    if (response.state !== 'available' || !parsed.success) return null
    const log = parsed.data
    if (log.authority.gateway_id !== room.authority_gateway_id || log.authority.epoch !== room.authority_epoch) return null
    let seq = cursor
    for (const event of log.events) { if (event.room_id !== room.room_id || event.seq !== seq + 1) return null; seq = event.seq }
    return log.cursor === seq ? log : null
  }

  async view(scope: GroupScope, roomId: string, before?: number, signal?: AbortSignal, observation?: Observation): Promise<GroupView> {
    const { caps, reason } = await this.supported(scope, signal)
    if (!caps) return empty(reason)
    const state = await this.state(scope, roomId, caps, signal)
    if (state.room.disbanded_at !== undefined) return { available: true, reason: null, room: this.project(scope, state, caps), rows: [], cursor: state.room.latest_seq ?? 0, has_more: false, next_before_seq: null }
    const latest = state.room.latest_seq ?? 0
    const end = Math.min(before === undefined ? latest : before - 1, latest)
    const identity = this.identity(scope, state.room)
    const resumed = observation?.identity === identity && observation.cursor <= latest && latest - observation.cursor <= 100
    const start = resumed ? observation.cursor : Math.max(0, end - 100)
    const events = resumed ? [...observation.events] : []
    let seq = start
    // Native byte caps can shorten a page. Drain this bounded window without skipping its tail.
    do {
      const log = await this.log(scope, state.room, seq, Math.min(caps.max_log_limit, 100), signal)
      if (!log) {
        if (observation) { observation.identity = ''; return this.view(scope, roomId, before, signal) }
        return empty('unavailable')
      }
      const page = log.events.filter((e) => e.seq <= end)
      for (const event of page) {
        if (event.room_id !== roomId || event.seq !== seq + 1) {
          if (observation) { observation.identity = ''; return this.view(scope, roomId, before, signal) }
          return empty('unavailable')
        }
        seq = event.seq; events.push(event)
      }
      if (!page.length || seq >= end) break
    } while (!signal?.aborted)
    const retained = events.slice(-100)
    if (observation) Object.assign(observation, { identity, cursor: seq, events: retained })
    const previous = (retained[0]?.seq ?? 1) > 1 ? retained[0]!.seq : null
    return { available: true, reason: null, room: this.project(scope, state, caps, retained), rows: this.rows(scope, state, retained), cursor: seq, has_more: previous !== null, next_before_seq: previous }
  }

  async write(scope: GroupScope, identity: string | null, operation: GroupOperation): Promise<GroupWriteResult> {
    if (!('room_id' in operation) || ['state', 'log', 'attachment.download'].includes(operation.action)) throw new HttpFailure(400, 'Invalid discussion action')
    const result: GroupWriteResult = { outcome: 'refused', reason: 'unavailable', room_id: operation.room_id, event_id: 'event_id' in operation ? operation.action === 'send' ? nativeEventId(operation.event_id) : operation.event_id : null, attachment: null }
    let forwarded = operation
    let expectedRoom: SidecarParams<'gateway.groups'>['expected_room']
    if (operation.action === 'attachment.upload' && Buffer.from(operation.data_base64, 'base64').length > Math.min(GROUP_ATTACHMENT_BYTES, this.deps().config.maxUploadBytes)) throw new HttpFailure(413, 'Discussion attachment exceeds the upload limit')
    const { caps, reason } = await this.supported(scope)
    if (!caps) return { ...result, reason }
    if (!caps.methods.includes(`groups.${operation.action}`)) return { ...result, reason: 'unsupported' }
    if (operation.action === 'create') {
      if (identity !== this.authorityIdentity(scope, caps.authority_gateway_id)) throw new HttpFailure(409, 'Discussion profile changed')
      const profiles = await this.profiles(scope)
      const managed = new Set(profiles.map((p) => p.profile))
      if (operation.members.some((m) => !managed.has(m.profile) || !caps.seatable_profiles.includes(m.profile)) || new Set(operation.members.map((m) => m.member_id)).size !== operation.members.length) throw new HttpFailure(400, 'Ineligible discussion member')
      forwarded = { ...operation, members: operation.members.map((member) => ({ ...member, display_name: profiles.find((p) => p.profile === member.profile)?.label ?? member.profile })) }
    } else {
      const current = await this.state(scope, operation.room_id, caps)
      expectedRoom = { room_id: current.room.room_id, gateway_id: current.room.authority_gateway_id, authority_epoch: current.room.authority_epoch }
      if (!identity || identity !== this.identity(scope, current.room)) throw new HttpFailure(409, 'Discussion identity changed')
      const room = this.project(scope, current, caps)
      if (['send', 'rename', 'disband', 'stop'].includes(operation.action) && !room.actions.includes(operation.action as 'send' | 'rename' | 'disband' | 'stop')) return { ...result, reason: 'refused' }
      if (['retry', 'discard', 'approve'].includes(operation.action) && 'task_id' in operation) {
        const permitted = room.members.flatMap((m) => m.actions).some((a) => a.kind === (operation.action === 'approve' ? 'approval' : operation.action) && a.member_id === operation.member_id && a.task_id === operation.task_id && a.execution_generation === operation.execution_generation && (operation.action !== 'approve' || a.request_id === operation.request_id))
        if (!permitted) throw new HttpFailure(409, 'Discussion task changed')
      }
    }
    let response = await this.call(scope, forwarded, undefined, expectedRoom)
    if (response.state === 'available' && !this.validReceipt(forwarded, response.value)) response = { state: 'unknown', reason: 'unknown', value: null }
    if (response.state !== 'available') {
      // Reconcile durable send/create identities; a transport loss never triggers another write.
      if (response.state === 'unknown' && ['send', 'create', 'rename', 'disband'].includes(operation.action)) {
        if (operation.action === 'send') {
          const event = await this.findEvent(scope, operation.room_id, nativeEventId(operation.event_id)).catch(() => null)
          if (event?.payload.text === operation.payload.text.trim() && isDeepStrictEqual(event.payload.attachments ?? [], operation.payload.attachments ?? [])) return { ...result, outcome: 'confirmed', reason: null }
        }
        const read = await this.view(scope, operation.room_id).catch(() => null)
        if (read?.available && read.room && ((operation.action === 'create' && read.room.name === redactString(operation.name) && sameMembers(read.room.members, operation.members)) || (operation.action === 'rename' && read.room.name === redactString(operation.name)) || (operation.action === 'disband' && read.room.disbanded))) return { ...result, outcome: 'confirmed', reason: null }
      }
      return { ...result, outcome: response.state === 'unknown' ? 'unknown' : 'refused', reason: safeReason(response.reason) }
    }
    const attachment = operation.action === 'attachment.upload' ? GroupAttachmentSchema.parse(response.value) : null
    return { ...result, outcome: 'confirmed', reason: null, attachment }
  }

  private validReceipt(operation: GroupOperation, value: unknown): boolean {
    try {
      switch (operation.action) {
        case 'create': case 'rename': {
          const state = NativeGroupStateSchema.parse(value)
          return state.room.room_id === operation.room_id && state.room.name === operation.name && localMembers(state.room.members) && (operation.action !== 'create' || sameMembers(state.room.members, operation.members))
        }
        case 'send': {
          const receipt = z.object({ accepted: z.literal(true), client_event_id: z.string(), event: NativeGroupEventSchema }).parse(value)
          return receipt.client_event_id === operation.event_id && receipt.event.room_id === operation.room_id && receipt.event.event_id === nativeEventId(operation.event_id)
        }
        case 'stop': return z.object({ cancelled: z.number().int().nonnegative() }).safeParse(value).success
        case 'disband': return z.object({ tombstone: z.object({ room_id: z.literal(operation.room_id), disbanded_at: z.number() }) }).safeParse(value).success
        case 'approve': return z.object({ approved: z.literal(true) }).safeParse(value).success
        case 'retry': return z.object({ retried: z.literal(true) }).safeParse(value).success
        case 'discard': return z.object({ discarded: z.literal(true) }).safeParse(value).success
        case 'attachment.upload': {
          const receipt = GroupAttachmentSchema.extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).parse(value)
          const bytes = Buffer.from(operation.data_base64, 'base64')
          return receipt.size === bytes.length && receipt.sha256 === createHash('sha256').update(bytes).digest('hex') && receipt.kind === operation.kind && receipt.name === operation.name && receipt.mime === operation.mime
        }
        default: return false
      }
    } catch { return false }
  }

  private async findEvent(scope: GroupScope, roomId: string, eventId: string): Promise<NativeEvent | null> {
    const { caps } = await this.supported(scope)
    if (!caps) return null
    const { room } = await this.state(scope, roomId, caps)
    const tail = Math.max(0, (room.latest_seq ?? 0) - 100)
    const match = (events: NativeEvent[]) => events.find((e) => e.event_id === eventId && e.kind === 'message.user' && e.actor.kind === 'user') ?? null
    // A bounded search may remain unknown; it never grants a resend.
    let remaining = 100
    for (const [start, end] of [[tail, room.latest_seq ?? 0], [0, tail]] as const) {
      let cursor = start
      while (remaining-- > 0 && cursor < end) {
        const log = await this.log(scope, room, cursor, Math.min(caps.max_log_limit, 100))
        if (!log || log.cursor <= cursor) break
        const event = match(log.events)
        if (event) return event
        cursor = log.cursor
      }
    }
    return null
  }

  async receipt(scope: GroupScope, roomId: string, requestId: string): Promise<GroupWriteResult> {
    const eventId = nativeEventId(requestId)
    const observed = await this.findEvent(scope, roomId, eventId) !== null
    return { outcome: observed ? 'confirmed' : 'unknown', reason: observed ? null : 'unknown', room_id: roomId, event_id: eventId, attachment: null }
  }

  async download(scope: GroupScope, roomId: string, identity: string, eventId: string, attachmentId: string) {
    const { caps } = await this.supported(scope)
    if (!caps) throw new HttpFailure(409, 'Discussion unavailable')
    const state = await this.state(scope, roomId, caps)
    if (identity !== this.identity(scope, state.room)) throw new HttpFailure(409, 'Discussion identity changed')
    const response = await this.call(scope, { action: 'attachment.download', room_id: roomId, event_id: eventId, attachment_id: attachmentId }, undefined, { room_id: roomId, gateway_id: state.room.authority_gateway_id, authority_epoch: state.room.authority_epoch })
    if (response.state !== 'available') throw new HttpFailure(404, 'Attachment unavailable')
    const attachment = GroupAttachmentSchema.extend({ data_base64: z.string().max(GROUP_ATTACHMENT_BASE64_LIMIT), sha256: z.string().regex(/^[0-9a-f]{64}$/), event_id: z.literal(eventId) }).parse(response.value)
    const bytes = Buffer.from(attachment.data_base64, 'base64')
    if (attachment.attachment_id !== attachmentId || bytes.length !== attachment.size || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256 || bytes.toString('base64') !== attachment.data_base64) throw new HttpFailure(404, 'Attachment unavailable')
    return { attachment, bytes }
  }

  watch(scope: GroupScope, roomId: string): { subscriber: StreamSubscriber; release: () => void } {
    const key = hash([scope, roomId])
    let watcher = this.watchers.get(key)
    if (!watcher) {
      const channel = new StreamChannel(), controller = new AbortController()
      watcher = { channel, controller, done: Promise.resolve() }
      this.watchers.set(key, watcher)
      const run = async () => {
        const observation: Observation = { identity: '', cursor: 0, events: [] }
        while (!controller.signal.aborted) {
          const view = await this.view(scope, roomId, undefined, controller.signal, observation).catch(() => empty('unavailable'))
          if (controller.signal.aborted) break
          channel.replace(['snapshot', view, view.room ? `${view.room.identity}:${view.cursor}` : null])
          await new Promise<void>((resolve) => {
            const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve() }
            const timer = setTimeout(finish, this.pollMs)
            controller.signal.addEventListener('abort', finish, { once: true })
          })
        }
      }
      watcher.done = run()
    }
    const [subscriber] = watcher.channel.subscribeWithSnapshot()
    const current = watcher
    let released = false
    return { subscriber, release: () => {
      if (released) return
      released = true
      current.channel.unsubscribe(subscriber)
      if (!current.channel.subscriberCount) { current.controller.abort(); if (this.watchers.get(key) === current) this.watchers.delete(key) }
    } }
  }

  async close(): Promise<void> { const watchers = [...this.watchers.values()]; this.watchers.clear(); for (const w of watchers) w.controller.abort(); await Promise.all(watchers.map((w) => w.done)) }
}
