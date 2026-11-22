/**
 * TAL-2641: a native-owner chat's handoff to a messaging platform, decided by the server from its own owner's answer. A
 * synthetic owner answers the sidecar's handoff actions; no messaging account or gateway is involved.
 */
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GatewaySessionParams, GatewaySessionResult, SessionHandoff } from '@maudecode/talaria-web-contracts'
import type { TestServer } from '../test/harness.js'
import type { FakeSidecar } from '../sidecar/fake.js'
import { attached, bootOwnerAttachment, ownerHelpers, sid, snapshot } from '../test/gateway-owner.js'

type Handoff = NonNullable<GatewaySessionResult['handoff']>
/** The shared views this server produces; Web and the App read them (TAL-2311). */
const views = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/native-handoff.json', import.meta.url), 'utf8')) as Record<
  'read' | 'queued' | 'unknown' | 'refused' | 'not_pending' | 'failed' | 'unsupported' | 'no_destination', SessionHandoff>
const bare = { reason: null, snapshot: null, receipt: null }
const record = (extra: Partial<Handoff> = {}): Handoff => ({ session_id: sid, destinations: [{ platform: 'telegram', home_name: 'Phone' }],
  state: '', platform: null, error: null, outcome: null, refusal: null, home_name: null, ...extra })

describe('native owner handoff (TAL-2641)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  let answer: (params: GatewaySessionParams) => GatewaySessionResult
  beforeEach(async () => {
    ({ s, db, sidecar } = await bootOwnerAttachment())
    answer = () => ({ state: 'attached', ...bare, handoff: record() })
    sidecar.respond('gateway.session', (params) => params.action.startsWith('handoff_') ? answer(params) : attached(snapshot()))
  })
  afterEach(async () => { db.close(); await s.close() })
  const { post } = ownerHelpers(() => ({ s, sidecar }))
  const handoff = async (body: unknown, status = 200) => {
    const response = await post('/api/session/native-handoff', body)
    expect(response.status, await response.clone().text()).toBe(status)
    return await response.json() as SessionHandoff
  }
  const calls = () => sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as GatewaySessionParams).action.startsWith('handoff_'))
    .map((c) => c.params as GatewaySessionParams)

  it('shows the configured destination before any request and asks the owner only to read', async () => {
    expect(await handoff({ session_id: sid, action: 'read' })).toEqual(views.read)
    expect(calls()).toEqual([{ action: 'handoff_state', session_id: sid, profile_home: s.deps.profileHome('default') }])
  })

  it('sends a request once to the owner and shows its queued handoff as cancellable', async () => {
    answer = (params) => ({ state: 'attached', ...bare, handoff: record({ outcome: 'queued', home_name: 'Phone', state: 'pending', platform: params.platform! }) })
    expect(await handoff({ session_id: sid, action: 'request', platform: 'telegram' })).toEqual(views.queued)
    expect(calls().map((p) => [p.action, p.platform])).toEqual([['handoff_request', 'telegram']])
  })

  it('keeps an unanswered request unknown, never resent and never cancellable', async () => {
    answer = () => ({ state: 'unavailable', ...bare, reason: 'owner_connection_lost' })
    expect(await handoff({ session_id: sid, action: 'request', platform: 'telegram' })).toEqual(views.unknown)
    expect(calls()).toHaveLength(1)
  })

  it('words a durable-work refusal as the owner gave it and leaves the chat requestable once settled', async () => {
    answer = () => ({ state: 'attached', ...bare, handoff: record({ outcome: 'refused', refusal: 'unknown_execution' }) })
    expect(await handoff({ session_id: sid, action: 'request', platform: 'telegram' })).toEqual(views.refused)
  })

  it('leaves a handoff the gateway claimed to the gateway when a cancel arrives late', async () => {
    answer = () => ({ state: 'attached', ...bare, handoff: record({ outcome: 'not_pending', state: 'running', platform: 'telegram' }) })
    expect(await handoff({ session_id: sid, action: 'cancel' })).toEqual(views.not_pending)
    expect(calls().map((p) => p.action)).toEqual(['handoff_fail'])
  })

  it('shows the gateway failure and offers the request again', async () => {
    answer = () => ({ state: 'attached', ...bare, handoff: record({ state: 'failed', platform: 'telegram', error: "platform 'telegram' is not active in this gateway" }) })
    expect(await handoff({ session_id: sid, action: 'read' })).toEqual(views.failed)
  })

  it.each([
    [{ state: 'incompatible' as const, ...bare, reason: 'owner_handoff_unsupported' }, 'unsupported' as const],
    [{ state: 'attached' as const, ...bare, handoff: record({ destinations: [] }) }, 'no_destination' as const],
  ])('offers no request when the owner cannot deliver one (%#)', async (result, reason) => {
    answer = () => result
    expect(await handoff({ session_id: sid, action: 'read' })).toEqual(views[reason])
  })

  it('reaches no owner for a chat without one or a malformed request', async () => {
    expect(await handoff({ session_id: 'web-chat-without-owner', action: 'read' })).toMatchObject({ available: false, unavailable_reason: 'not_owned', state: 'none' })
    await handoff({ session_id: sid, action: 'request', platform: 'Telegram' }, 400)
    await handoff({ session_id: sid, action: 'read', platform: 'telegram' }, 400)
    expect(calls()).toEqual([])
  })
})
