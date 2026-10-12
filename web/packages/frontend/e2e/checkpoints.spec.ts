import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const owned: string[] = []
test.afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }) })

/**
 * TAL-571, TAL-913: the side panel's Checkpoints page lists the Agent's checkpoints for the chat's workspace, shows one's
 * diff, and restores it. The fixture replay sidecar answers `checkpoints.*` with the Agent's recorded checkpoint of an
 * edited `notes.txt`; the sidecar suite covers the real store and restore.
 */
test('the Checkpoints page lists, diffs and restores a workspace checkpoint', async ({ page, errors }, testInfo) => {
  test.skip(!process.env.HERMES_WEBUI_SIDECAR_COMMAND?.includes('replay_sidecar'), 'needs the fixture replay sidecar')
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'tal913-')))
  owned.push(workspace)
  writeFileSync(join(workspace, 'notes.txt'), 'edited by the agent\n')
  expect((await page.request.post('/api/workspaces/add', { data: { path: workspace } })).ok()).toBe(true)
  const created = (await (await page.request.post('/api/session/new', { data: { workspace } })).json()) as { session: { session_id: string } }

  await page.goto(`/session/${created.session.session_id}`)
  if (testInfo.project.name === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
  else await page.getByRole('button', { name: 'Show workspace panel' }).click()
  const tab = page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', { name: 'Checkpoints' })
  await expect(tab).toBeVisible()
  await tab.click()
  const entry = page.getByRole('list', { name: 'Checkpoints' }).getByRole('listitem').filter({ hasText: 'before write_file' })
  await expect(entry).toContainText('5950449d0e45')
  await expect(entry).toContainText('Files: 0')
  if (process.env.TAL571_SHOTS) await page.screenshot({ path: `${process.env.TAL571_SHOTS}/list-${testInfo.project.name}.png` })

  await entry.getByRole('button', { name: 'View diff' }).click()
  const diff = page.getByRole('dialog', { name: 'Changes in checkpoint' })
  await expect(diff.getByRole('list', { name: '1 file changed' })).toContainText('notes.txt')
  // A RegExp matches the raw text (a string would collapse whitespace): the Agent's git diff, one line per diff line.
  await expect(diff.locator('pre')).toHaveText(/^diff --git a\/notes\.txt b\/notes\.txt\nindex \w+\.\.\w+ 100644\n--- a\/notes\.txt\n\+\+\+ b\/notes\.txt\n@@ -1 \+1 @@\n-original text\n\+edited by the agent$/)
  if (process.env.TAL571_SHOTS) await page.screenshot({ path: `${process.env.TAL571_SHOTS}/diff-${testInfo.project.name}.png` })
  await diff.getByRole('button', { name: 'Close' }).click()
  await expect(diff).toHaveCount(0)

  await entry.getByRole('button', { name: 'Restore' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Restore checkpoint?' })
  await expect(confirm).toContainText('before write_file')
  if (process.env.TAL571_SHOTS) await page.screenshot({ path: `${process.env.TAL571_SHOTS}/confirm-${testInfo.project.name}.png` })
  await confirm.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByText('Checkpoint restored')).toBeVisible()
  if (process.env.TAL571_SHOTS) await page.screenshot({ path: `${process.env.TAL571_SHOTS}/restored-${testInfo.project.name}.png` })
  expect(errors).toEqual([])
})
