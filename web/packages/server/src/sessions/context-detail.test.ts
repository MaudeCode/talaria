import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ContextDetailSchema } from '@maudecode/talaria-web-contracts'
import { bootTestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'

const fixture = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/sidecar/context-detail.json', import.meta.url), 'utf8')) as Record<string, { result: unknown }[]>
const detail = ContextDetailSchema.parse(fixture['chat.context_detail']![0]!.result)

describe('context detail read boundary', () => {
  it('routes only the visible resident session and returns the shared typed metadata without a turn', async () => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    try {
      const session = await s.deps.sessions.create({ model: 'fixture-model' })
      sidecar.respond('chat.context_detail', (params) => {
        expect(params).toMatchObject({ session_id: session.session_id, profile_home: s.state, model: 'fixture-model', workspace: session.workspace })
        return detail
      })
      const res = await s.get(`/api/session/context-detail?session_id=${session.session_id}`)
      expect(res.status).toBe(200)
      expect(ContextDetailSchema.parse(await res.json())).toEqual(detail)
      const missing = await s.get('/api/session/context-detail?session_id=missing')
      expect(missing.status).toBe(404)
      expect(sidecar.calls.filter((c) => c.method === 'chat.context_detail')).toHaveLength(1)
      expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toHaveLength(0)
    } finally { await s.close() }
  })

  it.each(['model', 'compression', 'delete', 'profile'] as const)('discards delayed metadata after %s changes', async (change) => {
    const sidecar = new FakeSidecar()
    const s = await bootTestServer({ sidecar })
    try {
      const session = await s.deps.sessions.create({ model: 'fixture-model' })
      sidecar.respond('chat.context_detail', async () => {
        if (change === 'model') session.model = 'different-model'
        else if (change === 'compression') session.context_messages = [{ role: 'user', content: 'compressed' }]
        else if (change === 'profile') session.profile = 'foreign'
        else await s.deps.sessionStore.delete(session.session_id)
        return detail
      })
      const result = await s.deps.sessions.contextDetail(session.session_id)
      expect(result.available).toBe(false)
      expect(result.categories).toEqual([])
      expect(result.files).toEqual([])
    } finally { await s.close() }
  })
})
