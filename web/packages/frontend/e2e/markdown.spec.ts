import { expect, test } from './fixtures'
import { hydrateAnchorActivityScenes, withTurnIds } from '../../server/dist/sessions/anchor.js'
import { redactSessionData } from '../../server/dist/redact.js'

test.use({ serviceWorkers: 'block' })

test('Markdown lists keep their numbers and bullets', async ({ page }, testInfo) => {
  const messages = [
    { role: 'user', id: 1, content: 'List the steps' },
    { role: 'assistant', id: 2, content: 'Steps:\n\n1. First step\n2. Second step\n\nNotes:\n\n- One note' },
  ]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: 'markdown-lists', title: 'List the steps', messages: redactSessionData({ messages: hydrateAnchorActivityScenes(withTurnIds(messages), {}) }, true).messages,
  } } }))
  await page.goto('/session/markdown-lists')
  const ol = page.locator('.msg-body ol').first()
  await expect(ol.getByText('Second step')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('markdown-lists.png'), fullPage: true })
  await expect(ol).toHaveCSS('list-style-type', 'decimal')
  await expect(page.locator('.msg-body ul').first()).toHaveCSS('list-style-type', 'disc')
})
