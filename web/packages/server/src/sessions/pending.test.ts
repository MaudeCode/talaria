import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubDisplaySettings } from './display-settings.js'
import { SessionEventBus } from './events.js'
import { PendingPrompts, type PendingSubscriber } from './pending.js'

const scopeFixture = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/tool-approval-and-agents.json'), 'utf8')) as { approval_scopes: { pending: Record<string, unknown> }[] }).approval_scopes

const withdrawalFixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/prompt-withdrawal.json'), 'utf8')) as Record<'approval_timeout' | 'resolved', Record<string, unknown>>

function drain(sub: PendingSubscriber): Record<string, unknown>[] {
  return sub.queue.splice(0)
}

describe('pending prompt streams', () => {
  it.each([
    ['timeout', withdrawalFixture.approval_timeout],
    ['resolved', withdrawalFixture.resolved],
  ])('reports the final approval withdrawal after %s', (reason, envelope) => {
    const pending = new PendingPrompts(new SessionEventBus())
    pending.submitApproval('s', { approval_id: 'a', command: 'pwd' })
    const [subscriber] = pending.subscribeApprovals('s')
    pending.resolveApproval('s', 'a', reason)
    expect(drain(subscriber)).toEqual([envelope])
    expect(pending.approvalPending('s')).toEqual(envelope)
  })

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

  it('writes out every choice for an approval that names none, and keeps the ones an approval names (TAL-2481)', () => {
    const pending = new PendingPrompts(new SessionEventBus())
    pending.submitApproval('unnamed', { approval_id: 'a', command: 'pwd' })
    pending.submitApproval('named', { approval_id: 'b', command: 'pwd', allowed_choices: ['deny', 'once'] })
    expect(pending.approvalPending('unnamed').pending?.allowed_choices).toEqual(['once', 'session', 'always', 'deny'])
    expect(pending.approvalPending('named').pending?.allowed_choices).toEqual(['once', 'deny'])
  })

  it('names one description for clients: the description, else the question, else the reason (TAL-2333)', () => {
    const pending = new PendingPrompts(new SessionEventBus())
    const head = (sid: string, approval: Record<string, unknown>) => { pending.submitApproval(sid, { approval_id: 'a', ...approval }); return pending.approvalPending(sid).pending?.description }
    expect(head('s1', { description: 'Deletes files', question: 'Allow?', reason: 'Dangerous' })).toBe('Deletes files')
    expect(head('s2', { description: ' ', question: 'Allow?', reason: 'Dangerous' })).toBe('Allow?')
    expect(head('s3', { reason: 'Dangerous' })).toBe('Dangerous')
    expect(head('s4', { command: 'rm -rf build' })).toBeUndefined()
  })
  it('lets an Allow outside the card confirm only the command or the Agent\'s own description, never a question or reason (TAL-2333)', () => {
    const pending = new PendingPrompts(new SessionEventBus())
    const allow = (sid: string, approval: Record<string, unknown>) => { pending.submitApproval(sid, { approval_id: 'a', ...approval }); return pending.approvalPending(sid).pending?.allow_text }
    expect(allow('s1', { command: ' rm -rf build ', description: 'Deletes files' })).toBe('rm -rf build')
    expect(allow('s2', { description: 'Write /etc/hosts', question: 'Allow?' })).toBe('Write /etc/hosts')
    expect(allow('s3', { question: 'Allow?', reason: 'Dangerous' })).toBeNull()
  })
  it('names what Allow session and Always allow cover from the Agent\'s keys, and nothing for a one-time prompt (TAL-974)', () => {
    const pending = new PendingPrompts(new SessionEventBus())
    const scope = (sid: string, approval: Record<string, unknown>) => { pending.submitApproval(sid, { approval_id: 'a', ...approval }); return pending.approvalPending(sid).pending?.scope }
    // The shared fixture both clients render: its scope is this server's output for its keys.
    for (const { pending: head } of scopeFixture) {
      const { scope: expected, ...raw } = head
      expect(scope(String(raw.approval_id), raw), String(raw.approval_id)).toEqual(expected)
    }
    expect(scope('shell-2', { description: 'recursive delete; pipe to shell', pattern_keys: ['recursive delete', 'pipe to shell'] })).toMatchObject({ kind: 'command_pattern', subject: 'recursive delete; pipe to shell' })
    expect(scope('named-rule', { command: '<x>', tool_name: 'web_fetch', pattern_keys: ['plugin_rule:custom'] })).toMatchObject({ kind: 'tool_rule', subject: 'web_fetch' })
    expect(scope('cmd-rule', { command: '<deploy> (plugin approval rule)', pattern_keys: ['plugin_rule:custom'] })).toMatchObject({ kind: 'tool_rule', subject: 'deploy' })
    expect(scope('no-keys', { command: 'pwd' })).toBeNull()
    // Always saves the shell key permanently, so a finding beside it never makes the scope read as session-only.
    expect(scope('mixed', { description: 'pipe to shell; homograph URL', pattern_keys: ['pipe to shell', 'tirith:homograph_url'] }))
      .toEqual({ kind: 'command_pattern', subject: 'pipe to shell', always_is_session_only: false })
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
    expect(drain(sub)).toEqual([{ pending: null, pending_count: 0, withdrawn: null }])

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
    expect(drain(sub)).toEqual([{ pending: null, pending_count: 0, withdrawn: null }])

    pending.clearClarifies('s1')
    drain(sub)
    pending.submitClarify('s1', { question: 'Third?' })
    expect(drain(sub)).toHaveLength(1)
  })

  describe('approval explanations (TAL-2022)', () => {
    afterEach(() => { stubDisplaySettings({}) })

    it('drops a resolved approval\'s summary, so the same id asked again is explained again', async () => {
      stubDisplaySettings({ explain_approvals: true })
      const pending = new PendingPrompts(new SessionEventBus())
      const explain = vi.fn(() => Promise.resolve('Prints the working folder.'))
      pending.setApprovalExplainer({ explain, explained: vi.fn() })
      pending.submitApproval('s', { approval_id: 'a', command: 'pwd' })
      await vi.waitFor(() => { expect(pending.approvalPending('s').pending?.explanation).toEqual({ state: 'ready', text: 'Prints the working folder.' }) })
      pending.resolveApproval('s', 'a')
      pending.submitApproval('s', { approval_id: 'a', command: 'pwd' })
      expect(pending.approvalPending('s').pending?.explanation).toEqual({ state: 'pending' })
      expect(explain).toHaveBeenCalledTimes(2)
    })
  })
})
