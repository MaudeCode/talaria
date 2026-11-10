import { readFileSync } from 'node:fs'
import type { GatewaySnapshot } from '@maudecode/talaria-web-contracts'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import type { StreamFrame } from '../../server/dist/sidecar/client.js'
import { openStateDb } from './server'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

// The same real server/stream boundary as agent-notices.spec.ts. The browser never mocks a launch or its result.
test('native side work reaches the existing composer panels without adding a parent turn (TAL-1340)', async ({ page }, testInfo) => {
  const fixture = JSON.parse(readFileSync(new URL('../../server/src/test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: { cli: string }; schema: string[]; inserts: string[] }
  const sid = fixture.sessions.cli
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const db = openStateDb(server.state)
  const snap: GatewaySnapshot = { session_id: sid, stored_session_id: sid, messages: [{ role: 'user', content: 'Check the project' }, { role: 'assistant', content: 'The project is ready.' }],
    message_count: 2, running: false, authority_epoch: 1, replay_epoch: 'side-owner', last_sequence: 0, subscription_id: 'viewer', revision: 1, execution_generation: 0,
    pending: [], prompts: [], info: { title: 'Project status', model: 'native-model' } }
  const attached = () => ({ state: 'attached' as const, reason: null, snapshot: snap, receipt: null })
  let emit!: (frame: Omit<StreamFrame, 'seq'>) => void
  let disconnect!: () => void
  let task = 0
  let sequence = 0
  sidecar.respond('gateway.session', (params, send, opts) => {
    if (params.action === 'work_list') return { ...attached(), work: { authority_epoch: 1, processes: [], subagents: [] } }
    if (params.action === 'launch_background' || params.action === 'launch_btw') return { ...attached(), launch: { state: 'accepted', task_id: `side-${++task}` } }
    if (params.action !== 'watch') return attached()
    emit = send
    send({ event: 'snapshot', data: attached() })
    return new Promise((resolve) => {
      disconnect = () => { resolve({ state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: null }) }
      opts.signal!.addEventListener('abort', () => { resolve(attached()) }, { once: true })
    })
  })
  const complete = (kind: string, text: string) => { emit({ event: 'event', data: { type: `${kind}.complete`, session_id: sid, authority_epoch: 1, replay_epoch: 'side-owner', seq: ++sequence, payload: { task_id: `side-${task}`, text } } }) }
  const viewports = process.env.TAL1340_SHOTS ? [
    ['desktop', 1280, 800], ['outer-portrait', 382, 580], ['outer-landscape', 594, 368],
    ['inner-split', 385, 571], ['inner-portrait', 669, 867], ['inner-landscape', 951, 585],
  ] as const : [[testInfo.project.name, testInfo.project.use.viewport!.width, testInfo.project.use.viewport!.height]] as const
  const shot = async (name: string) => {
    for (const [pose, width, height] of viewports) {
      await page.setViewportSize({ width, height })
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => { resolve() }))))
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity))
      if (name !== 'before') {
        const work = name === 'background-result'
        const dialog = page.getByRole('dialog', { name: work ? 'Background work' : 'Side question — not in history' })
        if (!await dialog.isVisible()) await page.locator(`[data-notice="${work ? 'background' : 'btw'}"]`).getByRole('button', { name: work ? 'Background work · 1' : /Side question/ }).click()
        if (work && await dialog.getByRole('button', { name: 'Show result' }).isVisible()) await dialog.getByRole('button', { name: 'Show result' }).click()
        await expect(dialog).toContainText(work ? 'The logs are clean.' : name === 'side-question' ? 'It means the project is healthy.' : 'Outcome unknown')
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false)
      if (process.env.TAL1340_SHOTS) await page.screenshot({ path: `${process.env.TAL1340_SHOTS}/${name}-${pose}.png`, animations: 'disabled' })
    }
  }
  try {
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    await server.deps.settings.save({ show_cli_sessions: true })
    await page.unroute('**/api/background/tasks?**')
    await page.goto(`${server.base}/session/${sid}`)
    await expect(page.locator('#messages')).toContainText('The project is ready.')
    await expect.poll(() => Boolean(emit)).toBe(true)
    await shot('before')
    await page.locator('#msg').fill('/background Check the logs')
    await page.locator('#btnSend').click()
    const background = page.locator('[data-notice="background"]').getByRole('button', { name: 'Background work · 1' })
    await expect(background).toBeVisible()
    await expect.poll(() => task).toBe(1)
    complete('background', 'The logs are **clean**.')
    await background.click()
    const work = page.getByRole('dialog', { name: 'Background work' })
    await work.getByRole('button', { name: 'Show result' }).click()
    await expect(work).toContainText('The logs are clean.')
    await shot('background-result')
    await page.keyboard.press('Escape')
    await page.locator('#msg').fill('/btw What does this mean?')
    await page.locator('#btnSend').click()
    await expect.poll(() => task).toBe(2)
    complete('btw', 'It means the project is **healthy**.')
    await page.locator('[data-notice="btw"]').getByRole('button', { name: /Side question/ }).click()
    const question = page.getByRole('dialog', { name: 'Side question — not in history' })
    await expect(question).toContainText('It means the project is healthy.')
    await shot('side-question')
    await page.keyboard.press('Escape')
    await page.locator('#msg').fill('/btw What if the owner disconnects?')
    await page.locator('#btnSend').click()
    await expect.poll(() => task).toBe(3)
    disconnect()
    await page.locator('[data-notice="btw"]').getByRole('button', { name: /Side question/ }).click()
    await expect(question).toContainText('Outcome unknown')
    await shot('unknown-side-question')
    expect(task).toBe(3)
    await expect(page.locator('#messages')).not.toContainText('What does this mean?')
    expect(sidecar.calls.filter((call) => call.method === 'chat.start')).toEqual([])
    expect(server.deps.registry.activeRunStreamForSession(sid)).toBeNull()
  } finally { await page.goto('about:blank'); db.close(); await server.close() }
})
