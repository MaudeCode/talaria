/** Native-shaped disposable responses; the real native compatibility test owns driver behavior. */
import { createHash } from 'node:crypto'
import type { SidecarParams } from '@maudecode/talaria-web-contracts'
import type { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'

export function groupFixture(sidecar: FakeSidecar) {
  const members = [{ member_id: 'one', profile: 'default', handle: 'one', display_name: 'Writer' }, { member_id: 'two', profile: 'helper', handle: 'two', display_name: 'Reviewer' }]
  const room = { room_id: 'discussion', name: 'Design review', members, authority_gateway_id: 'gateway', authority_epoch: 1, revision: 1, latest_seq: 0 }
  const state = { driver: true, available: true, lostSend: false, disbanded: false, refuseRetry: false, room, events: [] as Record<string, unknown>[],
    contextOffered: true, refuseContext: false, lostContext: null as 'before' | 'after' | null,
    context: { purpose: '', notes: '', routing: 'everyone', lead_member_id: '' },
    /** Agent v0.23.0 `groups.continue`; `lostContinue` loses the response after (`applied`) or before (`dropped`) the grant lands. */
    continueMethod: true, refuseContinue: false, lostContinue: null as 'applied' | 'dropped' | null,
    driver_status: { routing_modes: undefined as string[] | undefined, running: true, working: false, blocked: false, max_rounds: undefined as number | null | undefined, max_continues: 5 as number | undefined, pending_actions: [] as Record<string, unknown>[], member_activity: [] as { member_id: string; status: string; tool?: string | null; started_at?: number | null; progress_at?: number | null; thread_id?: string | null; round_index?: number | null }[] } }
  function append(kind: string, text: string, member = members[0]!, eventId?: string) {
    const seq = state.events.length + 1
    const event = { room_id: room.room_id, seq, event_id: eventId ?? `event-${seq}`, kind, authority_epoch: 1,
      actor: kind === 'message.user' ? { kind: 'user', id: 'desktop' } : { kind: 'member', id: member.member_id, profile: member.profile },
      payload: { text, member_id: member.member_id }, created_at: 1000 + seq }
    state.events.push(event); room.latest_seq = seq
    return event
  }
  /** Agent v0.22.6 after three failed wakes: one `member.unavailable` event and a room-level Retry naming the joined handles. */
  function stall(error: string) {
    const seq = state.events.length + 1
    state.events.push({ room_id: room.room_id, seq, event_id: `prepare-stalled:${seq - 1}`, kind: 'member.unavailable', authority_epoch: 1, actor: { kind: 'gateway', id: 'gateway' },
      payload: { error, reason_code: 'prepare_failed' }, created_at: 1000 + seq })
    room.latest_seq = seq
    state.driver_status.pending_actions.push({ kind: 'retry', member_id: room.members.map((m) => m.handle).join(', '), task_id: `prepare:${room.room_id}`, execution_generation: 1 })
  }
  /** Agent v0.22.7 `post_scheduled_message`: an ordinary `message.user` whose server-minted actor names the cron job. */
  function scheduled(actor: { kind: 'user'; id: string; display_name?: string }, text: string) {
    const seq = state.events.length + 1
    const event = { room_id: room.room_id, seq, event_id: `cron-post:${seq}`, kind: 'message.user', authority_epoch: 1, actor, payload: { text, thread_id: `cron-${seq}` }, created_at: 1000 + seq }
    state.events.push(event); room.latest_seq = seq
    return event
  }
  /** Agent v0.22.7 lead routing: the gateway records who the lead's routing turn picked, or a fallback to the lead alone. */
  function assignment(leadMemberId: string, memberIds: string[], fallback = false) {
    const seq = state.events.length + 1
    state.events.push({ room_id: room.room_id, seq, event_id: `dassign:${seq}`, kind: 'room.assignment', authority_epoch: 1, actor: { kind: 'gateway', id: 'gateway' },
      payload: { discussion_event_id: 'event-1', thread_id: 'thread', task_id: 'dtask:1', lead_member_id: leadMemberId, member_ids: memberIds, fallback }, created_at: 1000 + seq })
    room.latest_seq = seq
  }
  function gateway(kind: string, payload: Record<string, unknown>, eventId?: string) {
    const seq = state.events.length + 1
    const event = { room_id: room.room_id, seq, event_id: eventId ?? `${kind}:${seq}`, kind, authority_epoch: 1, actor: { kind: 'gateway', id: 'gateway' }, payload, created_at: 1000 + seq }
    state.events.push(event); room.latest_seq = seq
    return event
  }
  /** A user's message opening its own discussion thread, as every Web send does. */
  function discussion(text: string, threadId: string) {
    const event = append('message.user', text)
    Object.assign(event.payload, { thread_id: threadId })
    return event.event_id
  }
  /** Agent v0.23.0 `_append_room_status`: the discussion's outcome, `bounded` at its cap. */
  function activity(discussionId: string, threadId: string, reason = 'max_rounds', status = 'bounded') {
    return gateway('room.activity', { status, reason_code: reason, thread_id: threadId, discussion_event_id: discussionId }, `dactivity:${discussionId}:${reason}:${state.events.length}`)
  }
  const continued = (discussionId: string, threadId: string) => gateway('room.continued', { discussion_event_id: discussionId, thread_id: threadId, grant: 1 })
  sidecar.respond('gateway.groups', ({ operation }: SidecarParams<'gateway.groups'>) => {
    if (!state.available) return { state: 'unavailable', reason: 'unsupported', value: null }
    let value: Record<string, unknown>
    switch (operation.action) {
      case 'capabilities': value = { driver: state.driver, authority_gateway_id: 'gateway', methods: ['capabilities', 'list', 'state', 'log', 'create', 'rename', 'disband', 'send', 'stop', ...(state.continueMethod ? ['continue'] : []), 'approve', 'retry', 'discard', 'attachment.upload', 'attachment.download', ...(state.contextOffered ? ['context'] : [])].map((s) => `groups.${s}`), seatable_profiles: ['default', 'helper'], max_log_limit: 100 }; break
      case 'list': value = { rooms: state.disbanded ? [] : [room], next_offset: null }; break
      case 'create': room.room_id = operation.room_id; room.name = operation.name; room.members = operation.members.map((m) => ({ ...m, display_name: m.display_name ?? m.profile })); value = { room }; break
      case 'state': value = { room, driver_status: state.driver_status, ...(state.contextOffered ? { context: state.context } : {}) }; break
      case 'log': {
        const events = state.events.filter((event) => Number(event.seq) > operation.since_seq).slice(0, operation.limit ?? 100)
        const cursor = Number(events.at(-1)?.seq ?? operation.since_seq)
        value = { events, cursor, latest_seq: room.latest_seq, has_more: cursor < room.latest_seq, authority: { gateway_id: 'gateway', epoch: room.authority_epoch } }; break
      }
      case 'send': {
        const eventId = `user:${createHash('sha256').update(operation.event_id).digest('hex')}`
        const event = append('message.user', operation.payload.text, room.members[0], eventId)
        Object.assign(event.payload, { attachments: operation.payload.attachments ?? [] })
        append('message.member', 'First member reply', room.members[0]); append('message.member', 'Second member reply', room.members[1])
        value = { accepted: true, client_event_id: operation.event_id, event, driver_started: true }
        if (state.lostSend) throw new SidecarError('response lost', { condition: 'sidecar_timeout' })
        break
      }
      case 'rename': room.name = operation.name; value = { room }; break
      case 'context': {
        if (state.refuseContext) return { state: 'refused', reason: 'refused', value: null }
        if (state.lostContext === 'before') throw new SidecarError('response lost', { condition: 'sidecar_timeout' })
        // A retry of the same event_id returns its first event, and everyone routing keeps no lead.
        let event = state.events.find((e) => e.event_id === operation.event_id)
        if (!event) {
          state.context = { purpose: operation.purpose, notes: operation.notes, routing: operation.routing, lead_member_id: operation.routing === 'lead' ? operation.lead_member_id ?? '' : '' }
          event = { room_id: room.room_id, seq: state.events.length + 1, event_id: operation.event_id, kind: 'room.context_set', authority_epoch: 1, actor: { kind: 'system', id: 'room-control' }, payload: state.context, created_at: 2000 }
          state.events.push(event); room.latest_seq = state.events.length
        }
        value = { context: state.context, event }
        if (state.lostContext === 'after') throw new SidecarError('response lost', { condition: 'sidecar_timeout' })
        break
      }
      case 'disband': state.disbanded = true; value = { tombstone: { room_id: room.room_id, disbanded_at: 1234 } }; break
      case 'stop': value = { cancelled: 1 }; break
      case 'continue': {
        if (state.refuseContinue) return { state: 'refused', reason: 'refused', value: null }
        if (state.lostContinue === 'dropped') throw new SidecarError('response lost', { condition: 'sidecar_timeout' })
        value = { continued: true, event: continued(operation.discussion_event_id, 'thread') }
        if (state.lostContinue === 'applied') throw new SidecarError('response lost', { condition: 'sidecar_timeout' })
        break
      }
      case 'approve':
        if (!state.driver_status.pending_actions.some((a) => a.task_id === operation.task_id && a.request_id === operation.request_id)) return { state: 'refused', reason: 'refused', value: null }
        state.driver_status.pending_actions = state.driver_status.pending_actions.filter((a) => a.task_id !== operation.task_id || a.request_id !== operation.request_id)
        value = { approved: true, result: {} }; break
      case 'retry':
        if (state.refuseRetry) return { state: 'refused', reason: 'refused', value: null }
        state.driver_status.pending_actions = state.driver_status.pending_actions.filter((a) => a.task_id !== operation.task_id)
        value = { retried: true, task: { task_id: operation.task_id, status: 'prepared', execution_generation: 1, cancel_generation: 0 } }; break
      case 'discard': value = { discarded: true }; break
      case 'attachment.upload': value = { attachment_id: 'att_fixture', kind: operation.kind, name: operation.name, mime: operation.mime, size: Buffer.from(operation.data_base64, 'base64').length, sha256: createHash('sha256').update(Buffer.from(operation.data_base64, 'base64')).digest('hex') }; break
      case 'attachment.download': value = { attachment_id: operation.attachment_id, kind: 'file', name: 'note.txt', mime: 'text/plain', size: 4, data_base64: Buffer.from('note').toString('base64'), sha256: createHash('sha256').update('note').digest('hex'), event_id: operation.event_id }; break
    }
    return { state: 'available', reason: null, value }
  })
  return { state, members, append, stall, scheduled, assignment, gateway, discussion, activity, continued }
}
