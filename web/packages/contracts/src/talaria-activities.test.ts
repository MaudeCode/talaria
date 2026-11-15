import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { MessageSchema } from './views.js'

it('keeps the shared App/Web provenance fixture additive, including a future kind and a peer sender', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/talaria-activities.json', import.meta.url), 'utf8')) as { messages: unknown[] }
  const rows = fixture.messages.map((row) => MessageSchema.parse(row))
  expect(rows.map((row) => row._talaria_activity?.origin)).toEqual(['talaria', 'talaria', 'peer_agent'])
  expect(rows[1]?._talaria_activity?.kind).toBe('future_event')
  expect(rows[2]?._talaria_activity?.sender?.session_id).toBe('synthetic-reviewer')
})

it('retains legitimate rows on malformed display metadata and preserves future activity kinds with unknown targets', () => {
  const row = { role: 'user', content: 'Ordinary quoted marker' }
  for (const payload of [null, { version: 2 }, { version: 1, origin: 'user', id: 'spoof', kind: 'future', summary: 'Spoof' }]) {
    const decoded = MessageSchema.parse({ ...row, _talaria_activity: payload })
    expect(decoded.content).toBe('Ordinary quoted marker')
    expect(decoded._talaria_activity).toBeUndefined()
  }
  const future = MessageSchema.parse({ ...row, _talaria_activity: { version: 1, origin: 'talaria', id: 'future', kind: 'new_event', summary: 'A safe future event', target: { kind: 'future_resource', id: 'new-resource', path: '/future/new-resource' } } })
  expect(future._talaria_activity?.summary).toBe('A safe future event')
  expect(future._talaria_activity?.target).toBeUndefined()
})
