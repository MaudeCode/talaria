import { readFileSync } from 'node:fs'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })
const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/native-captured-command.json', import.meta.url), 'utf8')) as {
  target: { session_id: string; workspace: string; target_key: string }; command: Record<string, unknown>; result: { stdout: string; stderr: string; code: number }
}

test('native terminal requires Run, displays captured output, and never opens a host PTY or retries', async ({ page }, testInfo) => {
  const calls: string[] = []
  const sid = fixture.target.session_id
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Native workspace', workspace: fixture.target.workspace, messages: [],
    owner_attachment: { state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 1, execution_generation: 1, admissions: [] },
  } } }))
  await page.route('**/api/terminal/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    calls.push(path)
    if (path.endsWith('/start')) return route.fulfill({ json: fixture.target })
    if (path.endsWith('/exec')) {
      expect(route.request().postDataJSON()).toEqual(fixture.command)
      return route.fulfill({ json: fixture.result })
    }
    throw new Error(`Unexpected host terminal call ${path}`)
  })
  await page.goto(`/session/${sid}`)
  await page.locator('#msg').fill('/terminal')
  await page.locator('#btnSend').click()
  const panel = page.locator('#composerTerminalPanel')
  await expect(panel.getByRole('textbox', { name: 'Captured command' })).toBeVisible()
  await expect(panel.locator('#terminalWorkspaceLabel')).toHaveText(fixture.target.workspace)
  await expect(panel.getByText('Native owner · captured command', { exact: true })).toBeInViewport()
  await expect(panel.getByRole('separator', { name: 'Resize terminal' })).toBeInViewport()
  expect(calls).toEqual(['/api/terminal/start'])
  await page.screenshot({ path: testInfo.outputPath('native-terminal-ready.png') })
  await panel.getByRole('textbox', { name: 'Captured command' }).fill('pwd')
  await panel.getByRole('button', { name: 'Run', exact: true }).click()
  // xterm's accessibility tree exposes the actual painted output.
  await expect(panel.locator('.xterm-accessibility-tree')).toContainText('Exit code 7')
  await expect(panel.locator('.xterm-accessibility-tree')).toContainText('/workspace/native')
  await expect(panel.locator('.xterm-accessibility-tree')).toContainText('diagnostic')
  await page.screenshot({ path: testInfo.outputPath('native-terminal-output.png') })
  await expect(panel.getByRole('button', { name: 'Restart', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(panel).toHaveCount(0)
  expect(calls).toEqual(['/api/terminal/start', '/api/terminal/exec'])
})


test('records the previous native-terminal refusal for comparison', async ({ page, errors }, testInfo) => {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'native-before', title: 'Native workspace', workspace: '/workspace/native', messages: [] } } }))
  await page.route('**/api/terminal/start', (route) => route.fulfill({ status: 404, json: { error: "'Session not found'" } }))
  await page.goto('/session/native-before')
  await page.locator('#msg').fill('/terminal')
  await page.locator('#btnSend').click()
  await expect(page.locator('#composerTerminalPanel')).toHaveAttribute('data-status', 'error')
  await page.screenshot({ path: testInfo.outputPath('native-terminal-before.png') })
  await expect.poll(() => errors).toEqual([`404 POST ${process.env.HERMES_E2E_BASE_URL}/api/terminal/start`])
  errors.length = 0
})
