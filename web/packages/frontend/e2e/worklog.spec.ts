import sceneCases from '../src/features/chat/__fixtures__/activity-scene-boundaries.json' with { type: 'json' }
import canonicalScene from '../src/features/chat/__fixtures__/activity-scene.json' with { type: 'json' }
import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'
import { hydrateAnchorActivityScenes, withTurnIds } from '../../server/dist/sessions/anchor.js'
import { publicToolFrame, redactSessionData } from '../../server/dist/redact.js'

/** Mocked transcripts pass through the server's own turn and public projection, so the page sees exactly what the server sends. */
const asServer = (messages: unknown[]): unknown[] => redactSessionData({ messages: hydrateAnchorActivityScenes(withTurnIds(messages), {}) }, true).messages as unknown[]

test.use({ serviceWorkers: 'block' })

test('expanded worklog and tool details are visually readable', async ({ page }, testInfo) => {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: 'worklog-fixture', title: 'Inspect the project', messages: asServer([
      { role: 'user', id: 1, content: 'Inspect the project' },
      { role: 'assistant', id: 2, content: 'Reading the project.', tool_calls: [
        { id: 'read-a', function: { name: 'read_file', arguments: '{"path":"README.md"}' } },
      ] },
      { role: 'tool', id: 3, tool_call_id: 'read-a', content: 'Synthetic project documentation' },
      { role: 'assistant', id: 4, content: 'The project is ready.' },
    ]),
  } } }))
  await page.goto('/session/worklog-fixture')
  const summary = page.locator('.tool-worklog-summary').first()
  await expect(summary).toBeVisible()
  await summary.click()
  await page.screenshot({ path: testInfo.outputPath('worklog-expanded.png'), fullPage: true })
  if (testInfo.project.name === 'desktop') {
    await page.setViewportSize({ width: 800, height: 800 })
    await page.screenshot({ path: testInfo.outputPath('worklog-narrow.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 800 })
  }
  const body = page.locator('.activity-body').first()
  await expect(body).toHaveCSS('opacity', '1')
  expect((await body.boundingBox())?.height).toBeGreaterThan(0)
  const tool = page.locator('[data-tool-id="read-a"]')
  await expect(tool.getByRole('button')).toBeVisible()
  await tool.getByRole('button').click()
  await expect(tool.locator('.tool-card-detail')).toHaveCSS('opacity', '1')
  await expect(tool.getByText('Synthetic project documentation', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('tool-details.png'), fullPage: true })
})

for (const limited of [false, true]) {
test(`live tool batches settle once: ${limited ? 'tool limit' : 'completed'}`, async ({ page }, testInfo) => {
  const sid = 'worklog-live'
  const closing = limited ? 'Tool budget exhausted; saved closing explanation.' : 'All files checked.'
  let finished = false
  // As the server persists the turn: every row stamped with the stream id, and a tool-limit outcome on its last row.
  const messages = [
    { role: 'user', id: 1, content: 'Inspect the files' },
    { role: 'assistant', id: 2, content: 'First pass', tool_calls: [
      { id: 'a', name: 'read_file', args: { path: 'a.txt' }, result: 'A failed', is_error: true },
    ] },
    { role: 'assistant', id: 3, content: 'Second pass', tool_calls: [
      { id: 'b', name: 'read_file', args: { path: 'b.txt' }, result: 'B contents' },
      { id: 'c', name: 'read_file', args: { path: 'c.txt' }, result: 'C contents' },
    ] },
    { role: 'assistant', id: 4, content: '', reasoning: 'Verifying the second batch.' },
    { role: 'assistant', id: 5, content: closing, ...(limited ? { _terminal_state: 'tool_limit_reached' } : {}) },
  ].map((m) => ({ ...m, _turn_id: 'worklog-run' }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Inspect the files', messages: finished ? asServer(messages) : messages.slice(0, 1), active_stream_id: finished ? null : 'worklog-run' } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'worklog-run', replay_available: true } }))
  const events: [string, Record<string, unknown>][] = [
    ['server_turn_started', { session_id: sid, stream_id: 'worklog-run', user_message_id: 1 }],
    ['token', { text: 'First pass' }],
    ['tool', { id: 'a', name: 'read_file', args: { path: 'a.txt' } }],
    ['tool_complete', { id: 'a', name: 'read_file', result_view: { text: 'A failed' }, is_error: true }],
    ['token', { text: 'Second pass' }],
    ['tool', { id: 'b', name: 'read_file', args: { path: 'b.txt' } }],
    ['tool', { id: 'c', name: 'read_file', args: { path: 'c.txt' } }],
    ['tool_complete', { id: 'b', name: 'read_file', result_view: { text: 'B contents' } }],
    ['tool_complete', { id: 'c', name: 'read_file', result_view: { text: 'C contents' } }],
    ['reasoning', { text: 'Verifying the second batch.', titles: ['Verifying results'] }],
  ]
  let stream: ServerResponse | undefined
  const server = createServer((_request, response) => {
    stream = response
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(events.map(([event, data], i) => `id: worklog-run:${i + 1}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}/stream` }))
  try {
  await page.goto(`/session/${sid}`)
  const outer = page.locator('.live-turn > .assistant-turn-blocks > .activity')
  // Live work is inline with no turn-level "Responding…" disclosure; the status is a pill docked above the composer.
  await expect(outer.locator(':scope > button')).toHaveCount(0)
  await expect(page.locator('.live-turn').getByRole('button', { name: /Responding/ })).toHaveCount(0)
  await expect(page.locator('.live-turn .live-run-status')).toHaveCount(0)
  const spinner = page.locator('.live-run-status')
  await expect(spinner).toHaveCount(1)
  await expect(spinner.locator('svg.live-laurel')).toBeVisible()
  await expect(spinner.locator('svg.live-laurel')).toHaveCSS('width', '18px')
  // The status is the first row of the composer's top tab (TAL-429), not a pill over the transcript.
  await expect(page.locator('.composer-tab .live-run-status')).toHaveCount(1)
  const group = page.locator('[data-activity-sequence-group]')
  const groupLabel = group.locator(':scope > button .tool-worklog-label')
  await expect(group).toHaveCount(1)
  await expect(group).toHaveAttribute('data-live-activity-current', '1')
  await expect(group.locator(':scope > button')).toHaveAttribute('aria-expanded', 'false')
  await expect(groupLabel).toHaveText('Verifying results')
  await expect(page.locator('[data-tool-id="a"] > button')).toBeVisible()
  await expect(page.locator('[data-activity-sequence-group] [data-tool-id="a"]')).toHaveCount(0)
  const failureColors = await page.locator('[data-tool-id="a"]').evaluate((row) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--error)'
    row.append(probe)
    const colors = {
      label: getComputedStyle(row.querySelector('.tool-card-name-label')!).color,
      icon: getComputedStyle(row.querySelector('.tool-card-icon svg')!).color,
      error: getComputedStyle(probe).color,
    }
    probe.remove()
    return colors
  })
  expect(failureColors).toEqual({ label: failureColors.error, icon: failureColors.error, error: failureColors.error })
  await expect(page.locator('[data-tool-id="b"] > button')).not.toBeVisible()
  await expect(page.locator('[data-tool-id="c"] > button')).not.toBeVisible()
  await expect(group.locator('.thinking-card')).toHaveAttribute('data-reasoning-active', '1')
  // Reduced motion (the suite default) keeps labels static; otherwise the active activity label shimmers.
  await expect(spinner.locator('.laurel-leaf').first()).toHaveCSS('animation-name', 'none')
  await expect(groupLabel).toHaveCSS('animation-name', 'none')
  await expect(groupLabel).toHaveCSS('background-image', 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(spinner.locator('.laurel-leaf').first()).toHaveCSS('animation-name', 'laurel-leaf')
  await expect(spinner.locator('.live-run-label')).toHaveCSS('animation-name', 'reasoning-title-glow')
  await expect(groupLabel).toHaveCSS('animation-name', 'reasoning-title-glow')
  await expect(groupLabel).toHaveCSS('background-image', /linear-gradient/)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(groupLabel).toHaveCSS('background-image', 'none')
  const spinnerBox = (await spinner.boundingBox())!
  const composerTop = (await page.locator('#composerBox').boundingBox())!.y
  expect(spinnerBox.y + spinnerBox.height).toBeLessThanOrEqual(composerTop)
  expect(spinnerBox.y + spinnerBox.height).toBeGreaterThan(composerTop - 40)
  if (!limited && testInfo.project.name === 'desktop') {
    await page.screenshot({ path: testInfo.outputPath('live-worklog-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 800, height: 800 })
    await page.screenshot({ path: testInfo.outputPath('live-worklog-narrow.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 800 })
  }
  await group.locator(':scope > button').click()
  for (const id of ['b', 'c']) await expect(page.locator(`[data-tool-id="${id}"] > button`)).toBeVisible()
  for (const id of ['a', 'b', 'c']) {
    await expect(page.locator(`[data-tool-id="${id}"]`)).toHaveCSS('border-top-width', '0px')
    await expect(page.locator(`[data-tool-id="${id}"]`)).toHaveCSS('border-radius', '0px')
    await expect(page.locator(`[data-tool-id="${id}"]`)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  }
  await page.locator('[data-tool-id="a"] > button').click()
  await expect(page.getByText('A failed', { exact: true })).toBeVisible()
  await expect(page.locator('[data-tool-id="a"] .tool-card-detail')).toHaveCSS('opacity', '1')
  const order = await page.locator('.live-turn .msg-body, .live-turn [data-tool-id]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-tool-id') ?? n.textContent))
  expect(order).toEqual(['First pass', 'a', 'Second pass', 'b', 'c'])
  await group.locator(':scope > button').click()
  finished = true
  stream?.write(`id: worklog-run:${events.length + 1}\nevent: done\ndata: ${JSON.stringify({ session: { session_id: sid, title: 'Inspect the files', messages: asServer(messages) }, terminal_state: limited ? 'tool_limit_reached' : 'completed' })}\n\n`)
  await expect(page.locator('.live-turn')).toHaveCount(0)
  await expect(page.locator('.assistant-turn')).toHaveCount(1)
  if (limited) await expect(page.getByRole('status').filter({ hasText: 'Tool limit reached' })).toBeVisible()
  else await expect(page.locator('.assistant-turn > .assistant-turn-blocks > .activity > button')).toContainText('Worked')
  await expect(page.locator('.live-run-status')).toHaveCount(0)
  // Settled turns keep their default disclosure; an explicit expand survives reload.
  const settled = page.locator('.assistant-turn > .assistant-turn-blocks > .activity > button')
  await expect(settled).toHaveAttribute('aria-expanded', limited ? 'true' : 'false')
  await expect(page.getByText(closing, { exact: true })).toBeVisible()
  if (limited) await settled.click()
  await settled.click()
  await expect(page.getByText('First pass', { exact: true })).toBeVisible()
  await expect(page.getByText('Second pass', { exact: true })).toBeVisible()
  // Tier-2 groups form once the turn settles, collapsed by default.
  await expect(page.locator('[data-activity-sequence-group] > button')).toHaveAttribute('aria-expanded', 'false')
  await page.reload()
  await expect(settled).toHaveAttribute('aria-expanded', 'true')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

}

test('a credential in a tool command never reaches the page, live or settled', async ({ page }) => {
  const sid = 'tool-secret'
  const token = 'synthetic-bearer-0123456789abcdef'
  const command = `curl -H "Authorization: Bearer ${token}" https://example.test`
  let finished = false
  const messages = [
    { role: 'user', id: 1, content: 'Call the API' },
    { role: 'assistant', id: 2, content: '', tool_calls: [{ id: 'curl', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command }) } }] },
    { role: 'tool', id: 3, tool_call_id: 'curl', content: 'ok' },
    { role: 'assistant', id: 4, content: 'Called it.' },
  ].map((m) => ({ ...m, _turn_id: 'secret-run' }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Secret', messages: finished ? asServer(messages) : messages.slice(0, 1), active_stream_id: finished ? null : 'secret-run' } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'secret-run', replay_available: true } }))
  // Live frames as the server sends them: the sidecar's raw args through the server's public tool frame.
  const events: [string, Record<string, unknown>][] = [
    ['server_turn_started', { session_id: sid, stream_id: 'secret-run', user_message_id: 1 }],
    ['tool', publicToolFrame({ id: 'curl', name: 'terminal', args: { command } }, true)],
    ['tool_complete', publicToolFrame({ id: 'curl', name: 'terminal', args: { command }, preview: 'ok' }, true)],
  ]
  let stream: ServerResponse | undefined
  const server = createServer((_request, response) => {
    stream = response
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(events.map(([event, data], i) => `id: secret-run:${i + 1}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}/stream` }))
  try {
    await page.goto(`/session/${sid}`)
    const card = page.locator('[data-tool-id="curl"]')
    await expect(card).toHaveAttribute('data-tool-kind', 'shell')
    await expect(card.locator('.tool-card-name')).toContainText('Ran curl -H "Authorization: Bearer synthe...cdef"')
    await card.locator('> button').click()
    await expect(card.locator('.tool-card-args')).toContainText('synthe...cdef')
    expect(await page.content()).not.toContain(token)
    finished = true
    stream?.write(`id: secret-run:${events.length + 1}\nevent: done\ndata: ${JSON.stringify({ session: { session_id: sid, title: 'Secret', messages: asServer(messages) }, terminal_state: 'completed' })}\n\n`)
    await expect(page.locator('.live-turn')).toHaveCount(0)
    await page.locator('.assistant-turn > .assistant-turn-blocks > .activity > button').click()
    const settled = page.locator('[data-tool-id="curl"]')
    await expect(settled.locator('.tool-card-name')).toContainText('Ran curl -H "Authorization: Bearer synthe...cdef"')
    // The card keeps the disclosure opened while live, so its settled arguments are on screen.
    await expect(settled.locator('> button')).toHaveAttribute('aria-expanded', 'true')
    await expect(settled.locator('.tool-card-args')).toContainText('synthe...cdef')
    expect(await page.content()).not.toContain(token)
  } finally {
    await page.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('recovered worklog can fetch its omitted history', async ({ page }) => {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    // A server tail preview: the first two of three rows are omitted and fetched on demand.
    session_id: 'worklog-history', title: 'Recovered work', messages: [{ role: 'assistant', id: 4, content: 'Recovered answer', _anchor_activity_scene: {
      version: 'activity_scene_v1', final_answer: 'Recovered answer', terminal_state: 'completed', expanded_by_default: false,
      activity_rows_total: 3, activity_rows_offset: 2, activity_rows_complete: false, activity_rows_omitted: 2, activity_scene_ref: 'scene-ref',
      activity_rows: [{ row_id: 'last', order_index: 2, role: 'prose', text: 'Latest progress' }],
    } }],
  } } }))
  await page.route('**/api/session/anchor-scene?**', (route) => {
    expect(new URL(route.request().url()).searchParams.get('before')).toBe('2')
    return route.fulfill({ json: { scene_ref: 'scene-ref', start: 0, end: 2, total: 3, complete: true, rows: [
      { row_id: 'first', order_index: 0, role: 'prose', text: 'Earlier progress' },
      { row_id: 'tool:earlier', order_index: 1, role: 'tool', tool: { id: 'earlier', name: 'read_file', args: { path: 'earlier.txt' }, preview: null, result: null, done: true, is_error: false, duration: null, cost_usd: null } },
    ] } })
  })
  await page.goto('/session/worklog-history')
  await page.locator('.tool-worklog-summary').first().click()
  await page.getByRole('button', { name: 'Show 2 earlier steps' }).click()
  await expect(page.getByText('Earlier progress', { exact: true })).toBeVisible()
  await expect(page.locator('[data-tool-id="earlier"] > button')).toBeVisible()
  await expect(page.getByRole('button', { name: /earlier steps/ })).toHaveCount(0)
  await expect(page.getByText('Recovered answer', { exact: true })).toBeVisible()
})

for (const mode of ['transparent_stream', 'hide_all_activity']) {
  test(`terminal outcome stays visible in ${mode}`, async ({ page }) => {
    await page.route('**/api/settings', (route) => route.fulfill({ json: { chat_activity_display_mode: mode } }))
    await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
      session_id: 'limited-turn', title: 'Limited turn', messages: asServer([
        { role: 'user', id: 1, content: 'Inspect' },
        { role: 'assistant', id: 2, terminal_state: 'tool_limit_reached', tool_calls: [{ id: 'limited-tool', name: 'read_file', args: { path: 'a.txt' } }] },
      ]),
    } } }))
    await page.goto('/session/limited-turn')
    await expect(page.getByText('Tool limit reached', { exact: true })).toBeVisible()
    await expect(page.locator('.tool-worklog-summary')).toHaveCount(0)
    if (mode === 'hide_all_activity') await expect(page.locator('[data-tool-id]')).toHaveCount(0)
    else await expect(page.locator('[data-tool-id="limited-tool"] > button')).toBeVisible()
  })
}


for (const paginated of [false, true]) {
test(`canonical recovered scene preserves ordering and nested reasoning: ${paginated ? 'paginated' : 'complete'}`, async ({ page }) => {
  const message = canonicalScene.session.messages[0]!
  const scene = message._anchor_activity_scene
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { ...canonicalScene.session, messages: [{ ...message, _anchor_activity_scene: { ...scene, activity_rows_offset: paginated ? 2 : 0, activity_scene_ref: 'canonical-scene', activity_rows: paginated ? scene.activity_rows.slice(2) : scene.activity_rows } }] } } }))
  await page.route('**/api/session/anchor-scene?**', (route) => route.fulfill({ json: { scene_ref: 'canonical-scene', start: 0, end: 2, total: 4, complete: true, rows: scene.activity_rows.slice(0, 2) } }))
  await page.goto('/session/abc123')
  await page.locator('.tool-worklog-summary').first().click()
  if (paginated) await page.getByRole('button', { name: 'Show 2 earlier steps' }).click()
  await page.locator('[data-activity-sequence-group] > button').click()
  await page.getByRole('button', { name: 'Planning implementation' }).click()
  await expect(page.getByText('I should inspect now.', { exact: true })).toBeVisible()
  await expect(page.locator('[data-tool-id="call-1"] > button')).toBeVisible()
  const order = await page.locator('.assistant-turn .msg-body, .assistant-turn .thinking-card, .assistant-turn [data-tool-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tool-id') ?? (node.classList.contains('thinking-card') ? 'thinking' : node.textContent)))
  expect(order).toEqual(['Before tool.', 'thinking', 'call-1', 'After tool.'])
  await expect(page.getByText('After tool.', { exact: true })).toHaveCount(1)
})
}


for (const name of ['explicitFinal', 'steering', 'activeSteering'] as const) {
  test(`restored scene boundary: ${name}`, async ({ page }) => {
    const sid = `scene-${name}`
    await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Scene boundary', messages: [sceneCases[name]] } } }))
    await page.goto(`/session/${sid}`)
    const summary = page.locator('.tool-worklog-summary').first()
    await expect(summary).toBeVisible()
    if (await summary.getAttribute('aria-expanded') === 'false') await summary.click()
    if (name === 'explicitFinal') {
      await expect(page.locator('.activity-body').getByText('Done.', { exact: true })).toHaveCount(0)
      await expect(page.getByText('Done.', { exact: true })).toHaveCount(1)
      await expect(page.locator('[data-tool-id="call-1"] > button')).toBeVisible()
    } else {
      await expect(page.locator('[data-activity-steering]')).toContainText(name === 'steering' ? 'Stop after the next sleep' : 'Stop now')
      await expect(page.locator('[data-activity-sequence-group]')).toHaveCount(0)
      const kinds = await page.locator('.assistant-turn .msg-body:not([data-activity-steering] *), .assistant-turn [data-tool-id], .assistant-turn [data-activity-steering]').evaluateAll((nodes) => nodes.map((node) => node.hasAttribute('data-activity-steering') ? 'steering' : node.hasAttribute('data-tool-id') ? 'tool' : 'prose'))
      expect(kinds).toEqual(name === 'steering' ? ['prose', 'tool', 'steering', 'tool', 'prose'] : ['prose', 'steering'])
      if (name === 'activeSteering') {
        await expect(page.locator('[data-final-answer]')).toHaveCount(0)
        await expect(summary).not.toContainText('Worked')
        await expect(page.getByText('First phase.', { exact: true })).toBeVisible()
      }
    }
  })
}

test('final-only mode retains recovered user steering', async ({ page }) => {
  await page.route('**/api/settings', (route) => route.fulfill({ json: { chat_activity_display_mode: 'hide_all_activity' } }))
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'steer-hidden', title: 'Steering', messages: [sceneCases.steering] } } }))
  await page.goto('/session/steer-hidden')
  await expect(page.locator('[data-activity-steering]')).toContainText('Stop after the next sleep')
  await expect(page.locator('[data-tool-id]')).toHaveCount(0)
  await expect(page.getByText('Done.', { exact: true })).toBeVisible()
})

test('live label box covers its glyphs so the shimmer never clips descenders', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: 'live-label', title: 'Live label', messages: [{ role: 'user', id: 1, content: 'Hello' }], active_stream_id: 'label-run' } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'label-run', replay_available: true } }))
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: label-run:1\nevent: server_turn_started\ndata: ${JSON.stringify({ session_id: 'live-label', stream_id: 'label-run', user_message_id: 1 })}\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}/stream` }))
  try {
    await page.goto('/session/live-label')
    const label = page.locator('.live-run-label')
    await expect(label).toHaveText('Responding…')
    await expect(label).toHaveCSS('animation-name', 'reasoning-title-glow')
    // background-clip:text paints only inside the box, so it must span the font's full ascent and descent.
    const { box, glyphs } = await label.evaluate((el) => {
      const style = getComputedStyle(el)
      const ctx = document.createElement('canvas').getContext('2d')!
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const m = ctx.measureText(el.textContent ?? '')
      return { box: el.getBoundingClientRect().height, glyphs: m.fontBoundingBoxAscent + m.fontBoundingBoxDescent }
    })
    expect(box).toBeGreaterThanOrEqual(glyphs)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('streaming and settlement keep a pinned transcript steady', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'frame sampling needs one stable viewport')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const sid = 'steady'
  const history = Array.from({ length: 10 }, (_, i) => [
    { role: 'user', id: 100 + i * 2, content: `Earlier question ${i + 1}` },
    { role: 'assistant', id: 101 + i * 2, content: `Earlier answer ${i + 1}. `.repeat(6) },
  ]).flat()
  const answer = 'Both files agree: the service binds to port 8080 on host 0.0.0.0. No changes are needed, and the defaults in the second file only apply when the first is missing. You can start the service as it is.'
  const turn = [{ role: 'user', id: 1, content: 'Check the config files' },
    { role: 'assistant', id: 2, content: 'Reading both files.', reasoning: 'Compare the ports.', tool_calls: [{ id: 'a', name: 'read_file', args: { path: 'a.toml' }, result: 'port = 8080' }, { id: 'b', name: 'read_file', args: { path: 'b.toml' }, result: 'port = 8080' }] },
    { role: 'assistant', id: 3, content: answer }]
  // The server stamps the turn's rows with its stream id, which is how the settled row takes over from the live turn.
  const messages = [...history, ...turn.map((m) => ({ ...m, _turn_id: 'steady-run' }))]
  let finished = false
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Steady', messages: finished ? asServer(messages) : asServer([...history, messages[history.length]]), active_stream_id: finished ? null : 'steady-run' } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'steady-run', replay_available: true } }))
  let stream: ServerResponse | undefined
  let seq = 0
  const send = (event: string, data: Record<string, unknown>) => stream?.write(`id: steady-run:${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const server = createServer((_request, response) => {
    stream = response
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    send('server_turn_started', { session_id: sid, stream_id: 'steady-run', user_message_id: 1 })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}/stream` }))
  try {
    await page.goto(`/session/${sid}`)
    await expect(page.locator('.live-run-status')).toBeVisible()
    // Sample every frame: how far content extends below the viewport, and where an older message sits.
    await page.evaluate(() => {
      const w = window as unknown as { samples: { below: number; old: number; body: number; cover: number; phase: string }[]; phase: string }
      w.samples = []; w.phase = 'stream'
      const scroller = document.getElementById('messages')!
      const old = [...document.querySelectorAll('.msg-row')].find((el) => el.textContent?.includes('Earlier question 10'))!
      const tick = () => {
        const body = document.querySelector('.assistant-turn:not(.live-turn):last-of-type .assistant-turn-blocks > .activity > .activity-body')
        const pill = document.querySelector('.live-run-status')
        const bodies = document.querySelectorAll('.live-turn .msg-body')
        const last = bodies[bodies.length - 1]
        w.samples.push({
          below: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
          old: old.getBoundingClientRect().top,
          body: body ? body.getBoundingClientRect().height : -1,
          cover: pill && last ? last.getBoundingClientRect().bottom - pill.getBoundingClientRect().top : 0,
          phase: w.phase,
        })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    send('reasoning', { text: 'Compare the ports.' })
    send('token', { text: 'Reading both files.' })
    send('tool', { id: 'a', name: 'read_file', args: { path: 'a.toml' } }); await page.waitForTimeout(150)
    send('tool', { id: 'b', name: 'read_file', args: { path: 'b.toml' } }); await page.waitForTimeout(150)
    send('tool_complete', { id: 'a', name: 'read_file', result_view: { text: 'port = 8080' } }); send('tool_complete', { id: 'b', name: 'read_file', result_view: { text: 'port = 8080' } })
    for (const word of answer.split(/(?<= )/)) { send('token', { text: word }); await page.waitForTimeout(40) }
    await page.waitForTimeout(300)
    await page.evaluate(() => { (window as unknown as { phase: string }).phase = 'settle' })
    finished = true
    send('done', { session: { session_id: sid, title: 'Steady', messages: asServer(messages) } })
    await expect(page.locator('.live-turn')).toHaveCount(0)
    await page.waitForTimeout(700)
    const samples = await page.evaluate(() => (window as unknown as { samples: { below: number; old: number; body: number; cover: number; phase: string }[] }).samples)
    // Streamed lines never stay hidden below a pinned viewport for more than a couple of frames.
    let run = 0, longest = 0
    for (const s of samples.filter((f) => f.phase === 'stream')) { run = s.below > 2 ? run + 1 : 0; longest = Math.max(longest, run) }
    expect(longest).toBeLessThanOrEqual(2)
    // The docked pill never covers the newest streamed line.
    expect(Math.max(...samples.filter((f) => f.phase === 'stream' && f.below <= 2).map((f) => f.cover))).toBeLessThanOrEqual(0)
    // The finished work visibly folds into "Worked": its body shrinks through several heights instead of vanishing.
    const folding = [...new Set(samples.filter((f) => f.phase === 'settle' && f.body > 0).map((f) => Math.round(f.body)))]
    expect(folding.length).toBeGreaterThanOrEqual(3)
    expect(samples.at(-1)!.body).toBe(0)
    // Folding into "Worked" moves older history gradually, never in one snap.
    const settle = samples.slice(Math.max(0, samples.findIndex((f) => f.phase === 'settle') - 1))
    const down = settle.slice(1).map((f, i) => f.old - settle[i]!.old).filter((d) => d > 0.5)
    const total = down.reduce((a, b) => a + b, 0)
    if (total > 4) {
      expect(down.length).toBeGreaterThanOrEqual(3)
      expect(Math.max(...down)).toBeLessThan(total * 0.6)
    }
  } finally {
    await page.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a draft typed mid-turn gets a steer arrow beside Stop (TAL-428)', async ({ page }, testInfo) => {
  const sid = 'busy-send'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Busy send', messages: [{ role: 'user', id: 1, content: 'Inspect the files', _turn_id: 'busy-run' }], active_stream_id: 'busy-run' } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'busy-run', replay_available: true } }))
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': process.env.HERMES_E2E_BASE_URL!, 'Access-Control-Allow-Credentials': 'true' })
    response.write(`id: busy-run:1\nevent: server_turn_started\ndata: ${JSON.stringify({ session_id: sid, stream_id: 'busy-run', user_message_id: 1 })}\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await page.route('**/api/chat/stream?**', (route) => route.continue({ url: `http://127.0.0.1:${address.port}/stream` }))
  try {
    await page.goto(`/session/${sid}`)
    const stop = page.getByRole('button', { name: 'Stop response' })
    const steer = page.getByRole('button', { name: 'Steer current response' })
    await expect(stop).toBeVisible()
    await expect(steer).toHaveCount(0)
    await page.locator('#msg').fill('Check b.txt too')
    await expect(steer).toBeVisible()
    // Stop stays put and the arrow sits to its right, both inside the composer.
    const [s, a, box] = await Promise.all([stop.boundingBox(), steer.boundingBox(), page.locator('#composerBox').boundingBox()])
    expect(a!.x).toBeGreaterThanOrEqual(s!.x + s!.width)
    expect(a!.x + a!.width).toBeLessThanOrEqual(box!.x + box!.width)
    await page.locator('#composerWrap').screenshot({ path: testInfo.outputPath(`busy-send-${testInfo.project.name}.png`) })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
