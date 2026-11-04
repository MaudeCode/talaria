import type { Locator, Page } from '@playwright/test'
import { expect, hideClipboardApi, test } from './fixtures'
import { hydrateAnchorActivityScenes, withTurnIds } from '../../server/dist/sessions/anchor.js'
import { redactSessionData } from '../../server/dist/redact.js'

// talaria.test resolves here but is not localhost, so the browser treats it as http://<lan-ip>: a real insecure origin.
test.use({ serviceWorkers: 'block', launchOptions: { args: ['--host-resolver-rules=MAP talaria.test 127.0.0.1'] } })

const TABLE = '| Fruit | Count |\n| --- | --- |\n| Apples | 3 |'
const CODE = 'print("copied over plain HTTP")'

/** Opens a session whose final answer is `content`, as the server would send it. */
async function openAnswer(page: Page, url: string, content: string): Promise<Locator> {
  const messages = [{ role: 'user', id: 1, content: 'Show it' }, { role: 'assistant', id: 2, content }]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: 'streamdown-copy', title: 'Show it', messages: redactSessionData({ messages: hydrateAnchorActivityScenes(withTurnIds(messages), {}) }, true).messages,
  } } }))
  await page.goto(`${url}/session/streamdown-copy`)
  return page.locator('[data-final-answer="1"]')
}

test('code-block Copy reaches the clipboard without the Clipboard API', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const readClipboard = await hideClipboardApi(page)
  const answer = await openAnswer(page, baseURL!, `\`\`\`python\n${CODE}\n\`\`\``)
  await answer.getByTitle('Copy Code').click()
  // The trailing newline is Streamdown's: the native API copies the same string.
  await expect.poll(readClipboard).toBe(`${CODE}\n`)
})

test('a secure origin keeps the native Clipboard API and table Copy', async ({ page, baseURL }) => {
  const answer = await openAnswer(page, baseURL!, TABLE)
  await expect(answer.getByTitle('Copy table')).toBeVisible()
  await expect(answer.getByTitle('Download table')).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard instanceof Clipboard)).toBe(true)
})

test('an insecure origin hides table Copy, keeps table download, and gives code-block Copy an API to call', async ({ page, baseURL }) => {
  const answer = await openAnswer(page, baseURL!.replace('127.0.0.1', 'talaria.test'), TABLE)
  await expect(answer.getByTitle('Download table')).toBeVisible()
  await expect(answer.getByTitle('Copy table')).toHaveCount(0)
  expect(await page.evaluate(() => [window.isSecureContext, typeof navigator.clipboard?.writeText])).toEqual([false, 'function'])
})
