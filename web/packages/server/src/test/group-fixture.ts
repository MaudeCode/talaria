/** Native-shaped disposable responses; the real native compatibility test owns driver behavior. */
import { createHash } from 'node:crypto'
import type { SidecarParams } from '@maudecode/talaria-web-contracts'
import type { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'

export function groupFixture(sidecar: FakeSidecar) {
  const members = [{ member_id: 'one', profile: 'default', handle: 'one', display_name: 'Writer' }, { member_id: 'two', profile: 'helper', handle: 'two', display_name: 'Reviewer' }]
  const room = { room_id: 'discussion', name: 'Design review', members, authority_gateway_id: 'gateway', authority_epoch: 1, revision: 1, latest_seq: 0 }
  const state = { driver: true, available: true, lostSend: false, disbanded: false, refuseRetry: false, room, events: [] as Record<string, unknown>[],
    driver_status: { running: true, working: false, blocked: false, pending_actions: [] as Record<string, unknown>[], member_activity: [] as { member_id: string; status: string }[] } }
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
  sidecar.respond('gateway.groups', ({ operation }: SidecarParams<'gateway.groups'>) => {
    if (!state.available) return { state: 'unavailable', reason: 'unsupported', value: null }
    let value: Record<string, unknown>
    switch (operation.action) {
      case 'capabilities': value = { driver: state.driver, authority_gateway_id: 'gateway', methods: ['capabilities', 'list', 'state', 'log', 'create', 'rename', 'disband', 'send', 'stop', 'approve', 'retry', 'discard', 'attachment.upload', 'attachment.download'].map((s) => `groups.${s}`), seatable_profiles: ['default', 'helper'], max_log_limit: 100 }; break
      case 'list': value = { rooms: state.disbanded ? [] : [room], next_offset: null }; break
      case 'create': room.room_id = operation.room_id; room.name = operation.name; room.members = operation.members.map((m) => ({ ...m, display_name: m.display_name ?? m.profile })); value = { room }; break
      case 'state': value = { room, driver_status: state.driver_status }; break
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
      case 'disband': state.disbanded = true; value = { tombstone: { room_id: room.room_id, disbanded_at: 1234 } }; break
      case 'stop': value = { cancelled: 1 }; break
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
  return { state, members, append, stall, scheduled }
}
