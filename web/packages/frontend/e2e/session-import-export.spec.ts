import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** The sidebar imports a JSON export as a new session, and the row menu downloads Markdown and JSON transcripts (TAL-607). */

const TITLE = 'Imported transcript TAL-607'

async function importFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const before = page.url()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import session from JSON' }).click()
  await (await chooser).setFiles(file)
  await page.waitForURL((url) => url.href !== before && /\/session\/[^/]+$/.test(url.pathname))
  return decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '')
}

async function download(page: Page, sid: string, name: string) {
  const item = page.locator(`.session-item[data-sid="${sid}"]`)
  await item.hover()
  await item.locator('.session-actions-trigger').click()
  const pending = page.waitForEvent('download')
  await page.getByRole('menu').getByRole('menuitem', { name }).click()
  const file = await pending
  return { name: file.suggestedFilename(), text: readFileSync(await file.path(), 'utf8') }
}

test('imports a JSON session, downloads it as Markdown, and re-imports its JSON export', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the row actions trigger is hidden on touch layouts')
  await page.goto('/')
  await settle(page)

  // CI keeps the server's default workspace under /dev/shm, a blocked root an import refuses, so the session names a
  // workspace in the home directory, which every server trusts; the server shares the runner's HOME.
  const doc = { title: TITLE, workspace: homedir(), messages: [{ role: 'user', content: 'hello from import' }, { role: 'assistant', content: 'imported answer' }] }
  const first = await importFile(page, { name: 'saved.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) })
  await expect(page.getByText('imported answer')).toBeVisible()
  await expect(page.locator(`.session-item[data-sid="${first}"]`)).toContainText(TITLE)

  const md = await download(page, first, 'Export as Markdown')
  expect(md.name).toBe(`hermes-${first}.md`)
  expect(md.text).toContain(`# ${TITLE}`)
  expect(md.text).toContain('## You\n\nhello from import\n\n## Assistant\n\nimported answer\n')

  const json = await download(page, first, 'Export as JSON')
  expect(json.name).toBe(`hermes-${first}.json`)
  const second = await importFile(page, { name: json.name, mimeType: 'application/json', buffer: Buffer.from(json.text) })
  await expect(page.locator(`.session-item[data-sid="${second}"]`)).toContainText(TITLE)
  await expect(page.getByText('imported answer')).toBeVisible()
})

test('a file that is not JSON reports the failure and creates nothing', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the sidebar header is behind the drawer on touch layouts')
  await page.goto('/')
  await settle(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import session from JSON' }).click()
  await (await chooser).setFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('not json') })
  await expect(page.getByText('Import failed: Invalid JSON')).toBeVisible()
  await expect(page).not.toHaveURL(/\/session\//)
})
