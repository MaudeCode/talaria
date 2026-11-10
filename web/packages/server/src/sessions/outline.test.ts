import { useJsonStorage } from '../test/storage.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionOutline } from '@maudecode/talaria-web-contracts'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { Session } from './session.js'
import { outlineExcerpt } from './outline.js'

useJsonStorage()

const SECRET = 'ghp_abcdefghij0123456789'

describe('GET /api/session/outline (TAL-2152)', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(async () => { await s.close() })

  const seeded = async (sid: string, messages: Record<string, unknown>[]) => {
    await s.deps.sessionStore.save(new Session({ session_id: sid, messages }, { workspace: s.state, model: null }))
    return sid
  }
  const outline = async (sid: string) => {
    const response = await s.get(`/api/session/outline?session_id=${sid}`)
    expect(response.status).toBe(200)
    return (await response.json()) as SessionOutline
  }

  it('lists every question oldest first, at the index its transcript page reads, with a redacted Markdown-free excerpt', async () => {
    const sid = await seeded('outline-basic', [
      { role: 'user', content: '## Plan **the** `release`\nsecond line', message_id: 'u1', timestamp: 10 },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{}' } }], timestamp: 11 },
      { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(10_000), timestamp: 12 },
      { role: 'assistant', content: 'done', timestamp: 13 },
      { role: 'user', content: `\n\nuse this key ${SECRET} please`, message_id: 'u2', timestamp: 20 },
      { role: 'assistant', content: 'ok', timestamp: 21 },
      { role: 'user', content: 'a'.repeat(300), timestamp: 30 },
      { role: 'user', content: '```ts\nconst x = 1\n```', message_id: 'u4', timestamp: 40 },
    ])
    const { entries, shown, shown_after } = await outline(sid)
    expect([shown, shown_after]).toEqual([true, 0])
    expect(entries).toEqual([
      { message_id: 'u1', index: 0, excerpt: 'Plan the release', created_at: 10 },
      { message_id: 'u2', index: 4, excerpt: 'use this key ghp_ab...6789 please', created_at: 20 },
      { message_id: '6-user', index: 6, excerpt: `${'a'.repeat(119)}…`, created_at: 30 },
      { message_id: 'u4', index: 7, excerpt: 'const x = 1', created_at: 40 },
    ])
    // Each index is the `msg_before` coordinate: the page ending just past it ends with that question.
    for (const entry of entries) {
      const page = await s.deps.sessions.detail(sid, { msg_limit: '1', msg_before: String(entry.index + 1) })
      expect(page._messages_offset).toBe(entry.index)
      expect((page.messages as { role: string }[]).at(-1)?.role).toBe('user')
    }
  })

  it('leaves the credential in place when redaction is off', async () => {
    await s.deps.settings.save({ api_redact_enabled: false })
    try {
      const { entries } = await outline(await seeded('outline-unredacted', [{ role: 'user', content: `key ${SECRET}`, timestamp: 1 }]))
      expect(entries.map((e) => e.excerpt)).toEqual([`key ${SECRET}`])
    } finally { await s.deps.settings.save({ api_redact_enabled: true }) }
  })

  it('counts a steer as a question, and shows only from four questions', async () => {
    const { entries, shown, shown_after } = await outline(await seeded('outline-steer', [
      { role: 'user', content: 'Start the audit', timestamp: 1 },
      { role: 'assistant', content: 'Reading.', timestamp: 2 },
      { role: 'user', content: 'Also check the sidebar', _steer: { steer_id: 's1' }, timestamp: 3 },
      { role: 'assistant', content: 'Done.', timestamp: 4 },
    ]))
    expect(entries.map(({ index, excerpt }) => [index, excerpt])).toEqual([[0, 'Start the audit'], [2, 'Also check the sidebar']])
    expect([shown, shown_after]).toEqual([false, 2])
  })

  it('skips compaction markers and keeps the questions on both sides of a compaction', async () => {
    const { entries } = await outline(await seeded('outline-compacted', [
      { role: 'user', content: 'Before the compaction', timestamp: 1 },
      { role: 'assistant', content: 'One.', timestamp: 2 },
      { role: 'marker', content: 'Summary of the earlier turns', message_id: 'm1', timestamp: 3 },
      { role: 'user', content: '[CONTEXT COMPACTION] earlier turns were summarized', timestamp: 4 },
      { role: 'user', content: 'After the compaction', timestamp: 5 },
      { role: 'assistant', content: 'Two.', timestamp: 6 },
    ]))
    expect(entries.map(({ index, excerpt }) => [index, excerpt])).toEqual([[0, 'Before the compaction'], [4, 'After the compaction']])
  })

  it('answers an empty list for a chat with no questions', async () => {
    expect((await outline(await seeded('outline-empty', [{ role: 'assistant', content: 'Hello.', timestamp: 1 }]))).entries).toEqual([])
  })

  it('joins inline formatting to the words around it', () => {
    expect(outlineExcerpt({ role: 'user', content: '**Done**: shipped [it](https://example.com), _mostly_.' })).toBe('Done: shipped it, mostly.')
  })

  it('reads only the start of a huge one-line question', () => {
    const started = performance.now()
    expect(outlineExcerpt({ role: 'user', content: `**Huge** ${'b'.repeat(16_000_000)}` })).toBe(`Huge ${'b'.repeat(114)}…`)
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('names the files of an attachment-only question', () => {
    expect(outlineExcerpt({ role: 'user', content: '', attachments: [{ name: 'plan.pdf' }, { name: 'shot.png' }] })).toBe('plan.pdf, shot.png')
  })
})
