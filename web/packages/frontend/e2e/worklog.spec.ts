import sceneCases from '../src/features/chat/__fixtures__/activity-scene-boundaries.json' with { type: 'json' }
import canonicalScene from '../src/features/chat/__fixtures__/activity-scene.json' with { type: 'json' }
import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('expanded worklog and tool details are visually readable', async ({ page }, testInfo) => {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: 'worklog-fixture', title: 'Inspect the project', messages: [
      { role: 'user', id: 1, content: 'Inspect the project' },
      { role: 'assistant', id: 2, content: 'Reading the project.', tool_calls: [
        { id: 'read-a', function: { name: 'read_file', arguments: '{"path":"README.md"}' } },
      ] },
      { role: 'tool', id: 3, tool_call_id: 'read-a', content: 'Synthetic project documentation' },
      { role: 'assistant', id: 4, content: 'The project is ready.' },
    ],
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
test(`live tool batches settle once: ${limited ? 'tool limit' : 'completed'}`, async ({ page }) => {
  const sid = 'worklog-live'
  const closing = limited ? 'Tool budget exhausted; saved closing explanation.' : 'All files checked.'
  let finished = false
  const messages = [
    { role: 'user', id: 1, content: 'Inspect the files' },
    { role: 'assistant', id: 2, content: 'First pass', tool_calls: [
      { id: 'a', name: 'read_file', args: { path: 'a.txt' }, result: 'A contents' },
      { id: 'b', name: 'read_file', args: { path: 'b.txt' }, result: 'B contents' },
    ] },
    { role: 'assistant', id: 3, content: 'Second pass', tool_calls: [{ id: 'c', name: 'read_file', args: { path: 'c.txt' } }] },
    { role: 'assistant', id: 4, content: closing },
  ]
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: { session_id: sid, title: 'Inspect the files', messages: finished ? messages : messages.slice(0, 1), active_stream_id: finished ? null : 'worklog-run' } } }))
  await page.route('**/api/chat/stream/status?**', (route) => route.fulfill({ json: { active: true, stream_id: 'worklog-run', replay_available: true } }))
  const events: [string, Record<string, unknown>][] = [
    ['server_turn_started', { session_id: sid, stream_id: 'worklog-run', user_message_id: 1 }],
    ['token', { text: 'First pass' }],
    ['tool', { id: 'a', name: 'read_file', args: { path: 'a.txt' } }],
    ['tool', { id: 'b', name: 'read_file', args: { path: 'b.txt' } }],
    ['tool_complete', { id: 'a', name: 'read_file', result: 'A contents' }],
    ['tool_complete', { id: 'b', name: 'read_file', result: 'B contents' }],
    ['token', { text: 'Second pass' }],
    ['tool', { id: 'c', name: 'read_file', args: { path: 'c.txt' } }],
    ['tool_complete', { id: 'c', name: 'read_file', result: 'C contents' }],
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
  // Live work is inline: no turn-level "Responding…" disclosure, and the spinner sits below the streamed text.
  await expect(page.locator('[data-tool-id="c"] > button')).toBeVisible()
  await expect(outer.locator(':scope > button')).toHaveCount(0)
  await expect(page.locator('.live-turn').getByRole('button', { name: /Responding/ })).toHaveCount(0)
  const spinner = page.locator('.live-turn .live-run-status')
  await expect(spinner).toHaveCount(1)
  await expect(spinner.locator('svg.live-laurel')).toBeVisible()
  await expect(spinner.locator('svg.live-laurel')).toHaveCSS('width', '24px')
  // Reduced motion (the suite default) shows a still wreath and a plain label; otherwise the leaves and gold shimmer animate.
  await expect(spinner.locator('.laurel-leaf').first()).toHaveCSS('animation-name', 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(spinner.locator('.laurel-leaf').first()).toHaveCSS('animation-name', 'laurel-leaf')
  await expect(spinner.locator('.live-run-label')).toHaveCSS('animation-name', 'reasoning-title-glow')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const activityBox = await outer.boundingBox()
  const spinnerBox = await spinner.boundingBox()
  expect(spinnerBox!.y).toBeGreaterThanOrEqual(activityBox!.y + activityBox!.height)
  await expect(page.locator('[data-activity-sequence-group]')).toHaveCount(1)
  const nested = page.locator('[data-activity-sequence-group] > button')
  await nested.click()
  await expect(page.locator('[data-tool-id="a"] > button')).toBeVisible()
  await page.locator('[data-tool-id="a"] > button').click()
  await expect(page.getByText('A contents', { exact: true })).toBeVisible()
  await expect(page.locator('[data-tool-id="a"] .tool-card-detail')).toHaveCSS('opacity', '1')
  const order = await page.locator('.live-turn .msg-body, .live-turn [data-tool-id]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-tool-id') ?? n.textContent))
  expect(order).toEqual(['First pass', 'a', 'b', 'Second pass', 'c'])
  finished = true
  stream?.write(`id: worklog-run:10\nevent: done\ndata: ${JSON.stringify({ session: { session_id: sid, title: 'Inspect the files', messages }, terminal_state: limited ? 'tool_limit_reached' : 'completed' })}\n\n`)
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
  await expect(page.locator('[data-activity-sequence-group] > button')).toHaveAttribute('aria-expanded', 'true')
  await page.reload()
  await expect(settled).toHaveAttribute('aria-expanded', 'true')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

}

test('recovered worklog can fetch its omitted history', async ({ page }) => {
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: 'worklog-history', title: 'Recovered work', messages: [{ role: 'assistant', id: 4, content: 'Recovered answer', _anchor_activity_scene: {
      version: 'activity_scene_v1', activity_rows_offset: 2, activity_scene_ref: 'scene-ref',
      activity_rows: [{ row_id: 'last', role: 'prose', text: 'Latest progress' }],
    } }],
  } } }))
  await page.route('**/api/session/anchor-scene?**', (route) => {
    expect(new URL(route.request().url()).searchParams.get('before')).toBe('2')
    return route.fulfill({ json: { scene_ref: 'scene-ref', start: 0, end: 2, total: 3, complete: true, rows: [
      { row_id: 'first', role: 'prose', text: 'Earlier progress' },
      { row_id: 'tool', role: 'tool', tool_call_id: 'earlier', tool: { name: 'read_file', args: { path: 'earlier.txt' }, done: true } },
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
      session_id: 'limited-turn', title: 'Limited turn', messages: [
        { role: 'user', id: 1, content: 'Inspect' },
        { role: 'assistant', id: 2, terminal_state: 'tool_limit_reached', tool_calls: [{ id: 'limited-tool', name: 'read_file', args: { path: 'a.txt' } }] },
      ],
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
      const kinds = await page.locator('.assistant-turn .msg-body, .assistant-turn [data-tool-id], .assistant-turn [data-activity-steering]').evaluateAll((nodes) => nodes.map((node) => node.hasAttribute('data-activity-steering') ? 'steering' : node.hasAttribute('data-tool-id') ? 'tool' : 'prose'))
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
