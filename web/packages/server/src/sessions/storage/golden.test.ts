import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { bootTestServer } from '../../test/harness.js'
import { Session } from '../session.js'

it('preserves baseline JSON bytes through save, shrink, compress, index and deletion', async () => {
  const server = await bootTestServer({ now: () => 1700000000 })
  try {
    const store = server.deps.sessionStore
    const session = new Session({ session_id: 'golden', created_at: 1699999990, updated_at: 1699999990, workspace: '/synthetic', title: 'Golden É', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }] }, { workspace: '/synthetic', model: 'synthetic-model' })
    const dir = join(server.state, 'sessions')
    const bytes = () => Object.fromEntries(readdirSync(dir).filter((n) => n.endsWith('.json') || n.endsWith('.bak')).sort().map((n) => [n, readFileSync(join(dir, n), 'utf8')]))
    await store.save(session)
    expect(bytes()).toMatchSnapshot('save')
    session.messages = session.messages.slice(0, 1)
    await store.save(session)
    expect(bytes()).toMatchSnapshot('shrink')
    session.compression_anchor_mode = 'manual'
    session.context_messages = [{ role: 'assistant', content: 'compressed context' }]
    await store.save(session)
    await store.writeIndex()
    expect(bytes()).toMatchSnapshot('compress and index')
    await store.delete(session.session_id)
    expect(bytes()).toMatchSnapshot('delete and tombstone')
  } finally { await server.close() }
})
