import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test as base } from './fixtures'

const test = base.extend<{ approval: { send: (event: string, data: unknown) => void; responses: { choice: string }[] } }>({
  approval: async ({ page }, runFixture) => {
    const sid = 'approval-dismiss'
    await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
      session_id: sid, title: 'Clean the build', active_stream_id: 'approval-run', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true,
      transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Clean the build', _turn_id: 'approval-run' }],
    } } }))
    const sessionList = await page.request.get('/api/sessions')
    expect(sessionList.ok()).toBe(true)
    const metadata = await sessionList.json()
    await page.route(/\/api\/sessions(\?|$)/, (route) => route.fulfill({ json: { ...metadata, sessions: [{ session_id: sid, title: 'Clean the build', is_streaming: true, read_only: false, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, can_branch: true, source_kind: 'webui', is_messaging_session: false, sort_ts: 1, sidebar_group: 'recent' }], sidebar_groups: [{ kind: 'recent', title: 'Recent' }] } }))
    await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'approval-run', replay_available: false } }))
    const responses: { choice: string }[] = []
    await page.route('**/api/approval/respond', async (route) => {
      responses.push(route.request().postDataJSON())
      await route.fulfill({ json: { ok: true } })
    })
    const streams: ServerResponse[] = []
    let seq = 0
    const send = (event: string, data: unknown) => { seq += 1; for (const r of streams) r.write(`id: approval-run:${String(seq)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
      response.write(`id: approval-run:${String(++seq)}\nevent: token\ndata: ${JSON.stringify({ text: 'Cleaning up.' })}\n\n`)
      streams.push(response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
    try {
      await page.goto(`/session/${sid}`)
      await expect.poll(() => streams.length).toBeGreaterThan(0)
      await runFixture({ send, responses })
    } finally {
      for (const response of streams) response.end()
      await new Promise<void>((resolve) => server.close(() => { resolve() }))
    }
  },
})

test.use({ serviceWorkers: 'block' })

/** A dismissed approval card no longer answers Enter; the next approval shows again (TAL-503). */
test('dismissing an approval stops Enter from approving it; the next approval in the turn is visible', async ({ page, approval: { send, responses } }) => {
  const card = page.getByRole('alertdialog')
  send('approval', { approval_id: 'a1', command: 'rm -rf build' })
  await expect(card).toContainText('rm -rf build')
  await card.getByRole('button', { name: 'Dismiss approval' }).click()
  await expect(card).toHaveCount(0)
  await page.locator('body').press('Enter')
  send('approval', { approval_id: 'a2', command: 'rm -rf dist' })
  await expect(card).toContainText('rm -rf dist')
  expect(responses).toEqual([])
})

test('menu keyboard actions retain ownership while an approval is visible', async ({ page, approval: { send, responses } }, info) => {
  const card = page.getByRole('alertdialog')
  const screenshot = async (state: string) => {
    if (!process.env.TALARIA_APPROVAL_EVIDENCE_DIR) return
    mkdirSync(process.env.TALARIA_APPROVAL_EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: join(process.env.TALARIA_APPROVAL_EVIDENCE_DIR, `${info.project.name}-${state}.png`) })
  }
  send('approval', { approval_id: 'menu-approval', command: 'echo fixture' })
  await expect(card).toContainText('echo fixture')
  if (info.project.name !== 'mobile') {
    const actions = page.locator('.session-item[data-sid="approval-dismiss"]').getByRole('button', { name: 'Conversation actions' })
    await actions.focus()
    await page.keyboard.press('Enter')
    const rename = page.getByRole('menuitem', { name: 'Rename conversation', exact: true })
    await rename.focus()
    await screenshot('rename-menu')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Rename conversation' })).toBeVisible()
    await screenshot('rename-open')
    expect(responses).toEqual([])
    await page.keyboard.press('Escape')
  }
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'More options' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Allow session', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Always allow', exact: true })).toBeFocused()
  await screenshot('always-menu')
  await page.keyboard.press('Enter')
  await expect.poll(() => responses.map((response) => response.choice)).toEqual(['always'])
  await expect(card).toHaveCount(0)
})
