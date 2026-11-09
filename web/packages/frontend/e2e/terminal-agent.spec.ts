import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { Session } from '../../server/dist/sessions/session.js'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** Phone, the Duo outer display and split view, and the Duo inner display (foldable-web viewports). */
const WIDTHS = [[382, 580], [385, 571], [669, 867], [951, 585]] as const

// TAL-1974: the agent opens the session's terminal with the harness toolset's `terminal_open` and reads it with
// `terminal_read`; the transcript card's Open shows the same live terminal in the pane beside the chat, focused.
test('a terminal the agent opened shows its card, and Open focuses the live pane with the command\'s output', async ({ page }, testInfo) => {
  const sidecar = new FakeSidecar()
  // `/bin/sh` keeps the developer's shell startup files out of the terminal.
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1', SHELL: '/bin/sh' } })
  const sid = '20261109_090000_terminal'
  const now = Math.floor(Date.now() / 1000)
  const shot = async (name: string) => { if (process.env.TAL1974_SHOTS) await page.screenshot({ path: `${process.env.TAL1974_SHOTS}/${name}-${testInfo.project.name}.png` }) }
  try {
    const workspace = join(server.state, 'workspace')
    mkdirSync(workspace, { recursive: true })
    await server.deps.sessionStore.save(new Session({ session_id: sid, title: 'Release build', profile: 'default', workspace, messages: [] }, { workspace, model: null }))
    const args = { command: 'for step in compile bundle; do echo "step $step done"; done; echo BUILD-OK', title: 'Release build' }
    const reply = await sidecar.serverRequest('server.terminal_open', { caller_session_id: sid, ...args })
    if (!('result' in reply)) throw new Error(JSON.stringify(reply))
    const opened = reply.result as { terminal_id: string }
    // The agent reads the command's output while the user watches the same terminal.
    await expect.poll(async () => {
      const read = await sidecar.serverRequest('server.terminal_read', { caller_session_id: sid, terminal_id: opened.terminal_id })
      return 'result' in read ? (read.result as { output: string }).output : JSON.stringify(read)
    }).toMatch(/step bundle done\n.*BUILD-OK/s)

    const row = await server.deps.sessionStore.get(sid)
    row.messages = [
      { role: 'user', content: 'Run the release build where I can watch it', timestamp: now - 60 },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-0', function: { name: 'terminal_open', arguments: JSON.stringify(args) } }], timestamp: now - 50 },
      { role: 'tool', tool_call_id: 'call-0', content: JSON.stringify(opened), timestamp: now - 50 },
      { role: 'assistant', content: 'The build is running in the terminal; it finished with BUILD-OK.', timestamp: now - 30 },
    ]
    await server.deps.sessionStore.save(row)

    await page.goto(`${server.base}/session/${sid}`)
    await settle(page)
    const card = page.locator(`[data-terminal-card="${opened.terminal_id}"]`)
    await expect(card).toContainText('Release build')
    await expect(card).toContainText('echo BUILD-OK')
    const panel = page.locator('#composerTerminalPanel')
    await expect(panel).toHaveCount(0)
    await card.scrollIntoViewIfNeeded()
    await shot('card')

    await card.getByRole('button', { name: 'Open terminal' }).click()
    await expect(panel).toHaveAttribute('data-status', 'running')
    // The pane attached to the agent's terminal and replayed its output; it did not start another shell.
    await expect(panel.locator('.xterm-rows')).toContainText('BUILD-OK')
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.xterm') !== null)).toBe(true)
    const read = await sidecar.serverRequest('server.terminal_read', { caller_session_id: sid, terminal_id: opened.terminal_id })
    expect('result' in read && (read.result as { running: boolean }).running, 'the same terminal is still live').toBe(true)
    await shot('pane')

    const original = page.viewportSize()
    for (const [width, height] of WIDTHS) {
      await page.setViewportSize({ width, height })
      await card.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll at ${String(width)}px`).toBe(true)
      await shot(`pane-${String(width)}`)
    }
    if (original) await page.setViewportSize(original)
  } finally {
    await page.goto('about:blank')
    server.deps.terminals.closeAll()
    await server.close()
  }
})
