import { readFileSync } from 'node:fs'
import type { GatewaySessionParams, GatewaySnapshot } from '@maudecode/talaria-web-contracts'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import type { StreamFrame } from '../../server/dist/sidecar/client.js'
import { expect, test } from './fixtures'
import { openStateDb } from './server'

test.use({ serviceWorkers: 'block' })

/**
 * TAL-1338: in a chat a native owner holds, the palette lists that owner's quick commands, typed commands and /refine run on
 * the owner (their output in the composer's command tab), and the review's later summary shows above the composer.
 */
test('runs quick commands and /refine on the owner of a native chat and shows the review summary', async ({ page }, testInfo) => {
  const fixture = JSON.parse(readFileSync(new URL('../../server/src/test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: { cli: string }; schema: string[]; inserts: string[] }
  const shared = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/web-native-commands.json', import.meta.url), 'utf8')) as {
    exec_response: { output: string }; review_summary_event: Record<string, unknown> & { payload: { text: string } }
  }
  const sid = fixture.sessions.cli
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { TALARIA_WEB_SKIP_ONBOARDING: '1' } })
  const db = openStateDb(server.state)
  let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
  const snap: GatewaySnapshot = { session_id: sid, stored_session_id: sid, messages: [{ role: 'user', content: 'Ship the release' }, { role: 'assistant', content: 'Released 2.4 to staging.' }],
    message_count: 2, running: false, authority_epoch: 1, replay_epoch: 'owner-epoch', last_sequence: 0, subscription_id: 'viewer', revision: 1, execution_generation: 1,
    pending: [], prompts: [], info: { title: 'Release' } }
  const attached = () => ({ state: 'attached' as const, reason: null, snapshot: snap, receipt: null })
  const outputs: Record<string, string> = { deploy: 'Deployed 2.4 to staging from /workspace/release', refine: shared.exec_response.output }
  sidecar.respond('commands.registry', () => ({ commands: [{ name: 'refine', description: 'Review this conversation for memory and skills', category: 'Tools & Skills', aliases: [], args_hint: '[focus]', subcommands: [], cli_only: false, gateway_only: false, exec: false, prompt: null }] }))
  sidecar.respond('gateway.session', (params, send, opts) => {
    if (params.action === 'command_catalog') return { ...attached(), snapshot: null, quick_commands: [{ name: 'deploy', description: 'exec: ./scripts/deploy.sh' }] }
    if (params.action === 'command_dispatch') return { ...attached(), snapshot: null, command_result: { kind: 'output' as const, output: outputs[params.name!]! } }
    if (params.action !== 'watch') return attached()
    emit = send
    send({ event: 'snapshot', data: attached() })
    return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached()) }, { once: true }) })
  })
  const shot = async (name: string) => {
    await page.screenshot({ path: process.env.TAL1338_SHOTS ? `${process.env.TAL1338_SHOTS}/${name}-${testInfo.project.name}.png` : testInfo.outputPath(`${name}-${testInfo.project.name}.png`) })
  }
  const composer = page.locator('#msg')
  const run = async (typed: string, output: string) => {
    await composer.fill(typed)
    await page.locator('#btnSend').click()
    await page.locator('[data-notice="command"]').getByRole('button', { name: `Command output: ${typed}` }).click()
    const dialog = page.getByRole('dialog', { name: 'Command output' })
    await expect(dialog.getByRole('region', { name: 'Command output' })).toContainText(output)
    return dialog
  }
  try {
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    await server.deps.settings.save({ show_cli_sessions: true })
    await page.goto(`${server.base}/session/${sid}`)
    await expect(page.locator('#messages')).toContainText('Released 2.4 to staging.')
    await expect.poll(() => Boolean(emit)).toBe(true)
    await composer.fill('/dep')
    await expect(page.getByRole('option', { name: /\/deploy/ })).toBeVisible()
    await shot('palette')
    const deploy = await run('/deploy now', outputs.deploy!)
    await shot('quick-command-output')
    await deploy.press('Escape')
    const refine = await run('/refine deploy steps', outputs.refine!)
    await shot('refine-started')
    await refine.press('Escape')
    emit!({ event: 'event', data: { ...shared.review_summary_event, session_id: sid, seq: 1 } })
    await expect(page.locator('#composerWrap').getByText(shared.review_summary_event.payload.text)).toHaveCount(1)
    await shot('review-summary')
    await expect(page.locator('#messages')).not.toContainText('/refine')
    const dispatched = sidecar.calls.filter((c) => c.method === 'gateway.session' && (c.params as GatewaySessionParams).action === 'command_dispatch').map((c) => (c.params as GatewaySessionParams).name)
    expect(dispatched).toEqual(['deploy', 'refine'])
    expect(sidecar.calls.filter((c) => ['commands.exec', 'chat.refine', 'chat.start'].includes(c.method))).toEqual([])
  } finally {
    await page.goto('about:blank')
    db.close()
    await server.close()
  }
})
