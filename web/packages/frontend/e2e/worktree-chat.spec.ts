import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const owned: string[] = []
test.afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }) })

async function openRowMenu(page: Page, sid: string) {
  const item = page.locator(`.session-item[data-sid="${sid}"]`)
  await item.hover()
  await item.locator('.session-actions-trigger').click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('menuitem', { name: 'Remove worktree' }).click()
  return page.getByRole('dialog', { name: 'Remove worktree' })
}

/** TAL-605: a worktree chat is created from the workspace menu, badged in the sidebar, and removed behind the server's check. */
test('a worktree chat is created, badged, and removed with force confirmation when unsafe', async ({ page, errors }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the row actions trigger is hidden on touch layouts')
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'tal605-')))
  owned.push(repo)
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  writeFileSync(join(repo, 'README.md'), 'synthetic\n')
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'initial']]) expect(spawnSync('git', args, { cwd: repo, env }).status).toBe(0)
  expect((await page.request.post('/api/workspaces/add', { data: { path: repo } })).ok()).toBe(true)
  const base = (await (await page.request.post('/api/session/new', { data: { workspace: repo } })).json()) as { session: { session_id: string } }

  await page.goto(`/session/${base.session.session_id}`)
  const chip = page.locator('#composerWorkspaceChip')
  await expect(chip).toContainText(basename(repo))
  await chip.click()
  const create = page.getByRole('menuitem', { name: /New conversation in worktree/ })
  await expect(create).toBeVisible()
  if (process.env.TAL605_SHOTS) await page.screenshot({ path: `${process.env.TAL605_SHOTS}/menu.png` })
  await create.click()
  await expect(page.getByText('Worktree conversation created')).toBeVisible()
  await expect(page).not.toHaveURL(new RegExp(base.session.session_id))
  const sid = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '')
  const session = ((await (await page.request.get(`/api/session?session_id=${encodeURIComponent(sid)}`)).json()) as { session: { worktree_path: string; worktree_branch: string } }).session
  expect(session.worktree_path).toBeTruthy()
  owned.push(session.worktree_path)
  expect(existsSync(session.worktree_path)).toBe(true)

  const badge = page.locator(`.session-item[data-sid="${sid}"]`).getByRole('img', { name: `Worktree: ${session.worktree_branch}` })
  await expect(badge).toBeVisible()
  if (process.env.TAL605_SHOTS) await page.screenshot({ path: `${process.env.TAL605_SHOTS}/badge.png` })

  // A clean worktree removes without force; cancel to keep it for the unsafe case.
  let dialog = await openRowMenu(page, sid)
  await expect(dialog).toContainText(session.worktree_path)
  await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled()
  if (process.env.TAL605_SHOTS) await page.screenshot({ path: `${process.env.TAL605_SHOTS}/remove-clean.png` })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)

  // An untracked file makes removal unsafe: the dialog names the loss and asks for a forced removal.
  writeFileSync(join(session.worktree_path, 'scratch.txt'), 'unsaved\n')
  dialog = await openRowMenu(page, sid)
  await expect(dialog.getByRole('listitem')).toHaveText(['WARNING: This worktree has uncommitted changes which will be lost.', '1 untracked file(s) will be permanently deleted.'])
  if (process.env.TAL605_SHOTS) await page.screenshot({ path: `${process.env.TAL605_SHOTS}/remove-unsafe.png` })
  await dialog.getByRole('button', { name: 'Force remove' }).click()
  await expect(page.getByText('Worktree removed.')).toBeVisible()
  await expect(dialog).toHaveCount(0)
  expect(existsSync(session.worktree_path)).toBe(false)
  expect(errors).toEqual([])
})
