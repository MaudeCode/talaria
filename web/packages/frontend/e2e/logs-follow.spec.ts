import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { bootDemoServer } from './demo-server'

test.use({ serviceWorkers: 'block' })

// TAL-2139: Follow acts on the Settings pane that scrolls the page, never on the log's own sideways scroller, whose
// `overflow-x: auto` a browser also computes as `overflow-y: auto`.
test('Follow pins the Settings pane to the newest log line and scrolling it up stops following', async ({ page }) => {
  const { server } = await bootDemoServer()
  try {
    const lines = Array.from({ length: 300 }, (_, i) => `2026-11-08 12:00:${String(i % 60).padStart(2, '0')},000 INFO demo: line ${String(i)}`)
    writeFileSync(join(server.state, 'logs', 'agent.log'), `${lines.join('\n')}\n`)
    await page.goto(`${server.base}/settings/logs`)
    await expect(page.getByText('demo: line 299')).toBeVisible()
    const pane = page.locator('#main .settings-main').locator('..')
    await expect.poll(() => pane.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2)

    await pane.evaluate((el) => { el.scrollTop = 0 })
    const follow = page.getByRole('switch', { name: 'Follow' })
    await expect(follow).toHaveAttribute('aria-checked', 'false')

    await follow.click()
    await expect.poll(() => pane.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2)
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})
