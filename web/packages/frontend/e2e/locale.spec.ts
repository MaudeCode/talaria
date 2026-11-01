import type { Page } from '@playwright/test'
import { expect, settle, test } from './fixtures'
import { E2E_PASSWORD } from './global-setup'

/**
 * TAL-1403: non-English strings arrive as one lazily loaded chunk per locale. The UI waits for the
 * active locale's chunk, so its first paint is already translated, and a switch loads the next one
 * without a reload.
 */
const LANGUAGE_LABEL = 'label[for="settingsLanguage"]'

/** Serves the server's language setting as `language`, and records every text the language label shows from first paint on. */
async function bootIn(page: Page, language: string): Promise<{ chunks: string[] }> {
  await page.route('**/api/bootstrap', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json() as object), language } })
  })
  await page.addInitScript((selector) => {
    const seen: string[] = []
    Object.assign(window, { languageLabels: seen })
    new MutationObserver(() => {
      const text = document.querySelector(selector)?.textContent
      if (text && seen.at(-1) !== text) seen.push(text)
    }).observe(document, { childList: true, subtree: true, characterData: true })
  }, LANGUAGE_LABEL)
  // The chunk arrives after the lazy route would have painted, so any render before it would show English.
  const chunks: string[] = []
  await page.route(/\/assets\/locale-.+\.js$/, async (route) => {
    chunks.push(/\/assets\/locale-(.+)-[a-z0-9]+\.js$/.exec(route.request().url())?.[1] ?? '')
    await new Promise((resolve) => setTimeout(resolve, 750))
    await route.continue()
  })
  await page.goto('/settings/appearance')
  await settle(page)
  return { chunks }
}

const labels = (page: Page) => page.evaluate(() => (window as unknown as { languageLabels: string[] }).languageLabels)

test('English loads no locale chunk', async ({ page }) => {
  const { chunks } = await bootIn(page, 'en')
  await expect(page.locator(LANGUAGE_LABEL)).toHaveText('Language')
  expect(chunks).toEqual([])
})

test('Japanese paints translated from the first frame', async ({ page }) => {
  const { chunks } = await bootIn(page, 'ja')
  await expect(page.locator(LANGUAGE_LABEL)).toHaveText('言語')
  expect(await labels(page)).toEqual(['言語'])
  expect(chunks).toEqual(['ja'])
})

test('German paints translated from the first frame and keeps entries identical to English', async ({ page }) => {
  const { chunks } = await bootIn(page, 'de')
  await expect(page.locator(LANGUAGE_LABEL)).toHaveText('Sprache')
  expect(await labels(page)).toEqual(['Sprache'])
  await expect(page.getByText('Design', { exact: true })).toBeVisible()
  // `settings_label_skin` is "Skin" in German too, so the German chunk leaves it to the English module.
  await expect(page.getByText('Skin', { exact: true })).toBeVisible()
  expect(chunks).toEqual(['de'])
})

test('switching locale updates strings without a reload', async ({ page }) => {
  await bootIn(page, 'ja')
  await page.evaluate(() => { Object.assign(window, { sameDocument: true }) })
  try {
    await page.locator('#settingsLanguage').click()
    await page.getByRole('option', { name: 'Deutsch' }).click()
    await expect(page.locator(LANGUAGE_LABEL)).toHaveText('Sprache')
    await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE')
    expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true)
    expect(await labels(page)).toEqual(['言語', 'Sprache'])
  } finally {
    await page.request.post('/api/settings', { data: { language: 'en' } })
  }
})

/** TAL-1031: with no saved language, the first visit and the sign-in page follow the browser's Accept-Language. */
test.describe('browser language on a first visit', () => {
  test.use({ locale: 'fr-CA' })

  test('the sign-in page paints French and signing in keeps it without saving a choice', async ({ page }) => {
    const auth = process.env.HERMES_E2E_AUTH_BASE_URL!
    await page.goto(`${auth}/login`)
    await settle(page)
    await expect(page.getByRole('button', { name: 'Se connecter' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr-FR')
    await page.locator('#pw').fill(E2E_PASSWORD)
    await page.getByRole('button', { name: 'Se connecter' }).click()
    await expect(page).not.toHaveURL(/\/login/)
    await settle(page)
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr-FR')
    expect(await page.evaluate(() => window.localStorage.getItem('hermes-lang'))).toBeNull()
    // The browser's own fetch carries its Accept-Language; Playwright's request context does not.
    const boot = await page.evaluate(async () => (await fetch('api/bootstrap')).json() as Promise<{ language: string; browser_language?: string }>)
    expect(boot).toMatchObject({ language: '', browser_language: 'fr' })
  })
})
