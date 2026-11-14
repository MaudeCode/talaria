/**
 * TAL-2232: `GET /api/activity/summary` lists the shared activity rows a client may show, waiting rows first, without
 * finished ones and without another person's rows under person isolation.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import type { ActivityState, ActivityStates } from '../sessions/notify/activity.js'

const ISSUER = 'https://identity.invalid'
const OIDC_ENV = { HERMES_WEBUI_OIDC_ISSUER: ISSUER, HERMES_WEBUI_OIDC_CLIENT_ID: 'synthetic-client', HERMES_WEBUI_OIDC_ALLOW_CLAIM: 'email_verified', HERMES_WEBUI_OIDC_ALLOW_VALUES: 'true', HERMES_WEBUI_OIDC_OWNER_CLAIM: 'groups', HERMES_WEBUI_OIDC_OWNER_VALUES: 'admins' }
const FIXTURE = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/activity-summary.json', import.meta.url), 'utf8')) as unknown

let s: TestServer | null = null
let states: MockInstance<ActivityStates['states']> | null = null
afterEach(async () => { await s?.close(); s = null })

function row(sessionId: string, phase: string, startedAt: number, extra: Partial<ActivityState> = {}): ActivityState {
  return { sessionId, streamId: `stream-${sessionId}`, title: `Chat ${sessionId}`, phase, startedAt, updatedAt: 1_800_000_000_000, deepLink: `/sessions/${sessionId}`, alertEligible: true, origin: 'user', ownerPersonId: null, ...extra }
}

/** One row per phase the ticket names; the approval row started first, so only the phase can put it on top. */
const ROWS = [
  row('run_old', 'running', 1_799_999_000_000),
  row('done', 'completed', 1_799_999_900_000),
  row('approval', 'waiting_for_approval', 1_799_998_000_000, { approvalHeadId: 'digest', approvalId: 'appr-1' }),
  row('run_new', 'running', 1_799_999_500_000, { toolCount: 3, activityAt: 1_799_999_600_000 }),
  row('input', 'waiting_for_input', 1_799_998_500_000),
]

async function boot(rows: ActivityState[], env: Record<string, string> = {}): Promise<TestServer> {
  s = await bootTestServer({ env, deps: (deps) => {
    deps.oidc.sessionBindingIsCurrent = () => Promise.resolve(true)
    states = vi.spyOn(deps.activity, 'states').mockResolvedValue(rows)
  } })
  return s
}

async function summary(server: TestServer, headers: Record<string, string> = {}): Promise<{ running_count: number; waiting_count: number; rows: { session_id: string }[] }> {
  const response = await server.get('/api/activity/summary', { headers })
  expect(response.status).toBe(200)
  return (await response.json()) as never
}

it('lists waiting rows first, then running ones newest first, without the finished one', async () => {
  const body = await summary(await boot(ROWS))
  expect(body.rows.map((r) => r.session_id)).toEqual(['approval', 'input', 'run_new', 'run_old'])
  expect([body.waiting_count, body.running_count]).toEqual([2, 2])
  // The shared fixture is this response, which the contract and TalariaKit tests decode.
  expect(body).toEqual(FIXTURE)
})

it('reads a named profile, except another one from a login bound to its own', async () => {
  const server = await boot(ROWS)
  expect((await server.get('/api/activity/summary?profile=work')).status).toBe(200)
  expect(states?.mock.lastCall?.[0]).toBe('work')
  const bound = { cookie: `${server.deps.auth.cookieName()}=${server.deps.auth.createSession({ boundProfile: 'work' })}` }
  expect((await server.get('/api/activity/summary?profile=default', { headers: bound })).status).toBe(403)
  expect((await server.get('/api/activity/summary', { headers: bound })).status).toBe(200)
  expect(states?.mock.lastCall?.[0]).toBe('work')
})

it('masks a credential in a title as the session list does', async () => {
  const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
  const body = await summary(await boot([row('leaky', 'running', 1_000, { title: `deploy with ${secret}` })])) as unknown as { rows: { title: string }[] }
  expect(body.rows[0]!.title).not.toContain(secret)
  expect(body.rows[0]!.title).toMatch(/^deploy with /)
})

describe('person isolation', () => {
  function signIn(server: TestServer, subject: string, owner = false): Record<string, string> {
    const cookie = server.deps.auth.createSession({ authType: 'oidc', username: `${subject}@example.invalid`, oidcBinding: { issuer: ISSUER, subject, ...(owner ? { owner: true } : {}) } })
    return { cookie: `${server.deps.auth.cookieName()}=${cookie}` }
  }
  async function personId(server: TestServer, headers: Record<string, string>): Promise<string> {
    return ((await (await server.get('/api/auth/status', { headers })).json()) as { person: { id: string } }).person.id
  }

  it.each([true, false])('with isolation %s, hides a person\'s row from everyone else only while isolation is on', async (isolation) => {
    const rows = [row('legacy', 'running', 1_000)]
    const server = await boot(rows, { ...OIDC_ENV, ...(isolation ? { HERMES_WEBUI_PERSON_ISOLATION: '1' } : {}) })
    const alice = signIn(server, 'alice')
    const bob = signIn(server, 'bob')
    const owner = signIn(server, 'olive', true)
    if (isolation) rows.push(row('alice_chat', 'running', 2_000, { ownerPersonId: await personId(server, alice) }))
    else rows.push(row('alice_chat', 'running', 2_000, { ownerPersonId: 'oidc:someone' }))
    const seen = async (headers: Record<string, string>): Promise<string[]> => (await summary(server, headers)).rows.map((r) => r.session_id)
    expect(await seen(alice)).toEqual(isolation ? ['alice_chat'] : ['alice_chat', 'legacy'])
    expect(await seen(bob)).toEqual(isolation ? [] : ['alice_chat', 'legacy'])
    expect(await seen(owner)).toEqual(isolation ? ['legacy'] : ['alice_chat', 'legacy'])
  })
})
