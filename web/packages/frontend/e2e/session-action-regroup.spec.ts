import { createServer, type ServerResponse } from 'node:http'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

// TAL-1119: a background refresh that moves a row to another date group keeps its open dialog and draft.
test('Move to project stays open with its choice when the row moves from Older to Today', async ({ page }, testInfo) => {
  let stream: ServerResponse | undefined
  const events = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write('retry: 100\n\nevent: initial\ndata: {"stream":"sessions"}\n\n')
    stream = response
  })
  await new Promise<void>((resolve) => events.listen(0, '127.0.0.1', resolve))
  const address = events.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const now = Math.floor(Date.now() / 1000)
  const row = (session_id: string, title: string, sort_ts: number) => ({
    session_id, title, updated_at: sort_ts, sort_ts, last_message_at: sort_ts,
    pinned: false, archived: false, project_id: null, is_streaming: false, attention: null,
    is_cli_session: false, source_kind: 'webui', is_messaging_session: false, read_only: false,
    can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true,
  })
  let oldTs = now - 30 * 86_400
  await page.route('**/api/sessions/events*', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}/` }))
  await page.route(/\/api\/sessions(\?|$)/, (route) => route.fulfill({ json: { sessions: [row('regroup-fresh', 'Fresh chat', now), row('regroup-old', 'Old chat', oldTs)] } }))
  await page.route(/\/api\/projects(\?|$)/, (route) => route.fulfill({ json: { projects: [{ project_id: 'regroup-p', name: 'Regroup project', color: null }] } }))
  try {
    await page.goto('/')
    await settle(page)
    const hamburger = page.locator('#btnHamburger')
    if (await hamburger.isVisible()) await hamburger.click()
    // Phones hide the row's actions column until TAL-699 adds the row's long-press entry; reveal it to reach the same menu.
    if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) await page.addStyleTag({ content: '.session-actions{display:flex !important;opacity:1 !important}' })
    const item = page.locator('#sessionList .session-item[data-sid="regroup-old"]')
    const group = page.locator('#sessionList .session-date-group', { has: page.locator('.session-item[data-sid="regroup-old"]') }).locator('.session-date-header')
    await expect(group).toContainText('Older')
    await item.hover()
    await item.getByRole('button', { name: 'Conversation actions' }).click()
    await page.getByRole('menuitem', { name: 'Move to project' }).click()
    const dialog = page.getByRole('dialog', { name: 'Move to project' })
    await dialog.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Regroup project' }).click()
    await expect(dialog.getByRole('combobox')).toHaveText(/Regroup project/)
    await page.screenshot({ path: testInfo.outputPath('before-regroup.png') })
    oldTs = now
    await expect.poll(() => !!stream).toBe(true)
    stream!.write('event: sessions_changed\ndata: {}\n\n')
    await expect(group).toContainText('Today')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('combobox')).toHaveText(/Regroup project/)
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('after-regroup.png') })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(item.getByRole('button', { name: 'Conversation actions' })).toBeFocused()
  } finally {
    await page.close()
    stream?.end()
    events.closeAllConnections()
    await new Promise<void>((resolve, reject) => events.close((error) => error ? reject(error) : resolve()))
  }
})
