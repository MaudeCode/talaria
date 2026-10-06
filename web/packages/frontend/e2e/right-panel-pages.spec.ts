import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const agent = (overrides: Record<string, unknown>) => ({
  task_id: 'd', kind: 'delegation', status: 'running', title: 'x', started_at: 1770000100, updated_at: Math.floor(Date.now() / 1000) - 120, completed_at: null,
  result_available: false, child_sessions: [], exit_code: null, agents: null, pinned: true, dismissible: false, active: true, ...overrides,
})

/** One right panel hosts Files and Agents as tabs; Files keeps its folder and draft across switches (TAL-373). */
test('the right panel shows Agents and Files as tabs that keep their state', async ({ page }, testInfo) => {
  const sid = 'panel-pages'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Audit the repo', workspace: '/repo', is_streaming: false, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, transcript_seq: null,
    messages: [{ role: 'user', id: 1, content: 'Split the audit' }],
  } } }))
  await page.route('**/api/background/tasks?**', (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind')
    const tasks = [
      agent({ task_id: 'call-1-1', title: 'Write the docs', status: 'completed', active: false, pinned: false, child_sessions: [{ goal: 'Write the docs', session_id: 'child-docs' }] }),
      agent({ task_id: 'call-1-2', title: '2 subagents: Write tests; Run tests', agents: { total: 2, completed: 1, failed: 0, running: 1 } }),
      agent({ task_id: 'd-stall', title: 'Fix CI', status: 'attention' }),
    ]
    return route.fulfill({ json: { session_id: sid, agent_available: true, agents_working: true, tasks: kind === 'delegation' ? tasks : [] } })
  })
  await page.route('**/api/list?**', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '.'
    return route.fulfill({ json: path === 'src' ? { path, entries: [{ name: 'notes.txt', path: 'src/notes.txt', size: 12 }] } : { path, entries: [{ name: 'src', path: 'src', is_dir: true }, { name: 'README.md', path: 'README.md', size: 20 }] } })
  })
  await page.route('**/api/git-info?**', (route) => route.fulfill({ json: { git: { is_git: true, branch: 'main', dirty: 0 } } }))
  // An older server's reply has no `preview` field; the file still opens as text (TAL-566).
  await page.route('**/api/file?**', (route) => route.fulfill({ json: { path: 'src/notes.txt', content: 'first line\n', size: 11, lines: 1 } }))

  await page.goto(`/session/${sid}`)
  // Wide screens open the panel from its edge tab; narrow ones, which have no edge tab, from the titlebar.
  if (testInfo.project.name === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
  else await page.getByRole('button', { name: 'Show workspace panel' }).click()
  const tabs = page.getByRole('tablist', { name: 'Side panel' })
  // Agents are running, so the panel opens on Agents.
  await expect(tabs.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true')
  const entries = page.getByRole('list', { name: 'Agents' }).getByRole('listitem')
  await expect(entries).toHaveCount(3)
  await expect(entries.nth(1)).toContainText('2 subagents: Write tests; Run tests')
  await expect(entries.nth(1)).toContainText('1 of 2 done')
  await expect(entries.nth(2)).toContainText('Needs attention')
  // TAL-494: a finished unit links its subagent's read-only transcript.
  await expect(entries.nth(0).getByRole('link', { name: 'Open transcript' })).toHaveAttribute('href', /\/session\/child-docs$/)
  // Two short tabs never overflow the panel's header, at either width.
  expect(await tabs.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  if (process.env.TAL373_SHOTS) await page.screenshot({ path: `${process.env.TAL373_SHOTS}/agents-${testInfo.project.name}.png` })

  await tabs.getByRole('tab', { name: 'Files' }).click()
  await page.getByRole('treeitem', { name: /src/ }).click()
  await page.getByRole('treeitem', { name: /notes\.txt/ }).click()
  const editor = page.getByRole('textbox', { name: 'Preview' })
  await editor.fill('first line\ndraft in progress')
  // Away and back, by mouse and by keyboard: the open file and its unsaved draft are still there.
  await tabs.getByRole('tab', { name: 'Agents' }).click()
  await expect(entries).toHaveCount(3)
  await tabs.getByRole('tab', { name: 'Agents' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(tabs.getByRole('tab', { name: 'Files' })).toBeFocused()
  await expect(editor).toHaveValue('first line\ndraft in progress')
  if (process.env.TAL373_SHOTS) await page.screenshot({ path: `${process.env.TAL373_SHOTS}/files-${testInfo.project.name}.png` })

  // A tablet width has neither the edge tab nor the titlebar: the chat header opens and closes the drawer.
  if (testInfo.project.name === 'desktop') {
    await page.getByRole('button', { name: 'Close menu' }).click()
    await page.setViewportSize({ width: 800, height: 800 })
    const toggle = page.locator('#btnSidePanelInline')
    await expect(toggle).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show workspace panel' })).toBeHidden()
    await toggle.click()
    await expect(tabs).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    if (process.env.TAL373_SHOTS) await page.screenshot({ path: `${process.env.TAL373_SHOTS}/tablet.png` })
  }
})
