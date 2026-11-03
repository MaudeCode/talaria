import { expect, test } from './fixtures'
import { sessionFixture } from '../src/test/fixtures'

test.use({ serviceWorkers: 'block' })

// TAL-1838: a cold open of a session reads its transcript once; a second observer, boot invalidation or remount would read it again.
test('a cold session open reads the transcript once', async ({ page }) => {
  const sid = 'cold-read'
  const reads: number[] = []
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    const url = new URL(request.url)
    if (url.pathname === '/api/session' && url.searchParams.get('session_id') === sid) reads.push(Date.now())
  })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: sessionFixture({ session_id: sid, title: 'Cold read', messages: [{ role: 'user', id: 1, content: 'Earlier question' }, { role: 'assistant', id: 2, content: 'Earlier answer' }] }) } }))
  await page.goto(`/session/${sid}`)
  const loaded = Date.now()
  await expect(page.getByText('Earlier answer', { exact: true })).toBeVisible()
  await page.waitForTimeout(Math.max(0, 3_000 - (Date.now() - loaded)))
  expect(reads, 'one transcript read within 3 s of load').toHaveLength(1)
})
