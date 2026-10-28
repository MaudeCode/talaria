import { readFileSync } from 'node:fs'
import type { GatewaySnapshot } from '@maudecode/talaria-web-contracts'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import type { StreamFrame } from '../../server/dist/sidecar/client.js'
import { expect, test } from './fixtures'
import { openStateDb } from './server'

test.use({ serviceWorkers: 'block' })

test('native plan restores, follows another viewer, reconnects and clears through the existing Todos page', async ({ page, context }, testInfo) => {
  const ownership = JSON.parse(readFileSync(new URL('../../server/src/test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: { cli: string }; schema: string[]; inserts: string[] }
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/web-native-todos.json', import.meta.url), 'utf8')) as { owner: NonNullable<GatewaySnapshot['todo_state']> }
  const sid = ownership.sessions.cli
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const db = openStateDb(server.state)
  let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
  let aborted = false
  const snap: GatewaySnapshot = { session_id: sid, stored_session_id: sid, messages: [], message_count: 0, running: false,
    authority_epoch: 1, replay_epoch: 'owner-epoch', last_sequence: 0, subscription_id: 'viewer', revision: 1,
    execution_generation: 1, pending: [], prompts: [], info: { title: 'Owner plan' }, todo_state: fixture.owner }
  const attached = () => ({ state: 'attached' as const, reason: null, snapshot: snap, receipt: null })
  sidecar.respond('gateway.session', (params, send, opts) => {
    if (params.action !== 'watch') return attached()
    emit = send
    send({ event: 'snapshot', data: attached() })
    return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { aborted = true; resolve(attached()) }, { once: true }) })
  })
  await context.addInitScript((id) => { if (location.protocol === 'http:') localStorage.setItem('hermes-webui-session', id) }, sid)
  const second = await context.newPage()
  const shot = async (name: string) => {
    if (process.env.TAL1314_SHOTS) await page.screenshot({ path: `${process.env.TAL1314_SHOTS}/${name}-${testInfo.project.name}.png` })
  }
  try {
    db.exec(ownership.schema.join('\n'))
    for (const sql of ownership.inserts) db.exec(sql)
    await server.deps.settings.save({ show_cli_sessions: true })
    await page.goto(`${server.base}/todos`)
    await expect(page.getByRole('heading', { name: 'Todos' })).toBeVisible()
    if (process.env.TAL1314_BASELINE) await shot('before')
    await expect(page.getByText('Owner task', { exact: true })).toBeVisible()
    await expect(page.getByText('Finished task', { exact: true })).toHaveClass(/line-through/)
    await shot('attached')
    await second.goto(`${server.base}/todos`)
    await expect(second.getByText('Owner task', { exact: true })).toBeVisible()
    await expect.poll(() => Boolean(emit)).toBe(true)
    const update = (seq: number, todos: Record<string, unknown>[]) => emit!({ event: 'event', data: { type: 'todo.updated', session_id: sid, authority_epoch: 1, replay_epoch: 'owner-epoch', execution_generation: 1, seq, payload: { todos, revision: seq + 3 } } })
    update(1, [{ id: 'next', content: 'Changed by another viewer', status: 'pending' }])
    for (const viewer of [page, second]) {
      await expect(viewer.getByText('Changed by another viewer', { exact: true })).toBeVisible()
      await expect(viewer.getByText('Owner task', { exact: true })).toHaveCount(0)
    }
    await shot('updated')
    await page.reload()
    await expect(page.getByText('Changed by another viewer', { exact: true })).toBeVisible()
    await shot('reconnected')
    update(2, [])
    for (const viewer of [page, second]) await expect(viewer.locator('#todoPanel')).toHaveCount(0)
    await shot('cleared')
    expect(server.deps.registry.activeRunStreamForSession(sid)).toBeNull()
    expect(sidecar.calls.filter((call) => call.method === 'gateway.session' && (call.params as { action: string }).action === 'watch')).toHaveLength(1)
    expect(sidecar.calls.some((call) => call.method === 'chat.start')).toBe(false)
    await page.goto('about:blank')
    expect(aborted).toBe(false)
    await second.close()
    await expect.poll(() => aborted).toBe(true)
  } finally {
    await second.close()
    await page.goto('about:blank')
    db.close()
    await server.close()
  }
})
