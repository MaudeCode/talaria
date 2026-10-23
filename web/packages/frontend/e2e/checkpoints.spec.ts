import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const owned: string[] = []
// A checkpoint's hash changes with every re-recording, so read the one the replay sidecar answers with.
const recorded = (JSON.parse(readFileSync(join(import.meta.dirname, '../../contracts/fixtures/sidecar/checkpoints.json'), 'utf8')) as { 'checkpoints.list': { result: { checkpoints: { hash: string }[] } }[] })['checkpoints.list'][0]!.result.checkpoints[0]!.hash
test.afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }) })

/**
 * TAL-571, TAL-913: the side panel's Checkpoints page lists the Agent's checkpoints for the chat's workspace, shows one's
 * diff, and restores it. The fixture replay sidecar answers `checkpoints.*` with the Agent's recorded checkpoint of an
 * edited `notes.txt`; the sidecar suite covers the real store and restore.
 */
test('the Checkpoints page lists, diffs and restores a workspace checkpoint', async ({ page, errors }, testInfo) => {
  test.skip(!process.env.HERMES_WEBUI_SIDECAR_COMMAND?.includes('replay_sidecar'), 'needs the fixture replay sidecar')
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'tal913-')))
  owned.push(workspace)
  writeFileSync(join(workspace, 'notes.txt'), 'edited by the agent\n')
  expect((await page.request.post('/api/workspaces/add', { data: { path: workspace } })).ok()).toBe(true)
  const created = (await (await page.request.post('/api/session/new', { data: { workspace } })).json()) as { session: { session_id: string } }

  await page.goto(`/session/${created.session.session_id}`)
  if (testInfo.project.name === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
  else await page.getByRole('button', { name: 'Show workspace panel' }).click()
  const tab = page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', { name: 'Checkpoints' })
  await expect(tab).toBeVisible()
  await tab.click()
  const entry = page.getByRole('list', { name: 'Checkpoints' }).getByRole('listitem').filter({ hasText: 'before write_file' })
  await expect(entry).toContainText(recorded.slice(0, 12))
  await expect(entry).toContainText('Files: 0')
  if (process.env.TAL571_SHOTS) await page.screenshot({ path: `${process.env.TAL571_SHOTS}/list-${testInfo.project.name}.png` })

  await entry.getByRole('button', { name: 'View diff' }).click()
  const diff = page.getByRole('dialog', { name: 'Changes in checkpoint' })
  await expect(diff.getByRole('list', { name: '1 file changed' })).toContainText('notes.txt')
  // A RegExp matches the raw text (a string would collapse whitespace): the Agent's git diff, one line per diff line.
  await expect(diff.locator('pre')).toHaveText(/^diff --git a\/notes\.txt b\/notes\.txt\nindex \w+\.\.\w+ 100644\n--- a\/notes\.txt\n\+\+\+ b\/notes\.txt\n@@ -1 \+1 @@\n-original text\n\+edited by the agent$/)
  if (process.env.TAL571_SHOTS) await page.screenshot({ path: `${process.env.TAL571_SHOTS}/diff-${testInfo.project.name}.png` })
  await diff.getByRole('button', { name: 'Close' }).click()
  await expect(diff).toHaveCount(0)

  await entry.getByRole('button', { name: 'Restore' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Restore checkpoint?' })
  await expect(confirm).toContainText('before write_file')
  await expect(confirm.getByRole('button', { name: 'Restore everything' })).toBeVisible()
  if (process.env.TAL571_SHOTS) await page.screenshot({ path: `${process.env.TAL571_SHOTS}/confirm-${testInfo.project.name}.png` })
  await confirm.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByText('Checkpoint restored')).toBeVisible()
  if (process.env.TAL571_SHOTS) await page.screenshot({ path: `${process.env.TAL571_SHOTS}/restored-${testInfo.project.name}.png` })
  expect(errors).toEqual([])
})

/** Native policy/transport are faked at the sidecar boundary; HTTP routing and the built UI are real. */
test('native checkpoint reads show project provenance and partial output without restore', async ({ page, errors }, testInfo) => {
  const { DatabaseSync } = await import('node:sqlite')
  const { bootTestServer } = await import('../../server/dist/test/harness.js')
  const { FakeSidecar } = await import('../../server/dist/sidecar/fake.js')
  const fixture = JSON.parse(readFileSync(new URL('../../server/src/test/fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: { cli: string }; schema: string[]; inserts: string[] }
  const comparison = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/native-checkpoint-diff.json', import.meta.url), 'utf8')) as { diff: string; comparison: { provenance: 'native_owner'; baseline: 'earliest_retained_project_checkpoint'; available: boolean; reason: 'no_baseline' | null; truncated: boolean } }
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const db = new DatabaseSync(join(server.state, 'state.db'))
  const sid = fixture.sessions.cli
  sidecar.respond('gateway.session', (_params, _emit, opts) => {
    if (_params.action === 'checkpoint_diff') return { state: 'attached', reason: null, snapshot: null, receipt: null, checkpoint_diff: { ...comparison, stat: '1 file changed' } }
    const result = { state: 'attached' as const, reason: null, receipt: null, snapshot: {
      session_id: sid, stored_session_id: sid, messages: [], message_count: 0, running: false, authority_epoch: 1,
      replay_epoch: 'epoch', last_sequence: 0, subscription_id: 'viewer', revision: 1, execution_generation: 1, pending: [], prompts: [], info: { title: 'Native checkpoints', cwd: '/owner/project' },
    } }
    if (_params.action !== 'watch') return result
    return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(result) }, { once: true }) })
  })
  try {
    db.exec(fixture.schema.join('\n'))
    for (const sql of fixture.inserts) db.exec(sql)
    await server.deps.settings.save({ show_cli_sessions: true })
    // Before evidence reproduces the original 404 at the HTTP boundary with the built panel.
    await page.route('**/api/rollback/list?**', (route) => route.fulfill({ status: 404, json: { error: 'Session not found' } }))
    await page.goto(`${server.base}/session/${sid}`)
    if (testInfo.project.name === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
    else await page.getByRole('button', { name: 'Show workspace panel' }).click()
    await page.getByRole('tab', { name: 'Checkpoints', exact: true }).click()
    await expect(page.getByText('Session not found', { exact: true })).toBeVisible()
    await expect(page.locator('#topbarTitle')).toHaveText('Native checkpoints')
    await page.screenshot({ path: testInfo.outputPath(`native-before-${testInfo.project.name}.png`) })
    const expected404 = `404 GET ${server.base}/api/rollback/list?session_id=${sid}`
    expect(errors).toEqual([expected404])
    errors.splice(errors.indexOf(expected404), 1)
    await page.unroute('**/api/rollback/list?**')
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByRole('button', { name: 'View diff', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Changes in checkpoint' })
    await expect(dialog).toContainText('Earliest retained project checkpoint')
    await expect(dialog.locator('pre')).toContainText('+after')
    await expect(page.getByRole('button', { name: 'Restore', exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`native-after-${testInfo.project.name}.png`) })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    comparison.comparison.truncated = true
    await page.getByRole('button', { name: 'View diff', exact: true }).click()
    await expect(dialog).toContainText('Partial diff.')
    await page.screenshot({ path: testInfo.outputPath(`native-partial-${testInfo.project.name}.png`) })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    comparison.comparison.available = false
    comparison.comparison.reason = 'no_baseline'
    comparison.comparison.truncated = false
    await page.getByRole('button', { name: 'View diff', exact: true }).click()
    await expect(dialog).toContainText('No retained project checkpoint is available.')
    await expect(dialog.locator('pre')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`native-unavailable-${testInfo.project.name}.png`) })
    expect(sidecar.calls.some((c) => c.method.startsWith('checkpoints.'))).toBe(false)
  } finally {
    await page.goto('about:blank')
    db.close()
    await server.close()
  }
})
