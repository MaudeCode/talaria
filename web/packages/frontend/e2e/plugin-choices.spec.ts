import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('a dedicated plugin command asks through the existing clarification UI without a chat turn', async ({ page }, testInfo) => {
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const session = await server.deps.sessions.create({ title: 'Plugin command choices' })
  const sid = session.session_id
  let release!: () => void
  const answer = new Promise<void>((resolve) => { release = resolve })
  sidecar.respond('commands.registry', () => ({ commands: [{ name: 'probe-choice', description: 'Choose an environment', category: 'Plugin', aliases: [], args_hint: '', subcommands: [], cli_only: false, gateway_only: false, exec: true, prompt: null }] }))
  sidecar.respond('commands.exec', async (_params, emit, opts) => {
    opts.signal?.addEventListener('abort', release, { once: true })
    emit({ event: 'clarify', data: { clarify_id: 'plugin-choice', session_id: sid, timeout_seconds: 120,
      questions: [{ qid: 'q0', question: 'Which environment?', choices: ['Development — Safe sandbox', 'Production — Live environment'], multi_select: false }] } })
    await answer
    emit({ event: 'clarify_resolved', data: { clarify_id: 'plugin-choice', session_id: sid } })
    return { output: 'Selected private-dev', source: 'plugin' }
  })
  sidecar.respond('clarify.respond', (params) => {
    expect(params).toMatchObject({ session_id: sid, clarify_id: 'plugin-choice', response: '{"answers":{"q0":"Development — Safe sandbox"}}' })
    release()
    return { ok: true, clarify_id: 'plugin-choice' }
  })
  const shot = async (state: string) => {
    const filename = `plugin-choice-${state}-${testInfo.project.name}.png`
    await page.screenshot({ path: process.env.TAL1506_SHOTS ? `${process.env.TAL1506_SHOTS}/${filename}` : testInfo.outputPath(filename) })
  }
  try {
    await page.goto(`${server.base}/session/${sid}`)
    await expect(page.locator('#msg')).toBeVisible()
    if (testInfo.project.name === 'desktop') await expect(page.locator('.session-list-note[role="status"]')).toHaveCount(0)
    await shot('before')
    await page.locator('#msg').fill('/probe-choice')
    await page.locator('#btnSend').click()
    await expect(page.locator('#clarifyCard')).toContainText('Which environment?')
    await expect(page.getByRole('button', { name: 'Development — Safe sandbox', exact: true })).toBeInViewport()
    await shot('question')
    await page.getByRole('button', { name: 'Development — Safe sandbox', exact: true }).click()
    await expect(page.locator('#clarifyCard')).toHaveCount(0)
    await page.locator('[data-notice="command"]').getByRole('button', { name: 'Command output: /probe-choice' }).click()
    await expect(page.getByRole('dialog', { name: 'Command output' })).toContainText('Selected private-dev')
    await shot('result')
    expect(sidecar.calls.filter((call) => call.method === 'commands.exec')).toHaveLength(1)
    expect(sidecar.calls.some((call) => call.method === 'chat.start')).toBe(false)
    expect((await server.deps.sessionStore.get(sid)).messages).toEqual([])
  } finally {
    release()
    await page.goto('about:blank')
    await server.close()
  }
})
