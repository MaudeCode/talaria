import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

// The checkpoint lives in the server's state directory; removing it on every exit keeps the teardown's delete clean.
const owned: string[] = []
test.afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }) })

/** TAL-571: the side panel's Checkpoints page lists a synthetic Agent checkpoint, shows its diff, and restores it. */
test('the Checkpoints page lists, diffs and restores a workspace checkpoint', async ({ page, errors }, testInfo) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'tal571-')))
  owned.push(workspace)
  writeFileSync(join(workspace, 'notes.txt'), 'edited by the agent\n')
  expect((await page.request.post('/api/workspaces/add', { data: { path: workspace } })).ok()).toBe(true)
  // The server names where the Agent keeps this workspace's checkpoints; seed one shadow repository there.
  const listed = (await (await page.request.get(`/api/rollback/list?workspace=${encodeURIComponent(workspace)}`)).json()) as { checkpoint_dir: string }
  const ckpt = join(listed.checkpoint_dir, 'ckpt-1')
  owned.push(listed.checkpoint_dir)
  mkdirSync(ckpt, { recursive: true })
  writeFileSync(join(ckpt, 'notes.txt'), 'original text\n')
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'before editing notes']]) expect(spawnSync('git', args, { cwd: ckpt, env }).status).toBe(0)
  const created = (await (await page.request.post('/api/session/new', { data: { workspace } })).json()) as { session: { session_id: string } }

  await page.goto(`/session/${created.session.session_id}`)
  if (testInfo.project.name === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
  else await page.getByRole('button', { name: 'Show workspace panel' }).click()
  const tab = page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', { name: 'Checkpoints' })
  await expect(tab).toBeVisible()
  await tab.click()
  const entry = page.getByRole('list', { name: 'Checkpoints' }).getByRole('listitem').filter({ hasText: 'before editing notes' })
  await expect(entry).toContainText('ckpt-1')
  await expect(entry).toContainText('Files: 1')
  if (process.env.TAL571_SHOTS) await page.screenshot({ path: `${process.env.TAL571_SHOTS}/list-${testInfo.project.name}.png` })

  await entry.getByRole('button', { name: 'View diff' }).click()
  const diff = page.getByRole('dialog', { name: 'Changes in checkpoint' })
  await expect(diff.getByRole('list', { name: '1 file changed' })).toContainText('notes.txt')
  // A RegExp matches the raw text (a string would collapse whitespace): one line per diff line, no blank lines between.
  await expect(diff.locator('pre')).toHaveText(/^--- a\/notes\.txt\n\+\+\+ b\/notes\.txt\n@@ -1 \+1 @@\n-original text\n\+edited by the agent$/)
  if (process.env.TAL571_SHOTS) await page.screenshot({ path: `${process.env.TAL571_SHOTS}/diff-${testInfo.project.name}.png` })
  await diff.getByRole('button', { name: 'Close' }).click()
  await expect(diff).toHaveCount(0)

  await entry.getByRole('button', { name: 'Restore' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Restore checkpoint?' })
  await expect(confirm).toContainText('before editing notes')
  if (process.env.TAL571_SHOTS) await page.screenshot({ path: `${process.env.TAL571_SHOTS}/confirm-${testInfo.project.name}.png` })
  await confirm.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByText('Checkpoint restored')).toBeVisible()
  if (process.env.TAL571_SHOTS) await page.screenshot({ path: `${process.env.TAL571_SHOTS}/restored-${testInfo.project.name}.png` })
  expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe('original text\n')

  // The restored workspace now matches the checkpoint.
  await entry.getByRole('button', { name: 'View diff' }).click()
  await expect(page.getByRole('dialog', { name: 'Changes in checkpoint' })).toContainText('No differences found between this checkpoint and the current workspace.')
  expect(errors).toEqual([])
})
