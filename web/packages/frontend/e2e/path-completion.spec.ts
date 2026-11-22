import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

// TAL-1342: an owner chat completes the path before the caret. The boundary fixture answers as the server does for the
// shared owner listing; the real built composer lists the rows and inserts only the picked insertion text.
test('an owner chat inserts the picked path at the caret and keeps the rest of the draft', async ({ page }, testInfo) => {
  const sid = 'owner-paths'
  const owner = { state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 2, execution_generation: 1, admissions: [], queued_input_count: 0 }
  const asked: string[] = []
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Gateway chat', workspace: '/repo', is_streaming: false, read_only: true, can_branch: false, can_pin: true, can_archive: true, can_delete: false, can_rename: false, can_move: false, can_duplicate: false, can_share: false, transcript_seq: null,
    owner_attachment: owner, messages: [{ role: 'user', id: 1, content: 'Summarize the notes.' }],
  } } }))
  await page.route('**/api/chat/path-completions', async (route) => {
    const { before } = route.request().postDataJSON() as { before: string }
    asked.push(before)
    const at = before.lastIndexOf('@file:no')
    await route.fulfill({ json: at < 0 || at + '@file:no'.length !== before.length ? { available: true, reason: null, replace_from: null, items: [] } : { available: true, reason: null, replace_from: at, items: [
      { label: 'notes été.md', detail: '', kind: 'file', insert: '@file:`notes été.md`' },
      { label: 'notebooks/', detail: '', kind: 'folder', insert: '@folder:notebooks/' },
      { label: '@diff', detail: 'git diff', kind: 'reference', insert: '@diff' },
    ] } })
  })
  await page.route('**/api/git-info?**', (route) => route.fulfill({ json: { git: { is_git: false } } }))
  await page.route('**/api/list?**', (route) => route.fulfill({ json: { path: '.', entries: [] } }))
  const shot = async (state: string) => {
    if (process.env.TAL1342_SHOTS) await page.screenshot({ path: `${process.env.TAL1342_SHOTS}/${state}-${testInfo.project.name}.png` })
  }

  await page.goto(`/session/${sid}`)
  const box = page.locator('#msg')
  await box.click()
  await page.keyboard.type('read @file:no please')
  for (let i = 0; i < ' please'.length; i++) await page.keyboard.press('ArrowLeft')
  const list = page.getByRole('listbox', { name: 'Files' })
  await expect(list.getByRole('option')).toHaveCount(3)
  await expect(list).not.toHaveAttribute('aria-busy', 'true')
  expect(asked.at(-1)).toBe('read @file:no')
  await shot('listed')
  await page.keyboard.press('Tab')
  await expect(box).toHaveValue('read @file:`notes été.md` please')
  await expect(list).toHaveCount(0)
  expect(await box.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe('read @file:`notes été.md`'.length)
  await shot('inserted')
})
