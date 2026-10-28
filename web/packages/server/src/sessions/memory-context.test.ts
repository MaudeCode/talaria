import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootTestServer, openStateDb } from '../test/harness.js'
import { hydrateAnchorActivityScenes } from './anchor.js'
import { messageIdentity, messageText, mergeDisplayMessagesAfterAgentResult, sanitizeMessagesForApi } from './merge.js'
import { stateDbSessionMessages } from './state-db.js'
import type { Message } from './session.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/memory-context.json', import.meta.url), 'utf8')) as { id: number; session_id: string; role: string; content: string; timestamp: number }
const typed = 'What is in this picture?'
const memory = '<memory-context>\nprivate recalled context\n</memory-context>'
const image = (JSON.parse(fixture.content.slice(6)) as Record<string, unknown>[])[1]!
const project = (row: Message): Message => hydrateAnchorActivityScenes([row], {})[0] as Message

describe('recalled memory display (TAL-888)', () => {
  it('projects SessionDB multimodal backfill identically in terminal, reload and export without changing replay', async () => {
    const s = await bootTestServer()
    const path = join(s.state, 'state.db')
    const db = openStateDb(path)
    try {
      db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL)')
      db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run(fixture.id, fixture.session_id, fixture.role, fixture.content, fixture.timestamp)
      const [row] = stateDbSessionMessages(path, fixture.session_id) as Message[]
      expect(row).toBeDefined()
      const original = structuredClone(row!)
      const image = (row!.content as unknown[])[1]
      expect(messageText(project(row!).content)).toBe(typed)
      expect(messageIdentity(row)).toBe(messageIdentity({ role: 'user', content: typed }))
      expect((project(row!).content as unknown[])[1]).toEqual(image)
      const settled = mergeDisplayMessagesAfterAgentResult([], [], [row!, { role: 'assistant', content: 'A test image.' }], typed)
      expect(settled.filter((m) => m.role === 'user')).toHaveLength(1)
      expect(messageText(settled[0]!.content)).toBe(typed)

      const session = (await s.deps.sessionStore.newSession())
      session.messages = [row!, { role: 'assistant', content: 'A test image.', timestamp: 101 }]
      session.context_messages = structuredClone(session.messages)
      await s.deps.sessionStore.save(session)
      const terminal = (await s.deps.turns.publicTerminalSession(session))
      const response = await s.get(`/api/session?session_id=${session.session_id}`)
      expect(response.status).toBe(200)
      const { session: reloaded } = await response.json() as { session: { messages: Message[] } }
      const liveUser = (terminal.messages as Message[]).find((m) => m.role === 'user')!
      const savedUser = reloaded.messages.find((m) => m.role === 'user')!
      expect(liveUser.content).toEqual(savedUser.content)
      expect(messageText(savedUser.content)).toBe(typed)
      expect((savedUser.content as unknown[])[1]).toEqual(image)
      for (const format of ['html', 'markdown', 'json']) {
        const download = await s.get(`/api/session/export?session_id=${session.session_id}&format=${format}`)
        expect(download.status).toBe(200)
        const exported = await download.text()
        expect(exported).toContain(typed)
        expect(exported).not.toContain('prefers metric')
        expect(exported).not.toContain('memory-context')
      }
      expect(row).toEqual(original)
      expect(sanitizeMessagesForApi(session.context_messages, { preserveApiContent: true })[0]!.content).toEqual(original.content)
      expect(stateDbSessionMessages(path, fixture.session_id)[0]!.content).toEqual(original.content)
    } finally {
      db.close()
      await s.close()
    }
  })

  it.each([
    { name: 'image-only prompt', content: [image, { type: 'text', text: memory }], expected: [image] },
    { name: 'indented string prompt', content: `    code  \n\n${memory}`, expected: '    code  \n' },
    { name: 'indented multimodal prompt', content: [image, { type: 'text', text: `    code  \n\n${memory}` }], expected: [image, { type: 'text', text: '    code  \n' }] },
  ])('keeps $name visible and byte-faithful in public routes', async ({ content, expected }) => {
    const s = await bootTestServer()
    try {
      const session = (await s.deps.sessionStore.newSession())
      session.messages = [{ role: 'user', content }]
      await s.deps.sessionStore.save(session)
      const terminal = (await s.deps.turns.publicTerminalSession(session))
      expect((terminal.messages as Message[])[0]).toMatchObject({ content: expected, _display: 'row' })
      for (const path of ['/api/session', '/api/session/export']) {
        const response = await s.get(`${path}?session_id=${session.session_id}`)
        expect(response.status).toBe(200)
        const body = await response.json() as { session?: { messages: Message[] }; messages?: Message[] }
        const rows = body.session?.messages ?? body.messages
        expect(rows?.[0]).toMatchObject({ content: expected, _display: 'row' })
      }
      expect(session.messages[0]!.content).toEqual(content)
    } finally { await s.close() }
  })

  it('strips only user memory fences, including repeated and unclosed fences, preserving plugin text and other parts', () => {
    for (const content of [
      `${typed}\n${memory}`,
      [{ type: 'text', text: typed }, { type: 'text', text: memory }],
      [{ type: 'text', text: `${typed}\n${memory}\n<MEMORY-CONTEXT>more</MEMORY-CONTEXT>` }],
      [{ type: 'text', text: `${typed}\n<memory-context>unfinished` }],
    ]) {
      const row = { role: 'user', content }
      expect(messageText(project(row).content)).toBe(typed)
      expect(messageIdentity(row)).toBe(messageIdentity({ role: 'user', content: typed }))
      expect(project(project(row))).toEqual(project(row))
    }
    const plugin = { role: 'user', content: [{ type: 'text', text: 'Plugin context without a fence' }] }
    expect(project(plugin)).toEqual(plugin)
    expect(project({ role: 'user', content: [{ type: 'text', text: `${memory}Plugin context without a fence` }] })).toEqual(plugin)
    const ordinary = { role: 'user', content: '  indented text\n' }
    expect(project(ordinary)).toEqual(ordinary)
    const imageOnly = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'image' } }, { type: 'text', text: memory }] }
    expect(project(imageOnly).content).toEqual([imageOnly.content[0]])
    expect(messageIdentity(imageOnly)).toBe(messageIdentity({ role: 'user', content: [imageOnly.content[0]] }))
    for (const role of ['assistant', 'tool', 'system']) {
      const row = { role, content: memory }
      expect(project(row).content).toBe(memory)
    }
  })
})
