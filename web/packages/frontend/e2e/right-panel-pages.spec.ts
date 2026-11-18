import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const agent = (overrides: Record<string, unknown>) => ({
  task_id: 'd', kind: 'delegation', status: 'running', title: 'x', started_at: 1770000100, updated_at: Math.floor(Date.now() / 1000) - 120, completed_at: null,
  result_available: false, child_sessions: [], exit_code: null, agents: null, pinned: true, dismissible: false, active: true, ...overrides,
})

/** A chat with three delegations (one finished, one half done, one stalled) and a small workspace, opened at its URL. */
async function openPanelSession(page: Page) {
  const sid = 'panel-pages'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Audit the repo', workspace: '/repo', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, transcript_seq: null,
    messages: [{ role: 'user', id: 1, content: 'Split the audit' }],
  } } }))
  await page.route('**/api/background/tasks?**', (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind')
    const tasks = [
      agent({ task_id: 'call-1-1', title: 'Write the docs', status: 'completed', active: false, pinned: false, child_sessions: [{ goal: 'Write the docs', session_id: 'child-docs' }] }),
      agent({ task_id: 'call-1-2', title: '2 subagents: Write tests; Run tests', agents: { total: 2, completed: 1, failed: 0, running: 1 } }),
      agent({ task_id: 'd-stall', title: 'Fix CI', status: 'attention' }),
    ]
    return route.fulfill({ json: { session_id: sid, agent_available: true, agents_working: true, tasks: kind === 'delegation' ? tasks : [], pinned_count: kind === 'delegation' ? tasks.filter((t) => t.pinned).length : 0 } })
  })
  await page.route('**/api/list?**', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '.'
    return route.fulfill({ json: path === 'src' ? { path, entries: [{ name: 'notes.txt', path: 'src/notes.txt', size: 12 }] } : { path, entries: [{ name: 'src', path: 'src', is_dir: true }, { name: 'README.md', path: 'README.md', size: 20 }] } })
  })
  await page.route('**/api/git-info?**', (route) => route.fulfill({ json: { git: { is_git: true, branch: 'main', dirty: 0 } } }))
  await page.route('**/api/file?**', (route) => route.fulfill({ json: { path: 'src/notes.txt', content: 'first line\n', size: 11, lines: 1, preview: 'text' } }))
  await page.goto(`/session/${sid}`)
  return { tabs: page.getByRole('tablist', { name: 'Side panel' }), entries: page.getByRole('list', { name: 'Agents' }).getByRole('listitem') }
}
/** Wide screens open the panel from its edge tab; narrow ones, which have no edge tab, from the titlebar. */
const openPanel = async (page: Page, project: string) => {
  if (project === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
  else await page.getByRole('button', { name: 'Show workspace panel' }).click()
}

/** One right panel hosts Files and Agents as tabs (TAL-373). */
test('the right panel opens on Agents while agents run, listing each delegation', async ({ page }, testInfo) => {
  const { tabs, entries } = await openPanelSession(page)
  await openPanel(page, testInfo.project.name)
  await expect(tabs.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true')
  await expect(entries).toHaveCount(3)
  await expect(entries.nth(1)).toContainText('2 subagents: Write tests; Run tests')
  await expect(entries.nth(1)).toContainText('1 of 2 done')
  await expect(entries.nth(2)).toContainText('Needs attention')
  // TAL-494: a finished unit links its subagent's read-only transcript.
  await expect(entries.nth(0).getByRole('link', { name: 'Open transcript' })).toHaveAttribute('href', /\/session\/child-docs$/)
  // Every tab keeps its whole label at either width; a narrow header scrolls the strip and keeps the selected tab in view (TAL-1649).
  await expect.poll(() => tabs.evaluate((el) => {
    const strip = el.getBoundingClientRect()
    const selected = el.querySelector('[aria-selected="true"]')!.getBoundingClientRect()
    return [...el.querySelectorAll('[role="tab"]')].every((tab) => tab.scrollWidth <= tab.clientWidth) && selected.left >= strip.left - 0.5 && selected.right <= strip.right + 0.5
  })).toBe(true)
  if (process.env.TAL373_SHOTS) await page.screenshot({ path: `${process.env.TAL373_SHOTS}/agents-${testInfo.project.name}.png` })
})

test('Files keeps its open file and unsaved draft across tab switches by mouse and keyboard', async ({ page }, testInfo) => {
  const { tabs, entries } = await openPanelSession(page)
  await openPanel(page, testInfo.project.name)
  await tabs.getByRole('tab', { name: 'Files' }).click()
  await page.getByRole('treeitem', { name: /src/ }).click()
  await page.getByRole('treeitem', { name: /notes\.txt/ }).click()
  const editor = page.getByRole('textbox', { name: 'Preview' })
  await editor.fill('first line\ndraft in progress')
  await tabs.getByRole('tab', { name: 'Agents' }).click()
  await expect(entries).toHaveCount(3)
  await tabs.getByRole('tab', { name: 'Agents' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(tabs.getByRole('tab', { name: 'Files' })).toBeFocused()
  await expect(editor).toHaveValue('first line\ndraft in progress')
  if (process.env.TAL373_SHOTS) await page.screenshot({ path: `${process.env.TAL373_SHOTS}/files-${testInfo.project.name}.png` })
})

test('a tablet width, with neither the edge tab nor the titlebar, opens the panel from the chat header', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'a desktop browser at tablet width')
  await page.setViewportSize({ width: 800, height: 800 })
  const { tabs } = await openPanelSession(page)
  const toggle = page.locator('#btnSidePanelInline')
  await expect(toggle).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show workspace panel' })).toBeHidden()
  await toggle.click()
  await expect(tabs).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  if (process.env.TAL373_SHOTS) await page.screenshot({ path: `${process.env.TAL373_SHOTS}/tablet.png` })
})
