/** TAL-2684: `GET /api/session/bot-deliveries` serves the requesting profile's canonical Bot Chat list, read-only. */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SidecarResultInput } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

type Native = SidecarResultInput<'gateway.bot_deliveries'>
const shared = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/bot-deliveries.json', import.meta.url), 'utf8')) as Record<'available' | 'empty' | 'unavailable' | 'gateway_stopped' | 'not_bot_chat', unknown> & { native: Native }

describe('bot deliveries', () => {
  const sidecar = new FakeSidecar()
  let s: TestServer
  let answer: Native | Error
  beforeAll(async () => {
    s = await bootTestServer({ sidecar })
    mkdirSync(join(s.state, 'profiles', 'scout'), { recursive: true })
    // Only the default profile's home holds this Bot Chat; any other home answers as the sidecar does for a foreign chat.
    sidecar.respond('gateway.bot_deliveries', (params) => {
      if (params.profile_home !== s.state) return { state: 'not_bot_chat', reason: null, deliveries: [] }
      if (answer instanceof Error) throw answer
      return answer
    })
  })
  afterAll(() => s.close())

  const read = (cookie?: string) => s.get('/api/session/bot-deliveries?session_id=bot-chat-tip', cookie ? { headers: { cookie } } : {})
  const reads = () => sidecar.calls.filter((c) => c.method === 'gateway.bot_deliveries')

  it('maps the owner\'s rows to queued, running and waiting-on-user, newest first, leaving failed ones out', async () => {
    answer = shared.native
    const res = await read()
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toEqual(shared.available)
    expect(reads().at(-1)?.params).toEqual({ profile_home: s.state, session_id: 'bot-chat-tip' })
  })

  it('answers an empty list, an older Agent and a stopped gateway as their own states', async () => {
    const cases: [Native, unknown][] = [
      [{ state: 'available', reason: null, deliveries: [] }, shared.empty],
      [{ state: 'unsupported', reason: 'agent_unsupported', deliveries: [] }, shared.unavailable],
      [{ state: 'stopped', reason: 'stopped', deliveries: [] }, shared.gateway_stopped],
    ]
    for (const [native, expected] of cases) {
      answer = native
      expect(await (await read()).json()).toEqual(expected)
    }
  })

  it('serves another profile\'s Bot Chat to nobody but that profile', async () => {
    answer = shared.native
    expect(await (await read('hermes_profile=scout')).json()).toEqual(shared.not_bot_chat)
    expect((reads().at(-1)?.params as { profile_home?: string } | undefined)?.profile_home).toBe(join(s.state, 'profiles', 'scout'))
  })

  it('answers a transient owner failure with 503, never an empty list', async () => {
    for (const failure of [{ state: 'unavailable', reason: 'owner_connection_lost', deliveries: [] } as Native, new Error('sidecar restarting')]) {
      answer = failure
      const res = await read()
      expect(res.status).toBe(503)
      expect(await res.json()).not.toHaveProperty('deliveries')
    }
  })
})
