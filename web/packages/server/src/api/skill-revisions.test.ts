import { afterEach, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SkillRevisionsSchema } from '@maudecode/talaria-web-contracts'

let server: TestServer | undefined
afterEach(async () => { await server?.close() })

it('exposes read-only skill revision inspection independently of replay execution', async () => {
  server = await bootTestServer({ sidecar: new FakeSidecar() })
  const response = await server.get('/api/skills/revisions?name=demo')
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ state: 'unavailable', revisions: [], replay_available: false })
})

it('passes exact selections and profile scope to the backend and redacts display text', async () => {
  const sidecar = new FakeSidecar()
  const fixture = SkillRevisionsSchema.parse(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../..', 'contracts/fixtures/skill-revisions.json'), 'utf8')))
  sidecar.respond('skills.revisions', () => ({ ...fixture,
    selected: { revision: fixture.selected!.revision, content: 'api_key = synthetic-private-key-value' },
    comparison: { ...fixture.comparison!, diff: '+api_key = synthetic-private-key-value' } }))
  server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_TRUSTED_AUTH_HEADER: 'X-Remote-User', HERMES_WEBUI_TRUSTED_GROUPS_HEADER: 'X-Remote-Groups', HERMES_WEBUI_GROUP_PROFILE_MAP: '{"ops":"work"}' } })
  const selection = `revision=${fixture.selected!.revision}&compare_to=${fixture.comparison!.from_revision}`
  const response = await server.get(`/api/skills/revisions?name=demo&${selection}`, { headers: { 'X-Remote-User': 'kim', 'X-Remote-Groups': 'ops' } })
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result).toMatchObject({ revisions: fixture.revisions, replay_available: false })
  expect(JSON.stringify(result)).not.toContain('synthetic-private-key-value')
  expect(sidecar.calls.filter((c) => c.method === 'skills.revisions')).toEqual([{ method: 'skills.revisions', params: { profile_home: server.deps.profileHome('work'), name: 'demo', revision: fixture.selected!.revision, compare_to: fixture.comparison!.from_revision } }])
  expect(sidecar.calls.some((c) => c.method === 'aux.complete' || c.method === 'plugins.dashboard_request')).toBe(false)
})

it('refuses stale selections and malformed identities without replaying anything', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('skills.revisions', () => { throw new SidecarError('Revision no longer exists; reload history', { code: -32602, condition: 'invalid_params' }) })
  server = await bootTestServer({ sidecar })
  expect((await server.get(`/api/skills/revisions?name=demo&revision=${'0'.repeat(64)}`)).status).toBe(400)
  sidecar.calls.length = 0
  expect((await server.get('/api/skills/revisions?name=demo&revision=../../foreign')).status).toBe(400)
  expect(sidecar.calls).toEqual([])
})

it('keeps inspection honest with unavailable or older sidecars', async () => {
  const sidecar = new FakeSidecar()
  sidecar.respond('skills.revisions', () => { throw new SidecarError('Method not found', { code: -32601, condition: 'method_not_found' }) })
  server = await bootTestServer({ sidecar })
  const response = await server.get('/api/skills/revisions?name=demo')
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ state: 'unavailable', selected: null, comparison: null, replay_available: false })
  sidecar.status = 'stopped'
  expect(await (await server.get('/api/skills/revisions?name=demo')).json()).toMatchObject({ state: 'unavailable' })
})
