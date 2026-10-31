import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const started = '⚗ Reviewing this conversation in the background (focus: deploy steps) — any memory/skill updates will be reported when done.'

/** Records every chat turn the page starts, answering each with an error so none runs. */
async function noTurns(page: import('@playwright/test').Page): Promise<string[]> {
  const sent: string[] = []
  await page.route('**/api/chat/{steer,start}', (route) => { sent.push(route.request().url()); return route.fulfill({ status: 500, json: { error: 'not expected' } }) })
  await page.route('**/api/session/new', (route) => { sent.push(route.request().url()); return route.fulfill({ status: 500, json: { error: 'not expected' } }) })
  return sent
}

test('/refine in an open chat runs on the server and shows the review notice above the composer; no turn starts (TAL-902)', async ({ page }, testInfo) => {
  const sid = 'refine-chat'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Deploy', active_stream_id: null, is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true,
    transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Deploy with the blue script' }, { role: 'assistant', id: 2, content: 'Deployed.' }],
  } } }))
  const executed: unknown[] = []
  await page.route('**/api/commands/exec', (route) => { executed.push(route.request().postDataJSON()); return route.fulfill({ json: { output: started } }) })
  const sent = await noTurns(page)

  await page.goto(`/session/${sid}`)
  await expect(page.locator('#messages')).toContainText('Deployed.')
  await page.locator('#msg').fill('/refine deploy steps')
  await page.locator('#btnSend').click()
  await expect.poll(() => executed.length + sent.length).toBeGreaterThan(0)
  expect(sent).toEqual([])
  expect(executed).toEqual([{ command: '/refine deploy steps', session_id: sid }])
  // TAL-1078: the command is a chip over the composer; its output opens in a dialog.
  await page.locator('[data-notice="command"]').getByRole('button', { name: 'Command output: /refine deploy steps' }).click()
  await expect(page.getByRole('dialog', { name: 'Command output' }).getByRole('region', { name: 'Command output' })).toContainText('Reviewing this conversation in the background (focus: deploy steps)')
  await expect(page.locator('#messages')).not.toContainText('/refine')
  if (process.env.TAL902_SHOTS) await page.screenshot({ path: `${process.env.TAL902_SHOTS}/refine-started-${testInfo.project.name}.png` })
})

test('/refine before anything was said answers from the server without starting a chat (TAL-902)', async ({ page }, testInfo) => {
  const sent = await noTurns(page)
  await page.goto('/')
  await page.locator('#msg').fill('/refine')
  await page.locator('#btnSend').click()
  await page.locator('[data-notice="command"]').getByRole('button', { name: 'Command output: /refine' }).click()
  const panel = page.getByRole('dialog', { name: 'Command output' }).getByRole('region', { name: 'Command output' })
  await expect(panel).toContainText('Nothing to refine yet — send a message first.')
  expect(sent).toEqual([])
  if (process.env.TAL902_SHOTS) await page.screenshot({ path: `${process.env.TAL902_SHOTS}/refine-empty-${testInfo.project.name}.png` })
})
