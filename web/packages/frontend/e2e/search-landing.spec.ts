import type { Page } from '@playwright/test'
import { expect, hold, settle, test } from './fixtures'

// The 300-message fixture serializes into every per-action trace; retain failure screenshots.
test.use({ serviceWorkers: 'block', trace: 'off', screenshot: 'only-on-failure' })

/** A chat longer than the first transcript window, with each searched phrase among its first five messages. */
const transcript = (tag: string) => Array.from({ length: 150 }, (_, i) => [
  { role: 'user', content: i === 1 ? `${tag} alpha question` : `${tag} question ${String(i)}` },
  { role: 'assistant', content: i === 1 ? `${tag} beta answer` : `${tag} answer ${String(i)}. `.repeat(8) },
]).flat()

const seed = async (page: Page, title: string, messages: unknown[]): Promise<string> => {
  const imported = await page.request.post('/api/session/import', { data: { title, messages } })
  expect(imported.status()).toBe(200)
  return ((await imported.json()) as { session: { session_id: string } }).session.session_id
}

/** Distance from the transcript's bottom. */
const distance = (page: Page) => page.locator('#messages').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

/** The sidebar search, opened on a phone, typed and answered; returns the result row for `sid`. */
const searchFor = async (page: Page, query: string, sid: string) => {
  const hamburger = page.locator('#btnHamburger')
  if (await hamburger.isVisible()) await hamburger.click()
  const field = page.locator('#sessionSearch')
  if (!await field.isVisible()) await page.locator('aside.sidebar').getByRole('button', { name: 'Search', exact: true }).click()
  await field.fill(query)
  const row = page.locator(`#sessionList a[data-sid="${sid}"]`)
  // The previous term's matches stay listed until this one's arrive; its row names this term in its title or preview.
  await expect(row).toContainText(query, { ignoreCase: true })
  return row
}

const landed = (page: Page) => page.locator('[data-landed]')

test('a content hit opens its chat at the matched message and marks it (TAL-1922)', async ({ page }, testInfo) => {
  const tag = `landing${String(Date.now())}${testInfo.project.name}`
  const sid = await seed(page, 'Search landing', transcript(tag))
  await page.goto('/')
  await settle(page)

  await (await searchFor(page, `${tag} alpha`, sid)).click()
  await expect(page).toHaveURL(new RegExp(`/session/${sid}\\?msg=2-user$`))
  const alpha = page.locator('[data-message-key="2-user"]')
  await expect(alpha).toContainText(`${tag} alpha question`)
  await expect(alpha).toBeInViewport()
  // The first window holds only the newest messages; the landing paged in the oldest.
  await expect(page.locator('[data-message-key="0-user"]')).toBeAttached()
  await expect(landed(page)).toHaveAttribute('data-message-key', '2-user')
  // Under reduced motion the mark holds still, then clears.
  const style = await alpha.evaluate((el) => { const computed = getComputedStyle(el); return { animation: computed.animationName, background: computed.backgroundColor } })
  expect(style.animation).toBe('none')
  expect(style.background).not.toBe('rgba(0, 0, 0, 0)')
  await page.screenshot({ path: testInfo.outputPath(`landed-${testInfo.project.name}.png`) })
  await expect(landed(page)).toHaveCount(0)
  // The history it paged in did not carry the reader back to the bottom.
  await expect(alpha).toBeInViewport()
  expect(await distance(page)).toBeGreaterThan(200)

  // A second hit in the same chat moves to its row.
  await (await searchFor(page, `${tag} beta`, sid)).click()
  await expect(page).toHaveURL(new RegExp(`/session/${sid}\\?msg=3-assistant$`))
  await expect(page.locator('[data-message-key="3-assistant"]')).toBeInViewport()
  await expect(landed(page)).toHaveAttribute('data-message-key', '3-assistant')
})

test('the landing mark fades when motion is allowed (TAL-1922)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the animation does not depend on the viewport')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const tag = `landingmotion${String(Date.now())}`
  const sid = await seed(page, 'Search landing motion', transcript(tag))
  await page.goto('/')
  await settle(page)
  await (await searchFor(page, `${tag} alpha`, sid)).click()
  await expect(landed(page)).toHaveAttribute('data-message-key', '2-user')
  expect(await landed(page).evaluate((el) => getComputedStyle(el).animationName)).toBe('msg-landed')
  await expect(landed(page)).toHaveCount(0)
})

test('opening another chat before a landing completes leaves the new chat unmarked at its bottom (TAL-1922)', async ({ page }, testInfo) => {
  const tag = `landingcancel${String(Date.now())}${testInfo.project.name}`
  const sid = await seed(page, 'Search landing cancel', transcript(tag))
  const other = await seed(page, `${tag} other chat`, Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${tag} other ${String(i)}. `.repeat(8) })))
  // Hold the older page the landing asks for, so it cannot complete before the other chat opens.
  const older = hold()
  await page.route(`**/api/session?**session_id=${sid}**msg_before=**`, async (route) => { await older.gate; await route.fallback() })
  await page.goto('/')
  await settle(page)
  const requested = page.waitForRequest((request) => request.url().includes(`session_id=${sid}`) && request.url().includes('msg_before='))
  await (await searchFor(page, `${tag} alpha`, sid)).click()
  await requested
  await (await searchFor(page, `${tag} other chat`, other)).click()
  await expect(page).toHaveURL(new RegExp(`/session/${other}$`))
  await expect(page.locator('[data-message-key="29-assistant"]')).toBeVisible()
  older.release()
  await expect.poll(() => distance(page)).toBeLessThan(2)
  await expect(landed(page)).toHaveCount(0)
})

test('a key the transcript does not hold opens the chat at its bottom (TAL-1922)', async ({ page }, testInfo) => {
  const tag = `landingabsent${String(Date.now())}${testInfo.project.name}`
  const sid = await seed(page, 'Search landing absent', transcript(tag).slice(0, 40))
  await page.goto(`/session/${sid}?msg=missing-key`)
  await expect(page.locator('[data-message-key="39-assistant"]')).toBeVisible()
  await expect.poll(() => distance(page)).toBeLessThan(2)
  await expect(landed(page)).toHaveCount(0)
})
