import { describe, expect, it } from 'vitest'
import { SessionEventBus } from './events.js'
import { PendingPrompts, type PendingSubscriber } from './pending.js'

function drain(sub: PendingSubscriber): Record<string, unknown>[] {
  return sub.queue.splice(0)
}

describe('pending prompt streams', () => {
  it('keeps a command waiter when an overlapping chat turn clears its prompts', () => {
    const pending = new PendingPrompts(new SessionEventBus())
    pending.submitClarify('s', { clarify_id: 'turn', question: 'Turn?' })
    pending.submitClarify('s', { clarify_id: 'command', question: 'Command?' }, 'command')
    expect(pending.clearClarifies('s')).toBe(1)
    expect(pending.clarifyPending('s')).toMatchObject({ pending: { clarify_id: 'command' }, pending_count: 1 })
    pending.resolveClarify('s', 'command')
    expect(pending.clarifyPending('s').pending_count).toBe(0)
  })
  it('keeps identical questions from distinct command invocations separate', () => {
    const pending = new PendingPrompts(new SessionEventBus())
    pending.submitClarify('s', { clarify_id: 'first', question: 'Which environment?', choices_offered: ['dev', 'prod'] })
    pending.submitClarify('s', { clarify_id: 'second', question: 'Which environment?', choices_offered: ['dev', 'prod'] })
    pending.submitClarify('s', { clarify_id: 'second', question: 'Which environment?', choices_offered: ['dev', 'prod'] })
    pending.submitClarify('s', { clarify_id: 'first', question: 'Which environment?', choices_offered: ['dev', 'prod'] })
    expect(pending.clarifyPending('s').pending_count).toBe(2)
    pending.resolveClarify('s', 'first')
    expect(pending.clarifyPending('s').pending?.clarify_id).toBe('second')
    pending.resolveClarify('s', '')
    pending.submitClarify('s', { question: 'Legacy?' })
    pending.submitClarify('s', { question: 'Legacy?' })
    expect(pending.clarifyPending('s').pending_count).toBe(1)
  })
  it('streams the same head the pending routes serve, with its head_id and action_text (TAL-1469)', () => {
    const pending = new PendingPrompts(new SessionEventBus())
    const [approvals] = pending.subscribeApprovals('s1')
    const [questions] = pending.subscribeClarifies('s1')
    pending.submitApproval('s1', { approval_id: 'a', command: 'pwd' })
    pending.submitClarify('s1', { clarify_id: 'q', question: 'Which branch?' })
    expect(drain(approvals).at(-1)).toEqual(pending.approvalPending('s1'))
    expect(pending.approvalPending('s1').pending?.action_text).toBe('pwd')
    expect(String(pending.approvalPending('s1').pending?.head_id)).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(drain(questions).at(-1)).toEqual(pending.clarifyPending('s1'))
    expect(String(pending.clarifyPending('s1').pending?.head_id)).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('names one description for clients: the description, else the question, else the reason (TAL-2333)', () => {
    const pending = new PendingPrompts(new SessionEventBus())
    const head = (sid: string, approval: Record<string, unknown>) => { pending.submitApproval(sid, { approval_id: 'a', ...approval }); return pending.approvalPending(sid).pending?.description }
    expect(head('s1', { description: 'Deletes files', question: 'Allow?', reason: 'Dangerous' })).toBe('Deletes files')
    expect(head('s2', { description: ' ', question: 'Allow?', reason: 'Dangerous' })).toBe('Allow?')
    expect(head('s3', { reason: 'Dangerous' })).toBe('Dangerous')
    expect(head('s4', { command: 'rm -rf build' })).toBeUndefined()
  })
  it('keeps an approval subscriber attached after answering empties the queue (TAL-556)', () => {
    const pending = new PendingPrompts(new SessionEventBus())
    const [sub] = pending.subscribeApprovals('s1')
    pending.submitApproval('s1', { approval_id: 'a', command: 'ls' })
    pending.resolveApproval('s1', 'a')
    drain(sub)

    pending.submitApproval('s1', { approval_id: 'b', command: 'pwd' })
    const updates = drain(sub)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ pending: { approval_id: 'b', command: 'pwd' }, pending_count: 1 })
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
