import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/**
 * TAL-1649: the side panel's Skills page shows the skills a conversation loaded, as the server counted them from real
 * turns. The Agent is faked at the sidecar boundary (its `skill_view` completions and the skills library); the server's
 * counting, HTTP routing, panel refresh and the built UI are real.
 */
test('the Skills page lists a conversation’s skill loads and refreshes counts with the open skill kept', async ({ page, errors }, testInfo) => {
  const { bootTestServer } = await import('../../server/dist/test/harness.js')
  const { FakeSidecar } = await import('../../server/dist/sidecar/fake.js')
  const library = [
    { name: 'code-review', description: 'Review a diff for bugs and style', category: 'software', disabled: false },
    { name: 'deploy', description: 'Ship the current branch', category: 'devops', disabled: false },
  ]
  const sidecar = new FakeSidecar()
  sidecar.respond('skills.list', () => ({ success: true, skills: library, categories: [], count: library.length }))
  sidecar.respond('skills.view', (params) => ({ success: true, name: params.name, description: 'd', tags: [], related_skills: [], content: `# ${params.name}\n\nSteps for ${params.name}.`, path: `/skills/${params.name}/SKILL.md`, skill_dir: `/skills/${params.name}`, linked_files: {} }))
  let loads: string[] = []
  sidecar.respond('chat.start', (params, emit) => {
    loads.forEach((name, i) => {
      emit({ event: 'tool', data: { name: 'skill_view', tid: `t${String(i)}`, args: { name } } })
      emit({ event: 'tool_complete', data: { event_type: 'tool.completed', name: 'skill_view', tid: `t${String(i)}`, preview: 'ok', raw_result: { success: true, name } } })
    })
    return {
      status: 'completed', messages: [...params.conversation_history, { role: 'user', content: params.user_message }, { role: 'assistant', content: 'Done.' }], final_response: 'Done.', error: null, failed: false, partial: false, compression_exhausted: false, tool_limit_reached: false, max_iterations_summary_request: '',
      usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: 0 }, context: { context_length: 200000 }, model: 'test-model', provider: 'test', compressed: false,
      agent_session_id: 'x', token_sent: true, pending_steer: '', live_tool_calls: [],
    }
  })
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const turn = async (sid: string, names: string[]) => {
    loads = names
    const res = await page.request.post(`${server.base}/api/chat/start`, { data: { session_id: sid, message: `use ${names.join(', ')}` } })
    expect(res.ok()).toBe(true)
    await server.deps.turns.finished(((await res.json()) as { stream_id: string }).stream_id)
  }
  const session = async (title: string) => {
    const s = await server.deps.sessionStore.newSession()
    s.title = title
    s.messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]
    s.context_messages = structuredClone(s.messages)
    await server.deps.sessionStore.save(s)
    return s.session_id
  }
  try {
    const sid = await session('Skill provenance')
    const empty = await session('No skills yet')
    await turn(sid, ['code-review', 'deploy', 'code-review', 'retired-skill'])
    await page.addInitScript((origin) => { if (location.origin === origin) localStorage.setItem('talaria-right-panel-page', 'skills') }, server.base)
    const openPanel = async () => {
      await page.getByText('hello', { exact: true }).waitFor()
      // The panel's open state persists across chats: open the desktop panel when its toggle offers to, the phone
      // drawer when its tabs are off screen.
      if (testInfo.project.name !== 'mobile') {
        const show = page.getByRole('button', { name: 'Show workspace panel' })
        if (await show.isVisible()) await show.click()
        return
      }
      const box = await page.getByRole('tablist', { name: 'Side panel' }).boundingBox()
      if (!box || box.x < 0 || box.x + box.width > page.viewportSize()!.width) await page.locator('#btnTitlebarSidePanel').click()
    }

    await page.goto(`${server.base}/session/${empty}`)
    await openPanel()
    const tabs = page.getByRole('tablist', { name: 'Side panel' })
    // Files and Skills stay separate pages with separate labels.
    await expect(tabs.getByRole('tab', { name: 'Files', exact: true })).toBeVisible()
    await expect(tabs.getByRole('tab', { name: 'Skills', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('No skills used in this chat yet.')).toBeVisible()

    await page.goto(`${server.base}/session/${sid}`)
    await openPanel()
    const list = page.getByRole('list', { name: 'Skills' })
    // A narrow panel keeps every tab label whole and scrolls the selected one fully into view.
    const strip = page.getByRole('tablist', { name: 'Side panel' })
    await expect(strip.getByRole('tab', { name: 'Checkpoints', exact: true })).toHaveText('Checkpoints')
    await expect.poll(() => strip.evaluate((el) => { const b = el.getBoundingClientRect(); const t = el.querySelector('[aria-selected="true"]')!.getBoundingClientRect(); return t.left >= b.left - 0.5 && t.right <= b.right + 0.5 })).toBe(true)
    await expect(list.getByRole('listitem')).toHaveText([/code-review.*2 uses/, /deploy.*1 use$/, /retired-skill.*1 use$/])
    // A skill the library no longer has keeps its count with nothing to open.
    await expect(list.getByRole('listitem').nth(2).getByRole('button')).toHaveCount(0)
    const review = list.getByRole('button', { name: /code-review/ })
    expect((await review.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await page.screenshot({ path: testInfo.outputPath(`skills-list-${testInfo.project.name}.png`) })

    await review.focus()
    await page.keyboard.press('Enter')
    await expect(review).toHaveAttribute('aria-expanded', 'true')
    await expect(list.locator('pre')).toContainText('Steps for code-review.')
    await page.screenshot({ path: testInfo.outputPath(`skills-open-${testInfo.project.name}.png`) })

    // Another turn's loads arrive while the skill stays open.
    await turn(sid, ['deploy', 'deploy'])
    await expect(list.getByRole('listitem')).toHaveText([/deploy.*3 uses/, /code-review.*2 uses/, /retired-skill.*1 use$/])
    await expect(review).toHaveAttribute('aria-expanded', 'true')
    await expect(list.locator('pre')).toContainText('Steps for code-review.')
    await page.screenshot({ path: testInfo.outputPath(`skills-refreshed-${testInfo.project.name}.png`) })
    // Reading a skill from the panel is a library preview, never a use.
    expect(sidecar.calls.filter((c) => c.method === 'skills.view')).toHaveLength(1)
    expect(errors).toEqual([])
  } finally {
    await page.goto('about:blank')
    await server.close()
  }
})
