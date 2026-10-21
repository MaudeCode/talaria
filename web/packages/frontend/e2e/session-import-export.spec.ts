import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** The sidebar imports a JSON export as a new session, and the row menu downloads Markdown and JSON transcripts (TAL-607). */

const TITLE = 'Imported transcript TAL-607'

async function importFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  const before = page.url()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import session from JSON' }).click()
  const imported = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/session/import' && r.request().method() === 'POST')
  await (await chooser).setFiles(file)
  const response = await imported
  expect(response.status(), await response.text()).toBe(200)
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

  const doc = { title: TITLE, messages: [{ role: 'user', content: 'hello from import' }, { role: 'assistant', content: 'imported answer' }] }
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

test('wraps long export metadata within a mobile viewport', async ({ page }) => {
  const imported = await page.request.post('/api/session/import', { data: {
    title: 'UnbrokenTitle'.repeat(25), messages: [{ role: 'user', content: 'Export layout fixture' }],
  } })
  expect(imported.status()).toBe(200)
  const { session } = await imported.json() as { session: { session_id: string } }
  const exported = await page.request.get(`/api/session/export?session_id=${session.session_id}&format=html`)
  expect(exported.status()).toBe(200)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.setContent(await exported.text())
  await expect(page.getByText('Export layout fixture')).toBeVisible()
  const size = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }))
  expect(size.content).toBeLessThanOrEqual(size.viewport)
})
