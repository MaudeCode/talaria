import { expect, expectNoOverflow, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/**
 * TAL-2340: a running call's row counts its time from the server's start, and a command left running in the background
 * shows its latest output line, from its Background Work record, under the row that started it. The Agent is faked at the
 * sidecar boundary (its tool frames and process registry); the server's stamping, records and the built UI are real.
 */
test('a running call counts its time and a background command shows its latest output line', async ({ page }, testInfo) => {
  const { bootTestServer } = await import('../../server/dist/test/harness.js')
  const { FakeSidecar } = await import('../../server/dist/sidecar/fake.js')
  const started = { output: 'Background process started', session_id: 'proc_dev0123456789', pid: 7, exit_code: 0, notify_on_complete: true }
  let tail = 'VITE ready in 412 ms'
  let launched = false
  let running = true
  let finish = (): void => undefined
  const sidecar = new FakeSidecar()
  sidecar.respond('process.background_list', (params) => ({ delegations: [], processes: launched ? [{
    process_id: 'proc_dev0123456789', session_key: params.session_ids[0] ?? '', command: 'npm run dev', started_at: 1_700_000_000, exited: !running, exited_at: running ? null : 1_700_000_100,
    exit_code: running ? null : 0, completion_reason: running ? '' : 'exited', watched: false, output_tail: running ? tail : '',
  }] : [] }))
  sidecar.respond('chat.start', async (params, emit) => {
    emit({ event: 'tool', data: { name: 'terminal', tid: 'dev', args: { command: 'npm run dev', background: true } } })
    launched = true
    emit({ event: 'tool_complete', data: { name: 'terminal', tid: 'dev', preview: 'Background process started', raw_result: started } })
    emit({ event: 'tool', data: { name: 'terminal', tid: 'test', args: { command: 'npm test -- auth.spec.ts' } } })
    await new Promise<void>((resolve) => { finish = resolve })
    const passing = JSON.stringify({ output: '41 passing', exit_code: 0 })
    emit({ event: 'tool_complete', data: { name: 'terminal', tid: 'test', preview: '41 passing', raw_result: passing } })
    const calls = [{ id: 'dev', type: 'function', function: { name: 'terminal', arguments: '{"command":"npm run dev","background":true}' } }, { id: 'test', type: 'function', function: { name: 'terminal', arguments: '{"command":"npm test -- auth.spec.ts"}' } }]
    return {
      status: 'completed', messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: '', tool_calls: calls }, { role: 'tool', tool_call_id: 'dev', content: JSON.stringify(started) }, { role: 'tool', tool_call_id: 'test', content: passing }, { role: 'assistant', content: 'Tests pass.' }], final_response: 'Tests pass.', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
      usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
      agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
    }
  })
  const server = await bootTestServer({ sidecar, env: { TALARIA_WEB_SKIP_ONBOARDING: '1' } })
  const shot = async (name: string) => {
    if (process.env.TAL2340_SHOTS) await page.screenshot({ path: `${process.env.TAL2340_SHOTS}/${name}-${testInfo.project.name}.png` })
  }
  try {
    const s = await server.deps.sessionStore.newSession()
    s.title = 'Run the auth tests'
    await server.deps.sessionStore.save(s)
    // The fixture answers Background Work with an empty list; this spec reads the real server's records.
    await page.route('**/api/background/tasks?**', (route) => route.continue())
    await page.clock.install()
    await page.goto(`${server.base}/session/${s.session_id}`)
    await page.locator('#msg').fill('Start the dev server, then run the auth tests')
    await page.getByRole('button', { name: 'Send message' }).click()

    const row = (id: string) => page.locator(`[data-tool-id="${id}"]`)
    const seconds = async (el: ReturnType<typeof row>) => Number((await el.textContent())!.replace('s', ''))
    // The folded run's header names the running call and counts its time.
    const header = page.locator('.tool-worklog-summary', { hasText: 'Running npm test -- auth.spec.ts' })
    const headerTime = header.locator('.tool-call-group-duration')
    await expect(headerTime).toHaveText(/^\d+s$/)
    const first = await seconds(headerTime)
    await page.clock.runFor(2_000)
    await expect.poll(() => seconds(headerTime)).toBeGreaterThanOrEqual(first + 2)
    await shot('running-folded')
    await header.click()
    const elapsed = row('test').locator('.tool-card-elapsed')
    await expect(elapsed).toBeVisible()
    await expect(elapsed).toHaveText(/^\d+s$/)
    await expect(row('dev').locator('.tool-card-output-tail')).toBeVisible()
    await expect(row('dev').locator('.tool-card-output-tail')).toHaveText('VITE ready in 412 ms')
    // A foreground call has no output line, only its timer.
    await expect(row('test').locator('.tool-card-output-tail')).toHaveCount(0)
    await shot('running')
    await expectNoOverflow(page, 'running', shot)

    // The line follows the record on the background refresh cadence.
    tail = '✓ 41 passing · auth.spec.ts › refreshes an expired session'
    await page.clock.fastForward(15_000)
    await expect(row('dev').locator('.tool-card-output-tail')).toHaveText(tail)
    finish()
    await expect(page.getByText('Tests pass.')).toBeVisible()
    await expect(page.locator('.tool-card-elapsed')).toHaveCount(0)
    // The settled transcript's row keeps the line while the process runs.
    await page.locator('.tool-worklog-summary').first().click()
    await page.getByRole('button', { name: 'Expand all' }).click()
    await expect(row('dev').locator('.tool-card-output-tail')).toBeVisible()
    await expect(row('dev').locator('.tool-card-output-tail')).toHaveText(tail)
    await shot('settled')

    // Once the process ends, its line leaves the row.
    running = false
    await page.clock.fastForward(15_000)
    await expect(page.locator('.tool-card-output-tail')).toHaveCount(0)
    await shot('process-ended')
  } finally {
    finish()
    await page.goto('about:blank').catch(() => undefined)
    await server.close()
  }
})
