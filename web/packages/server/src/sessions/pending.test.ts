import { describe, expect, it } from 'vitest'
import { SessionEventBus } from './events.js'
import { PendingPrompts, type PendingSubscriber } from './pending.js'

function drain(sub: PendingSubscriber): Record<string, unknown>[] {
  return sub.queue.splice(0)
}

describe('pending prompt streams', () => {
  it('keeps an approval subscriber attached after answering empties the queue (TAL-556)', () => {
    const pending = new PendingPrompts(new SessionEventBus())
    const [sub] = pending.subscribeApprovals('s1')
    pending.submitApproval('s1', { approval_id: 'a', command: 'ls' })
    pending.resolveApproval('s1', 'a')
    drain(sub)

    pending.submitApproval('s1', { approval_id: 'b', command: 'pwd' })
    expect(drain(sub)).toEqual([{ pending: { approval_id: 'b', command: 'pwd' }, pending_count: 1 }])
    pending.resolveApproval('s1', 'b')
    expect(drain(sub)).toEqual([{ pending: null, pending_count: 0 }])

    pending.clearApprovals('s1')
    drain(sub)
    pending.submitApproval('s1', { approval_id: 'c', command: 'id' })
    expect(drain(sub)).toHaveLength(1)

    // An unsubscribed stream stops receiving.
    pending.resolveApproval('s1', 'c')
    drain(sub)
    pending.unsubscribeApprovals('s1', sub)
    pending.submitApproval('s1', { approval_id: 'd', command: 'whoami' })
    expect(sub.queue).toEqual([])
  })

  it('keeps a clarify subscriber attached after answering empties the queue (TAL-556)', () => {
    const pending = new PendingPrompts(new SessionEventBus())
    const [sub] = pending.subscribeClarifies('s1')
    const a = pending.submitClarify('s1', { question: 'First?' })
    pending.resolveClarify('s1', String(a.clarify_id))
    drain(sub)

    const b = pending.submitClarify('s1', { question: 'Second?' })
    expect(drain(sub)).toMatchObject([{ pending: { clarify_id: b.clarify_id }, pending_count: 1 }])
    pending.resolveClarify('s1', String(b.clarify_id))
    expect(drain(sub)).toEqual([{ pending: null, pending_count: 0 }])

    pending.clearClarifies('s1')
    drain(sub)
    pending.submitClarify('s1', { question: 'Third?' })
    expect(drain(sub)).toHaveLength(1)
  })
})
