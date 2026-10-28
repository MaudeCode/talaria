import { mkdirSync } from 'node:fs'
import { expect, test } from './fixtures'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { groupFixture } from '../../server/dist/test/group-fixture.js'
import { SpaShell } from '../../server/dist/spa.js'

test.use({ serviceWorkers: 'block' })

async function discussionServer() {
  const sidecar = new FakeSidecar(), fixture = groupFixture(sidecar)
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' }, deps: (deps) => {
    deps.profiles.list = () => Promise.resolve([{ name: 'default', is_default: true, display_name: 'Writer' }, { name: 'helper', display_name: 'Reviewer' }])
  } })
  return { sidecar, fixture, server }
}

test('creates a discussion, sends once, shows member replies and reconnects after reload', async ({ page }, info) => {
  const { sidecar, fixture, server } = await discussionServer()
  const evidence = process.env.TALARIA_GROUP_EVIDENCE
  try {
    if (evidence && process.env.TALARIA_GROUP_BASELINE_DIST) {
      const current = server.deps.spa
      server.deps.spa = new SpaShell(process.env.TALARIA_GROUP_BASELINE_DIST)
      await page.goto(`${server.base}/`)
      await expect(page.locator('#msg')).toBeVisible()
      mkdirSync(evidence, { recursive: true })
      await page.screenshot({ path: `${evidence}/before-${info.project.name}.png` })
      server.deps.spa = current
    }
    await page.goto(`${server.base}/groups`)
    const create = page.getByRole('button', { name: 'New discussion', exact: true }).last()
    await expect(create).toBeEnabled()
    await create.click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Architecture discussion')
    await page.getByRole('checkbox', { name: 'Writer', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Reviewer', exact: true }).check()
    await page.getByRole('dialog').getByRole('button', { name: 'New discussion', exact: true }).click()
    await expect(page.locator('#msg')).toBeVisible()
    await page.locator('#fileInput').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('note') })
    await expect(page.locator('.attach-tray [data-status=done]')).toHaveCount(1)
    await page.locator('#msg').fill('Review this proposal')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.locator('.msg-row[data-role=user]')).toHaveCount(1)
    await expect(page.locator('.msg-row[data-role=assistant]')).toHaveCount(2)
    await expect(page.locator('.msg-row[data-role=user]')).toHaveCount(1)
    await expect(page.getByRole('link', { name: 'note.txt', exact: true })).toBeVisible()
    await expect(page.getByText('First member reply', { exact: true })).toBeVisible()
    await expect(page.getByText('Second member reply', { exact: true })).toBeVisible()
    await expect(page.locator('.msg-role-name')).toHaveText(['Writer', 'Reviewer'])
    await expect(page.locator('.msg-role-name').first()).toBeVisible()
    if (info.project.name === 'mobile') {
      await expect(page.locator('.app-titlebar')).toBeInViewport()
      await expect(page.locator('.tabbar')).toBeInViewport()
    }
    for (const title of ['A long discussion name that must leave its actions reachable on a narrow screen', 'Architecture discussion']) {
      await page.getByRole('button', { name: 'Rename', exact: true }).click()
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill(title)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(() => fixture.state.room.name).toBe(title)
      await expect(page.getByRole('button', { name: 'Disband', exact: true })).toBeInViewport()
    }
    await page.reload()
    await expect(page.getByText('First member reply', { exact: true })).toBeVisible()
    if (evidence) await page.screenshot({ path: `${evidence}/after-${info.project.name}.png` })
    const sends = sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'send')
    expect(sends).toHaveLength(1)
    const native = sidecar.responderFor('gateway.groups')
    if (!native) throw new Error('Native group fixture missing')
    sidecar.respond('gateway.groups', (params, emit, options) => params.operation.action === 'send' ? { state: 'unknown', reason: 'unknown', value: null } : native(params, emit, options))
    await page.locator('#msg').fill('Unknown admission')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByText('Execution could not be confirmed. Refresh to reconcile.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
    expect(sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'send')).toHaveLength(2)
    fixture.state.room.authority_epoch++
    await expect(page.getByText('Unknown admission', { exact: true })).toHaveCount(0)
    await expect(page.locator('#msg')).toHaveValue('')
    await page.locator('#msg').fill('Draft for the replacement owner')
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
    fixture.state.driver = false
    await expect(page.getByText('Discussions are unavailable from the current Agent gateway.', { exact: true }).last()).toBeVisible()
    expect(server.deps.registry.activeRuns.size).toBe(0)
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})

for (const refusal of ['receipt', 'http'] as const) test(`restores a ${refusal}-refused send when reconciliation reads fail`, async ({ page, errors }) => {
  const { server } = await discussionServer()
  let reads = 0
  try {
    await page.goto(`${server.base}/groups?room=discussion`)
    await expect(page.locator('#msg')).toBeVisible()
    await page.locator('#fileInput').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('note') })
    await expect(page.locator('.attach-tray [data-status=done]')).toHaveCount(1)
    await page.route('**/api/groups/view?**', (route) => { reads++; return route.fulfill({ status: 503, json: { error: 'Synthetic read failure' } }) })
    await page.route('**/api/groups/receipt?**', (route) => { reads++; return route.fulfill({ status: 503, json: { error: 'Synthetic read failure' } }) })
    await page.route('**/api/groups/action', (route) => route.fulfill(refusal === 'http' ? { status: 403, json: { error: 'Synthetic write refusal' } } : { json: { outcome: 'refused', reason: 'refused', room_id: 'discussion', event_id: null, attachment: null } }))
    await page.locator('#msg').fill('Refused with a file')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.locator('#msg')).toHaveValue('Refused with a file')
    await expect(page.locator('.attach-tray [data-status=done]')).toHaveCount(1)
    await expect(page.locator('.msg-row[data-role=user]')).toHaveCount(0)
    expect(reads).toBe(0)
    if (refusal === 'http') errors.splice(0, errors.length, ...errors.filter((error) => error !== `403 POST ${server.base}/api/groups/action`))
  } finally { await page.goto('about:blank').catch(() => undefined); await server.close() }
})

for (const timing of ['response delayed', 'unknown then committed'] as const) test(`converges one submitted occurrence from the stream: ${timing}`, async ({ page }) => {
  const { sidecar, fixture, server } = await discussionServer()
  const release = Promise.withResolvers<undefined>(), submitted = Promise.withResolvers<undefined>()
  const native = sidecar.responderFor('gateway.groups')!
  let commit: (() => unknown) | undefined
  if (timing === 'unknown then committed') sidecar.respond('gateway.groups', (params, emit, options) => {
    if (params.operation.action !== 'send') return native(params, emit, options)
    commit = () => native(params, emit, options)
    return { state: 'unknown', reason: 'unknown', value: null }
  })
  try {
    // A previous equal-text occurrence must never confirm this submission.
    fixture.append('message.user', 'Same text')
    await page.goto(`${server.base}/groups?room=discussion`)
    await expect(page.locator('#msg')).toBeVisible()
    if (timing === 'response delayed') await page.route('**/api/groups/action', async (route) => {
      const response = await route.fetch()
      submitted.resolve(undefined)
      await release.promise
      await route.fulfill({ response })
    })
    await page.locator('#msg').fill('Same text')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    if (timing === 'unknown then committed') {
      await expect(page.getByText('Execution could not be confirmed. Refresh to reconcile.', { exact: true })).toBeVisible()
      await expect(page.locator('.msg-row[data-role=user]')).toHaveCount(2)
      await commit!()
    } else await submitted.promise
    await expect(page.locator('.msg-row[data-role=assistant]')).toHaveCount(2)
    await expect(page.locator('.msg-row[data-role=user]')).toHaveCount(2)
    await expect(page.getByText('Execution could not be confirmed. Refresh to reconcile.', { exact: true })).toHaveCount(0)
    await page.locator('#msg').fill('Next occurrence')
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
    expect(sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'send')).toHaveLength(1)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => sidecar.calls.filter((c) => c.method === 'gateway.groups' && (c.params as { operation: { action: string } }).operation.action === 'send').length).toBe(2)
  } finally { release.resolve(undefined); await page.goto('about:blank').catch(() => undefined); await server.close() }
})
