import { Session } from '../../server/dist/sessions/session.js'
import { discussionServer } from './demo-server'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const SID = '20261117_120000_switches'
const call = (id: string, name: string, args: object) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const reply = (id: string, content: string) => ({ role: 'tool', tool_call_id: id, content })

// TAL-2341: the switches save from Settings › Chat › Tool calls, and the server's transcript follows them.
test('the Tool calls page switches what the server sends, and the Live Activity switch sits in Notifications (TAL-2341)', async ({ page }, testInfo) => {
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`), fullPage: true })
  const { server } = await discussionServer()
  try {
    const workspace = server.state
    await server.deps.sessionStore.save(new Session({
      profile: 'default', workspace, session_id: SID, title: 'Tidy the notes', messages: [
        { role: 'user', content: 'Tidy the notes and remember the deadline.' },
        { role: 'assistant', content: '', tool_calls: [call('r1', 'read_file', { path: 'notes/a.md' }), call('r2', 'read_file', { path: 'notes/b.md' }), call('m1', 'memory', { action: 'add', target: 'memory', content: 'Deadline is Friday' })] },
        reply('r1', 'a'), reply('r2', 'b'), reply('m1', '{"success":true}'),
        { role: 'assistant', content: 'Read both notes and saved the deadline.' },
      ].map((m, i) => ({ ...m, timestamp: 1_800_000_000 + i, _turn_id: 'switch-run' })),
    }, { workspace, model: null }))

    const transcript = async () => {
      await page.goto(`${server.base}/session/${SID}`)
      await settle(page)
      // The fold keeps its last state across visits.
      const worked = page.getByRole('button', { name: 'Worked' })
      if ((await worked.getAttribute('aria-expanded')) !== 'true') await worked.click()
      await page.getByRole('button', { name: 'Expand all' }).click()
    }
    await transcript()
    await expect(page.locator('[data-tool-id="m1"] .tool-card-outcome')).toBeVisible()
    await expect(page.locator('[data-tool-id="m1"] .tool-card-outcome')).toHaveText('Added 1 memory')
    await expect(page.locator('.msg-turn-summary')).toHaveText('Saved 1 memory')
    await shot('tool-call-settings-transcript-on')

    await page.goto(`${server.base}/settings/chat`)
    await settle(page)
    const link = page.getByRole('link', { name: /Tool calls/ })
    await expect(link).toContainText('9 settings')
    await expect(page.getByRole('switch', { name: 'Show tool lookups' })).toHaveCount(0)
    await link.scrollIntoViewIfNeeded()
    await shot('tool-call-settings-chat')
    await link.click()
    await expect(page).toHaveURL(/\/settings\/chat\/tool-calls$/)
    await expect(page.locator('[data-group="tool-rows"] [role="switch"]')).toHaveCount(6)
    await expect(page.locator('[data-group="around-chat"] [role="switch"]')).toHaveCount(3)
    await shot('tool-call-settings-page')
    for (const name of ['Outcomes', 'Merge repeated calls', 'Turn summary']) {
      const toggle = page.getByRole('switch', { name })
      await expect(toggle).toBeChecked()
      const saved = page.waitForResponse((response) => response.url().endsWith('/api/settings') && response.request().method() === 'POST')
      await toggle.click()
      await saved
      await expect(toggle).not.toBeChecked()
    }

    await transcript()
    // Each read keeps its own row.
    await expect(page.locator('[data-tool-id="r1"]')).toBeVisible()
    await expect(page.locator('[data-tool-id="r2"]')).toBeVisible()
    await expect(page.locator('[data-tool-id="m1"]')).toBeVisible()
    await expect(page.locator('[data-tool-id="m1"] .tool-card-outcome')).toHaveCount(0)
    await expect(page.locator('.msg-turn-summary')).toHaveCount(0)
    await shot('tool-call-settings-transcript-off')

    await page.goto(`${server.base}/settings/notifications`)
    await settle(page)
    await expect(page.locator('[data-group="live-activities"]').getByRole('switch', { name: 'Current call' })).toBeChecked()
    await shot('tool-call-settings-notifications')
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})
