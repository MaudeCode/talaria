import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const states = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/delegation-status.json'), 'utf8')) as Record<string, Record<string, unknown>>

// TAL-1579: the server's shared summary states, as the real built Agents page words them.
test('the Agents page words every delegation summary the server sends', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const sid = 'delegation-status'
  let state: string | null = null
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Delegated work', workspace: '/repo', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, transcript_seq: null,
    messages: [{ role: 'user', id: 1, content: 'Review the logs in the background.' }],
  } } }))
  await page.route('**/api/background/tasks?**', (route) => route.fulfill({ json: { session_id: sid, agent_available: true, agents_working: false,
    tasks: [{ task_id: 'd1', kind: 'delegation', title: 'Review the logs', status: 'completed', can_stop: false, started_at: 1770000100, updated_at: 1770000110, completed_at: 1770000110,
      result_available: true, child_sessions: [], exit_code: null, agents: null, pinned: false, dismissible: false, active: false }],
    ...(state ? { delegation_status: states[state] } : {}) } }))
  await page.route('**/api/git-info?**', (route) => route.fulfill({ json: { git: { is_git: false } } }))
  await page.route('**/api/list?**', (route) => route.fulfill({ json: { path: '.', entries: [] } }))
  await page.goto(`/session/${sid}`)
  const openAgents = async () => {
    await expect(page.getByText('Review the logs in the background.')).toBeVisible()
    // A closed mobile panel keeps its tabs rendered off-screen.
    const tab = page.getByRole('tab', { name: 'Agents', exact: true })
    const shown = await tab.isVisible() && (testInfo.project.name !== 'mobile' || await tab.evaluate((el) => el.getBoundingClientRect().left < innerWidth))
    if (shown) { /* the panel stayed open across the reload */ }
    else if (testInfo.project.name === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
    else await page.getByRole('button', { name: 'Show workspace panel' }).click()
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    await expect(page.getByRole('list', { name: 'Agents' })).toContainText('Review the logs')
  }
  const shot = async (name: string) => {
    if (process.env.TAL1579_SHOTS) await page.screenshot({ path: `${process.env.TAL1579_SHOTS}/${name}-${testInfo.project.name}.png` })
  }
  // An older server sends no summary: nothing is shown.
  await openAgents()
  await expect(page.locator('.agents-delivery')).toHaveCount(0)
  await shot('before')
  for (const [name, text] of [
    ['awaiting_delivery', '1 awaiting delivery'], ['running_and_awaiting', '1 running · 3 awaiting delivery'], ['available_zero', 'Nothing running or awaiting delivery'],
    ['unknown', 'Delivery status unavailable'], ['unsupported', 'This chat’s owner doesn’t report delivery status'], ['hidden', null],
  ] as const) {
    state = name
    await page.reload()
    await openAgents()
    if (text === null) await expect(page.locator('.agents-delivery')).toHaveCount(0)
    else await expect(page.locator('.agents-delivery')).toHaveText(text)
    await shot(name)
  }
})
