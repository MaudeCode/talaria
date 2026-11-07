import type { Page } from '@playwright/test'
import { expect, longPress, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const task = { prompt: 'Synthetic task', schedule: '0 9 * * *', schedule_display: '0 9 * * *', schedule_input: '0 9 * * *', state: 'scheduled', next_run_at: '2026-10-18T09:00:00Z', needs_attention: false, profile: 'default', toast_notifications: true, read_only: false, delivery_unconfirmed_platforms: [] as string[] }
const jobs = [
  { ...task, id: 'digest', name: 'Morning digest', enabled: true, derived_state: 'active', resumable: false },
  { ...task, id: 'parked', name: 'Parked report', enabled: false, derived_state: 'paused', resumable: true },
]
const run = { filename: '2026-10-17_09-00-00.md', size: 1200, modified: 1_792_000_000 }

async function routeTasks(page: Page, rows: object[]) {
  await page.route('**/api/crons', (route) => route.fulfill({ json: { jobs: rows, active_profile: 'default', all_profiles: false, other_profile_count: 0, unwritable_stores: [] } }))
  await page.route('**/api/crons/status', (route) => route.fulfill({ json: { running: {} } }))
  await page.route('**/api/crons/history?*', (route) => route.fulfill({ json: { runs: [run], total: 1, offset: 0 } }))
  await page.route('**/api/crons/run?*', (route) => route.fulfill({ json: { content: 'Synthetic run output', snippet: 'Synthetic', response: 'Synthetic run output', usage: {} } }))
}

test('the task list is the page and a task opens as a detail with a way back', async ({ page }, info) => {
  await routeTasks(page, jobs)
  const desktop = info.project.name === 'desktop'
  await page.goto('/tasks')
  const row = page.locator('#main [data-job-id="digest"]')
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('data-state', 'active')
  // The list is the page: no drawer opened over it on a phone.
  if (!desktop) await expect(page.locator('.sidebar.mobile-open')).toHaveCount(0)
  for (const name of ['Refresh', 'New queue', 'New job']) await expect(page.locator('.main-view-actions').getByRole('button', { name, exact: true })).toBeVisible()
  const parked = page.locator('#main [data-job-id="parked"]')
  await expect(parked).toBeHidden()
  await page.locator('#main summary').click()
  await expect(parked).toBeVisible()
  await page.screenshot({ path: info.outputPath('list.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  const detail = page.getByTestId('cron-detail')
  await row.click()
  await expect(page).toHaveURL(/\/tasks\?job=digest$/)
  await expect(detail).toBeVisible()
  await expect(page.locator('#main [data-job-id]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(detail).toHaveCount(0)
  await row.click()
  await expect(detail).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(row).toBeVisible()

  // A missing task keeps the way back; a deep link reaches the same detail.
  await page.goto('/tasks?job=gone')
  await expect(page.getByText('This task no longer exists.')).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(row).toBeVisible()
  await page.goto('/tasks?job=digest')
  await expect(detail).toBeVisible()
  await page.screenshot({ path: info.outputPath('detail.png') })

  // A picked run still opens: the shell hides its right panel only on the list.
  await page.getByRole('region', { name: 'Runs' }).getByRole('row').first().click()
  await expect(page.getByTestId('cron-run-output')).toBeVisible()
  if (desktop) {
    // The active row leaves a detail for the list instead of folding the sidebar.
    await page.locator('aside.sidebar [data-panel="tasks"]').click()
    await expect(page).toHaveURL(/\/tasks$/)
    await expect(page.locator('.layout')).not.toHaveClass(/sidebar-collapsed/)
  }
})

test('Stop shows only on a stoppable live run, shows stopping at once and settles on the server (TAL-1819)', async ({ page }, info) => {
  const base = { ...jobs[0]!, id: 'live', name: 'Live digest', running: true, last_outcome: 'succeeded' }
  let row: Record<string, unknown> = { ...base, can_stop: true, stopping: false }
  let answer: () => void = () => undefined
  const answered = new Promise<void>((resolve) => { answer = resolve })
  await routeTasks(page, jobs)
  await page.route('**/api/crons', (route) => route.fulfill({ json: { jobs: [row, jobs[0]!, { ...jobs[0]!, id: 'other', name: 'Not stoppable', running: true, can_stop: false, stopping: false }], active_profile: 'default', all_profiles: false, other_profile_count: 0, unwritable_stores: [] } }))
  await page.route('**/api/crons/cancel', async (route) => { await answered; await route.fulfill({ json: { ok: true, job_id: 'live', status: 'stopping' } }) })
  await page.goto('/tasks?job=other')
  const detail = page.getByTestId('cron-detail')
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(detail).toHaveAttribute('data-state', 'running')
  await expect(stop).toHaveCount(0)
  await page.goto('/tasks?job=live')
  await expect(stop).toBeVisible()
  await expect(stop).toBeInViewport()
  await page.screenshot({ path: info.outputPath('stop-before.png') })
  await stop.click()
  // The cancel request is still unanswered: the choice shows at once.
  await expect(detail).toHaveAttribute('data-state', 'stopping')
  await expect(stop).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('stop-stopping.png') })
  row = { ...base, can_stop: false, stopping: true }
  answer()
  await expect(detail).toHaveAttribute('data-state', 'stopping')
  row = { ...base, running: false, can_stop: false, stopping: false, last_status: 'cancelled', last_run_at: '2026-10-18T09:00:00Z', last_outcome: 'cancelled' }
  await expect(detail).toHaveAttribute('data-state', 'active', { timeout: 15_000 })
  await expect(detail.getByText('· stopped')).toBeVisible()
  await page.screenshot({ path: info.outputPath('stop-settled.png') })
})

test('a task whose last delivery is unconfirmed names the platforms on one line; a confirmed task says nothing (TAL-1850)', async ({ page }, info) => {
  await routeTasks(page, [...jobs, { ...jobs[0]!, id: 'unsure', name: 'Unsure digest', delivery_unconfirmed_platforms: ['telegram', 'slack'] }])
  await page.goto('/tasks?job=unsure')
  const line = page.getByText("Couldn't confirm delivery to telegram, slack", { exact: true })
  await expect(line).toBeVisible()
  expect(await line.evaluate((el) => el.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(el).lineHeight))).toBe(true)
  await page.screenshot({ path: info.outputPath('unconfirmed.png') })
  await page.goto('/tasks?job=digest')
  await expect(page.getByTestId('cron-detail')).toBeVisible()
  await expect(page.getByText(/confirm delivery/)).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('confirmed.png') })
})

/** Records each job write, applies it to `rows` as the server would and answers; a write in `held` waits for its promise. */
async function routeRowWrites(page: Page, rows: Record<string, unknown>[], held: Partial<Record<string, Promise<void>>> = {}) {
  const writes: { action: string | undefined; id: unknown }[] = []
  await page.route(/\/api\/crons\/(run|pause|resume|delete|cancel)$/, async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').pop()
    const id = (route.request().postDataJSON() as { job_id: unknown }).job_id
    writes.push({ action, id })
    await held[action ?? '']
    const index = rows.findIndex((row) => row.id === id)
    if (action === 'delete') rows.splice(index, 1)
    if (action === 'pause') Object.assign(rows[index]!, { enabled: false, derived_state: 'paused', resumable: true })
    await route.fulfill({ json: { ok: true } })
  })
  return writes
}

test('right-click on a job row offers its toolbar actions and acts on that job without opening it (TAL-1158)', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'right-click is the desktop route')
  const rows: Record<string, unknown>[] = [
    ...jobs.map((job) => ({ ...job })),
    { ...jobs[0]!, id: 'live', name: 'Live digest', running: true, can_stop: true, stopping: false },
    { ...jobs[0]!, id: 'plain', name: 'Plain digest', resumable: undefined },
    { ...jobs[0]!, id: 'other', name: 'Other profile digest', read_only: true, owner_profile: 'work' },
    { ...jobs[0]!, id: 'digest:new:1', name: 'Pending create' },
  ]
  await routeTasks(page, rows)
  let answerRun: () => void = () => undefined
  await page.route('**/api/crons/context-sources', (route) => route.fulfill({ json: { profile: 'default', sources: [] } }))
  const writes = await routeRowWrites(page, rows, { run: new Promise<void>((resolve) => { answerRun = resolve }) })
  await page.goto('/tasks')
  const row = (id: string) => page.locator(`#main [data-job-id="${id}"]`)
  const menuOf = (name: string) => page.getByRole('menu', { name })
  await page.locator('#main summary').click()

  const offered: [string, string, string[]][] = [
    ['digest', 'Morning digest', ['Run now', 'Pause', 'Edit', 'Duplicate', 'Delete']],
    ['parked', 'Parked report', ['Run now', 'Resume', 'Edit', 'Duplicate', 'Delete']],
    ['live', 'Live digest', ['Run now', 'Stop', 'Pause', 'Edit', 'Duplicate', 'Delete']],
    ['plain', 'Plain digest', ['Run now', 'Edit', 'Duplicate', 'Delete']],
  ]
  for (const [id, name, items] of offered) {
    await row(id).click({ button: 'right' })
    await expect(menuOf(name).getByRole('menuitem')).toHaveText(items)
    if (id === 'digest') await page.screenshot({ path: info.outputPath('row-menu-desktop.png') })
    await page.keyboard.press('Escape')
    await expect(menuOf(name)).toHaveCount(0)
  }
  // A read-only row has nothing to offer, so nothing cancels the browser's own menu.
  expect(await row('other').evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))).toBe(true)
  await expect(page.getByRole('menu')).toHaveCount(0)

  // A pending create has no server identity yet, so it offers nothing to act on.
  await row('digest:new:1').click({ button: 'right', force: true })
  await row('digest').click({ button: 'right' })
  await expect(menuOf('Morning digest')).toBeVisible()
  await expect(menuOf('Pending create')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Run now stays disabled on that job until its request settles, as the toolbar button does.
  await row('digest').click({ button: 'right' })
  await menuOf('Morning digest').getByRole('menuitem', { name: 'Run now' }).click()
  await expect.poll(() => writes).toEqual([{ action: 'run', id: 'digest' }])
  await row('digest').click({ button: 'right' })
  await expect(menuOf('Morning digest').getByRole('menuitem', { name: 'Run now' })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  answerRun()

  // Pause applies at once, to the job that was right-clicked, and the list stays the page.
  writes.length = 0
  await row('digest').click({ button: 'right' })
  await menuOf('Morning digest').getByRole('menuitem', { name: 'Pause' }).click()
  await expect.poll(() => writes).toEqual([{ action: 'pause', id: 'digest' }])
  await expect(row('digest')).toHaveAttribute('data-state', 'paused')
  await expect(page).toHaveURL(/\/tasks$/)

  // Edit and Duplicate open the same form as the toolbar's, filled from that job.
  await row('parked').click({ button: 'right' })
  await menuOf('Parked report').getByRole('menuitem', { name: 'Edit' }).click()
  await expect(page.getByRole('form', { name: 'Edit job' }).getByLabel('Name', { exact: true })).toHaveValue('Parked report')
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()
  await page.locator('#main summary').click()
  await row('parked').click({ button: 'right' })
  await menuOf('Parked report').getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(page.getByRole('form', { name: 'Duplicate job' }).getByLabel('Name', { exact: true })).toHaveValue('Parked report (copy)')
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()

  // Delete goes through the confirmation that names the job; cancelling it writes nothing.
  writes.length = 0
  await row('plain').click({ button: 'right' })
  await menuOf('Plain digest').getByRole('menuitem', { name: 'Delete' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Plain digest')
  await page.screenshot({ path: info.outputPath('row-delete-confirm-desktop.png') })
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(confirm).toBeHidden()
  expect(writes).toEqual([])
  await row('plain').click({ button: 'right' })
  await menuOf('Plain digest').getByRole('menuitem', { name: 'Delete' }).click()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(row('plain')).toHaveCount(0)
  await expect.poll(() => writes).toEqual([{ action: 'delete', id: 'plain' }])
})

test('long-press on a job row opens the same actions without opening the job (TAL-1158)', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'long-press is the touch route')
  const rows = jobs.map((job) => ({ ...job }))
  await routeTasks(page, rows)
  const writes = await routeRowWrites(page, rows)
  await page.goto('/tasks')
  const row = page.locator('#main [data-job-id="digest"]')
  await longPress(page, row)
  const menu = page.getByRole('menu', { name: 'Morning digest' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Run now', 'Pause', 'Edit', 'Duplicate', 'Delete'])
  await expect(page).toHaveURL(/\/tasks$/)
  await page.screenshot({ path: info.outputPath('row-menu-mobile.png') })
  await menu.getByRole('menuitem', { name: 'Pause' }).click()
  await expect.poll(() => writes).toEqual([{ action: 'pause', id: 'digest' }])
  await expect(row).toHaveAttribute('data-state', 'paused')
  await expect(page).toHaveURL(/\/tasks$/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
