import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, expectPromptReachable, test as base } from './fixtures'

const test = base.extend<{ approval: { send: (event: string, data: unknown) => void; responses: { choice: string }[] } }>({
  approval: async ({ page }, runFixture) => {
    const sid = 'approval-dismiss'
    await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
      session_id: sid, title: 'Clean the build', active_stream_id: 'approval-run', is_streaming: true, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true,
      transcript_seq: null, messages: [{ role: 'user', id: 1, content: 'Clean the build', _turn_id: 'approval-run' }],
    } } }))
    const sessionList = await page.request.get('/api/sessions')
    expect(sessionList.ok()).toBe(true)
    const metadata = await sessionList.json()
    await page.route(/\/api\/sessions(\?|$)/, (route) => route.fulfill({ json: { ...metadata, sessions: [{ session_id: sid, title: 'Clean the build', is_streaming: true, read_only: false, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true, can_branch: true, source_kind: 'webui', is_messaging_session: false, sort_ts: 1, sidebar_group: 'recent' }], sidebar_groups: [{ kind: 'recent', title: 'Recent' }] } }))
    await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'approval-run', replay_available: false } }))
    const responses: { choice: string }[] = []
    await page.route('**/api/approval/respond', async (route) => {
      responses.push(route.request().postDataJSON())
      await route.fulfill({ json: { ok: true } })
    })
    const streams: ServerResponse[] = []
    let seq = 0
    const send = (event: string, data: unknown) => { seq += 1; for (const r of streams) r.write(`id: approval-run:${String(seq)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
      response.write(`id: approval-run:${String(++seq)}\nevent: token\ndata: ${JSON.stringify({ text: 'Cleaning up.' })}\n\n`)
      streams.push(response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture port')
    await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${String(address.port)}${new URL(route.request().url()).search}` }))
    try {
      await page.goto(`/session/${sid}`)
      await expect.poll(() => streams.length).toBeGreaterThan(0)
      await runFixture({ send, responses })
    } finally {
      for (const response of streams) response.end()
      await new Promise<void>((resolve) => server.close(() => { resolve() }))
    }
  },
})

test.use({ serviceWorkers: 'block', video: process.env.TALARIA_APPROVAL_EVIDENCE_DIR ? { mode: 'on', size: { width: 1280, height: 800 } } : 'off' })

/** The motion a browser alone can run: jsdom has no CSS transitions or animations (TAL-1783). */
test('an answered approval tucks behind the composer, and the row it held lights once', async ({ page, approval: { send } }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  // Only an evidence recording needs time to read the card.
  const pause = async (ms: number) => { if (process.env.TALARIA_APPROVAL_EVIDENCE_DIR) await page.waitForTimeout(ms) }
  const chip = page.locator('[data-notice="live"]')
  const card = page.locator('.approval-card')
  const answer = async (id: string, tool: string, command: string, button: RegExp, outcome: string, keyframes: string, row: Locator) => {
    send('tool', { id: tool, name: 'terminal', kind: 'shell', target: command })
    await expect(row).toBeVisible()
    send('approval', { approval_id: id, tool_call_id: tool, command, description: 'Force-pushing rewrites the history of the remote branch.' })
    await expect(card).toHaveClass(/visible/)
    await expect(chip).toHaveCount(0)
    await pause(1000)
    await card.getByRole('button', { name: button }).click()
    await expect(card).toHaveClass(/leaving/)
    const inner = card.locator('.approval-inner')
    expect(await inner.evaluate((el) => el.getAnimations().map((a) => (a.effect as KeyframeEffect).getTiming().duration))).toContain(320)
    await expect(card).toHaveCount(0)
    await expect(chip).toBeVisible()
    send('tool_approval', { id: tool, outcome })
    await expect.poll(() => row.evaluate((el) => el.getAnimations().map((a) => (a as CSSAnimation).animationName))).toEqual([keyframes])
    await expect.poll(() => row.evaluate((el) => el.getAnimations().length)).toBe(0)
  }
  await expect(chip).toBeVisible()
  await answer('a1', 'push', 'git push origin main --force-with-lease', /allow once/i, 'allowed', 'newflash', page.locator('[data-tool-id="push"] .tool-card-header'))
  send('tool_complete', { id: 'push', name: 'terminal', kind: 'shell', target: 'git push origin main --force-with-lease', is_error: false, duration: 1.2 })
  await answer('a2', 'reset', 'git reset --hard origin/main', /^deny$/i, 'denied', 'newflash-error', page.locator('.tool-worklog-summary'))
  send('tool_complete', { id: 'reset', name: 'terminal', kind: 'shell', target: 'git reset --hard origin/main', is_error: true, duration: 0.1 })
  await pause(700)
})

/** A dismissed approval card no longer answers Enter; the next approval shows again (TAL-503). */
test('dismissing an approval stops Enter from approving it; the next approval in the turn is visible', async ({ page, approval: { send, responses } }) => {
  const card = page.getByRole('alertdialog')
  send('approval', { approval_id: 'a1', command: 'rm -rf build' })
  await expect(card).toContainText('rm -rf build')
  await card.getByRole('button', { name: 'Dismiss approval' }).click()
  await expect(card).toHaveCount(0)
  await page.locator('body').press('Enter')
  send('approval', { approval_id: 'a2', command: 'rm -rf dist' })
  await expect(card).toContainText('rm -rf dist')
  expect(responses).toEqual([])
})

/** The command stays held while the instruction is typed; the card leaves on submit and returns on refusal (TAL-1912). */
test('a deny carries an instruction, Esc goes back, and a refusal brings the text back', async ({ page, errors, approval: { send, responses } }, info) => {
  const shot = async (state: string) => {
    if (!process.env.TALARIA_APPROVAL_EVIDENCE_DIR) return
    mkdirSync(process.env.TALARIA_APPROVAL_EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: join(process.env.TALARIA_APPROVAL_EVIDENCE_DIR, `${info.project.name}-tell-${state}.png`) })
  }
  const card = page.getByRole('alertdialog')
  const tell = card.getByRole('button', { name: 'No, and tell Hermes instead' })
  const box = card.getByRole('textbox', { name: 'What should Hermes do instead?' })
  send('approval', { approval_id: 'plain', command: 'echo no row', can_deny_with_instruction: false })
  await expect(card).toContainText('echo no row')
  await expect(tell).toHaveCount(0)
  await shot('no-row')
  send('approval', { approval_id: 'told', command: 'DROP TABLE build_cache', can_deny_with_instruction: true })
  await expect(card).toContainText('DROP TABLE build_cache')
  await shot('choices')
  await tell.click()
  await expect(box).toBeFocused()
  await expect(card).toContainText('DROP TABLE build_cache')
  await box.fill('Use INSERT OR REPLACE instead')
  await expect(card.getByRole('button', { name: 'Deny and send' })).toBeEnabled()
  await shot('typing')
  await page.keyboard.press('Escape')
  await expect(tell).toBeFocused()
  await expect(box).toHaveCount(0)
  expect(responses).toEqual([])
  await tell.click()
  await expect(box).toHaveValue('Use INSERT OR REPLACE instead')
  await page.unroute('**/api/approval/respond')
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const submitted = Promise.withResolvers<undefined>()
  const told: unknown[] = []
  await page.route('**/api/approval/respond', async (route) => {
    told.push(route.request().postDataJSON())
    submitted.resolve(undefined)
    await held
    await route.fulfill({ status: 400, json: { error: 'The Agent refused this answer' } })
  })
  await box.press('Enter')
  await expect(card).toHaveCount(0)
  await shot('left')
  // Optimistic dismissal can precede request dispatch.
  await submitted.promise
  expect(told).toEqual([expect.objectContaining({ choice: 'deny', approval_id: 'told', instruction: 'Use INSERT OR REPLACE instead' })])
  release()
  await expect(box).toHaveValue('Use INSERT OR REPLACE instead')
  await shot('refused')
  expect(told).toHaveLength(1)
  expect(responses).toEqual([])
  // This refusal is the scenario; the page logs it like any failed request.
  errors.splice(0)
})

test('menu keyboard actions retain ownership while an approval is visible', async ({ page, approval: { send, responses } }, info) => {
  const card = page.getByRole('alertdialog')
  const screenshot = async (state: string) => {
    if (!process.env.TALARIA_APPROVAL_EVIDENCE_DIR) return
    mkdirSync(process.env.TALARIA_APPROVAL_EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: join(process.env.TALARIA_APPROVAL_EVIDENCE_DIR, `${info.project.name}-${state}.png`) })
  }
  send('approval', { approval_id: 'menu-approval', command: 'echo fixture' })
  await expect(card).toContainText('echo fixture')
  if (info.project.name !== 'mobile') {
    const actions = page.locator('.session-item[data-sid="approval-dismiss"]').getByRole('button', { name: 'Conversation actions' })
    await actions.focus()
    await page.keyboard.press('Enter')
    const rename = page.getByRole('menuitem', { name: 'Rename conversation', exact: true })
    await rename.focus()
    await screenshot('rename-menu')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Rename conversation' })).toBeVisible()
    await screenshot('rename-open')
    expect(responses).toEqual([])
    await page.keyboard.press('Escape')
  }
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'More options' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Allow session', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Always allow', exact: true })).toBeFocused()
  await screenshot('always-menu')
  await page.keyboard.press('Enter')
  await expect.poll(() => responses.map((response) => response.choice)).toEqual(['always'])
  await expect(card).toHaveCount(0)
})

/** TAL-1414: an approval whose owner offered no choice Talaria can send shows why, with no answer to give. */
test('an approval offering no choice shows no answer and ignores Enter', async ({ page, approval: { send, responses } }, info) => {
  const card = page.getByRole('alertdialog')
  send('approval', { approval_id: 'no-choices', command: 'rm -rf build', allowed_choices: [], can_enable_yolo: false })
  await expect(card).toContainText('rm -rf build')
  if (process.env.TALARIA_APPROVAL_EVIDENCE_DIR) {
    mkdirSync(process.env.TALARIA_APPROVAL_EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: join(process.env.TALARIA_APPROVAL_EVIDENCE_DIR, `${info.project.name}-no-choices.png`) })
  }
  for (const name of ['Allow once', 'Deny', 'More options']) await expect(card.getByRole('button', { name, exact: true })).toHaveCount(0)
  await expect(card).toContainText("This approval can't be answered here.")
  await page.locator('body').press('Enter')
  expect(responses).toEqual([])
})

/** TAL-1943: the composer leaves a prompt card about 50 px at the iPhone Duo's outer landscape size. */
test.describe('at 594×368', () => {
  test.use({ viewport: { width: 594, height: 368 } })

  test('an approval card keeps its heading, command and every answer in reach', async ({ page, approval: { send } }, info) => {
    const card = page.getByRole('alertdialog')
    send('approval', { approval_id: 'short', command: 'rm -rf build', can_deny_with_instruction: true })
    await expect(card).toContainText('rm -rf build')
    // A wider window keeps the desktop card rules, which have no scrolling of their own.
    for (const viewport of [{ width: 594, height: 368 }, { width: 951, height: 400 }]) {
      await page.setViewportSize(viewport)
      await page.screenshot({ path: info.outputPath(`approval-${String(viewport.width)}x${String(viewport.height)}.png`) })
      await expectPromptReachable(page, card, [card.getByText('Approval required'), card.getByText('rm -rf build'), ...['Allow once', 'Deny', 'No, and tell Hermes instead', 'More options'].map((name) => card.getByRole('button', { name, exact: name === 'Deny' }))])
    }
    await page.setViewportSize({ width: 594, height: 368 })
    await card.getByRole('button', { name: 'More options' }).click()
    await expect(page.getByRole('menuitem', { name: 'Allow session', exact: true })).toBeInViewport({ ratio: 1 })
    await page.keyboard.press('Escape')
    await card.getByRole('button', { name: 'No, and tell Hermes instead' }).click()
    await expectPromptReachable(page, card, [card.getByRole('textbox', { name: 'What should Hermes do instead?' }), card.getByRole('button', { name: 'Deny and send' })])
  })

  test('a Clarify card keeps its choices in reach and collapses to reach the composer', async ({ page, approval: _approval }, info) => {
    const pending = { clarify_id: 'short', question: 'Which environment?', steps: [{ qid: 'environment', question: 'Which environment?', choices: ['Staging', 'Test', 'Production', 'Canary', 'Sandbox', 'Preview', 'Demo'], multi_select: false }] }
    await page.route('**/api/clarify/pending?**', (route) => route.fulfill({ json: { pending, pending_count: 1 } }))
    await page.reload()
    const card = page.getByRole('dialog', { name: 'Clarification needed' })
    await expect(card).toBeVisible()
    await page.screenshot({ path: info.outputPath('clarify-short.png') })
    await expectPromptReachable(page, card, [card.locator('#clarifyHeading'), card.locator('#clarifyQuestion'), ...pending.steps[0]!.choices.map((name) => card.getByRole('button', { name }))])
    await card.getByRole('button', { name: 'Collapse approval' }).click()
    await expectPromptReachable(page, card, [card.locator('#clarifyHeading'), card.getByRole('button', { name: 'Expand approval' }), page.locator('#msg'), page.locator('#btnClarifySend')])
    await page.screenshot({ path: info.outputPath('clarify-short-collapsed.png') })
  })
})

test('an approval card stays above the composer at heights over 480 px', async ({ page, approval: { send } }, info) => {
  send('approval', { approval_id: 'tall', command: 'rm -rf build' })
  const card = page.getByRole('alertdialog')
  await expect(card).toContainText('rm -rf build')
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 382, height: 580 }, { width: 669, height: 867 }, { width: 951, height: 585 }, { width: 385, height: 571 }, { width: 594, height: 481 }]) {
    await page.setViewportSize(viewport)
    await page.screenshot({ path: info.outputPath(`approval-${String(viewport.width)}x${String(viewport.height)}.png`) })
    await expect.poll(async () => { const box = (await card.boundingBox())!; return box.y + box.height }, JSON.stringify(viewport)).toBeLessThanOrEqual((await page.locator('.composer-box').boundingBox())!.y)
  }
})
