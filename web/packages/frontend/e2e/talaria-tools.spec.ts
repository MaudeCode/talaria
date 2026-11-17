import { readFileSync } from 'node:fs'
import type { GatewaySnapshot } from '@maudecode/talaria-web-contracts'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import type { StreamFrame } from '../../server/dist/sidecar/client.js'
import { expect, test } from './fixtures'
import { openStateDb } from './server'

test.use({ serviceWorkers: 'block' })

/** TAL-2317: the server classifies Talaria's own tools, so a row carries the Talaria mark and the tool's name, live and after reload. */
test('a Talaria tool row shows the Talaria mark and the tool name', async ({ page }, testInfo) => {
  const fixture = JSON.parse(readFileSync(new URL('../../server/src/test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: { cli: string }; schema: string[]; inserts: string[] }
  const sid = fixture.sessions.cli
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { TALARIA_WEB_SKIP_ONBOARDING: '1' } })
  const db = openStateDb(server.state)
  let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
  let snap: GatewaySnapshot = { session_id: sid, stored_session_id: sid, messages: [{ role: 'user', content: 'Which profiles are there?', message_id: 'native-input' }],
    message_count: 1, running: true, authority_epoch: 1, replay_epoch: 'owner-epoch', last_sequence: 0, subscription_id: 'viewer', revision: 1, execution_generation: 1,
    pending: [{ admission_id: 'native-input', sequence: 1, status: 'started', outcome: null, authority_epoch: 1, execution_generation: 1, text: 'Which profiles are there?' }], prompts: [], info: { title: 'Profiles' } }
  const attached = () => ({ state: 'attached' as const, reason: null, snapshot: snap, receipt: null })
  const send = (type: string, payload: Record<string, unknown>) => {
    emit!({ event: 'event', data: { type, payload, session_id: sid, authority_epoch: 1, replay_epoch: 'owner-epoch', execution_generation: 1 } })
  }
  sidecar.respond('gateway.session', (params, sendFrame, opts) => {
    if (params.action !== 'watch') return attached()
    emit = sendFrame
    sendFrame({ event: 'snapshot', data: attached() })
    return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached()) }, { once: true }) })
  })
  const shot = async (name: string) => {
    if (process.env.TAL2317_SHOTS) await page.screenshot({ path: `${process.env.TAL2317_SHOTS}/${name}-${testInfo.project.name}.png` })
  }
  try {
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    await server.deps.settings.save({ show_cli_sessions: true })
    await page.goto(`${server.base}/session/${sid}`)
    await expect.poll(() => Boolean(emit)).toBe(true)
    // A third-party tool keeps its name-token class beside it.
    send('tool.start', { tool_id: 'other', name: 'foo_list', args: {} })
    send('tool.complete', { tool_id: 'other', name: 'foo_list', preview: '[]' })
    send('tool.start', { tool_id: 'profiles', name: 'profile_list', args: {} })
    const row = page.locator('[data-tool-id="profiles"]')
    await expect(row).toHaveAttribute('data-tool-kind', 'talaria')
    // The live run folds its calls under their summary; open it to see each row.
    await page.getByRole('button', { name: 'Expand all' }).click()
    await expect(row.locator('.tool-card-icon [data-tool-brandmark]')).toBeVisible()
    await expect(row.locator('.tool-card-name')).toHaveText('Using profile_list')
    await expect(page.locator('[data-tool-id="other"]')).toHaveAttribute('data-tool-kind', 'list')
    await shot('running')
    send('tool.complete', { tool_id: 'profiles', name: 'profile_list', preview: '[]' })
    await expect(row.locator('.tool-card-name')).toHaveText('Used profile_list')
    await shot('done')
    await page.reload()
    await expect(row).toHaveAttribute('data-tool-kind', 'talaria')
    await page.getByRole('button', { name: 'Expand all' }).click()
    await expect(row.locator('.tool-card-icon [data-tool-brandmark]')).toBeVisible()
    await expect(row.locator('.tool-card-name')).toHaveText('Used profile_list')
  } finally {
    snap = { ...snap, running: false, pending: [] }
    await page.goto('about:blank')
    db.close()
    await server.close()
  }
})
