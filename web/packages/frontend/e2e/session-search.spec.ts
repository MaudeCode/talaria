import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

const now = Math.floor(Date.now() / 1000)
const row = (session_id: string, title: string) => ({
  session_id, title, sort_ts: now, last_message_at: now, is_streaming: false, read_only: false,
  can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true,
  source_kind: 'webui', is_messaging_session: false,
})
const alpha = row('search-alpha', 'Alpha zebra')
const content = row('search-content', 'Travel notes')

test('search retains server content matches while a replacement request loads (TAL-1390)', async ({ page }, testInfo) => {
  await page.route(/\/api\/sessions(\?|$)/, (route) => route.fulfill({ json: { sessions: [alpha, content] } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { ...alpha, messages: [] } } }))
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  let releaseAfterClear!: () => void
  const waitingAfterClear = new Promise<void>((resolve) => { releaseAfterClear = resolve })
  const terms: string[] = []
  await page.route('**/api/sessions/search?**', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q')!
    terms.push(q)
    if (q === 'zebras') await waiting
    if (q === 'alpha') await waitingAfterClear
    await route.fulfill({ json: { sessions: [{ ...content, match_type: 'content', match_preview: 'A herd of zebras' }], sidebar_filtered: true, all_profiles: false, active_profile: 'default' } })
  })
  try {
    await page.goto('/session/search-alpha')
    await settle(page)
    const hamburger = page.locator('#btnHamburger')
    if (await hamburger.isVisible()) await hamburger.click()
    const input = page.getByRole('searchbox')
    await page.getByRole('button', { name: 'Filter conversations...', exact: true }).click()
    await input.pressSequentially('zebra', { delay: 20 })
    const result = page.locator('[data-sid="search-content"]')
    await expect(result.locator('.session-search-preview')).toHaveText('A herd of zebras')
    await input.fill('zebras')
    await expect.poll(() => terms.includes('zebras')).toBe(true)
    await page.screenshot({ path: process.env.TAL1390_EVIDENCE ? `${process.env.TAL1390_EVIDENCE}/loading-${testInfo.project.name}.png` : testInfo.outputPath('loading.png') })
    await expect(result).toBeVisible()
    expect(terms).toEqual(['zebra', 'zebras'])
    release()
    await expect(result).toBeVisible()
    await input.fill('')
    await expect(page.locator('[data-sid="search-alpha"]')).toBeVisible()
    await expect(result).toBeVisible()
    await input.fill('alpha')
    await expect.poll(() => terms.includes('alpha')).toBe(true)
    await expect(page.locator('[data-sid="search-alpha"]')).toBeVisible()
    await expect(result).not.toBeAttached()
    await page.screenshot({ path: process.env.TAL1390_EVIDENCE ? `${process.env.TAL1390_EVIDENCE}/after-clear-${testInfo.project.name}.png` : testInfo.outputPath('after-clear.png') })
  } finally { release(); releaseAfterClear() }
})
