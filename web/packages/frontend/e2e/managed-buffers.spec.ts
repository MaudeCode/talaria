import { mkdirSync } from 'node:fs'
import { expect, settle, test } from './fixtures'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'

test.use({ serviceWorkers: 'block' })
test('Files uses the native managed source and reconciles a save without workspace IO', async ({ page, errors }, info) => {
  const sidecar = new FakeSidecar()
  let text = 'A session draft, independent of the workspace.\n'
  let available = true
  let readOnly = false
  sidecar.respond('plugins.buffers', ({ action, content }) => {
    if (action === 'save') text = content!
    return { supported: available, buffers: available ? [{ name: 'draft.txt', size: Buffer.byteLength(text), read_only: readOnly }] : [], content: text, size: Buffer.byteLength(text), read_only: readOnly, write_semantics: 'unconditional' }
  })
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const evidence = process.env.TAL1367_EVIDENCE
  if (evidence) mkdirSync(evidence, { recursive: true })
  const shot = async (name: string) => { if (evidence) await page.screenshot({ path: `${evidence}/${name}-${info.project.name}.png` }) }
  try {
    const created = await (await server.get('/api/session/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { session: { session_id: string } }
    const sid = created.session.session_id
    const session = await server.deps.sessionStore.get(sid)
    session.workspace = ''
    await server.deps.sessionStore.save(session)
    await page.goto(`${server.base}/session/${sid}`)
    await settle(page)
    if (info.project.name === 'mobile') await page.locator('#btnTitlebarSidePanel').click()
    else await page.getByRole('button', { name: 'Show workspace panel' }).click()
    await page.getByRole('tablist', { name: 'Side panel' }).getByRole('tab', { name: 'Files' }).click()
    if (process.env.TAL1367_BEFORE === '1') {
      await shot('before')
      return
    }
    const source = page.getByRole('combobox', { name: 'File source' })
    await source.click()
    await page.getByRole('option', { name: 'Session buffers' }).click()
    await expect(page.getByRole('treeitem', { name: 'draft.txt' })).toBeVisible()
    await shot('list')
    await page.getByRole('treeitem', { name: 'draft.txt' }).click()
    const editor = page.getByRole('textbox', { name: 'Preview' })
    await expect(editor).toHaveValue(text)
    await editor.fill('Edited in Files.\n')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('File saved', { exact: true })).toBeVisible()
    expect(text).toBe('Edited in Files.\n')
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(editor).toHaveValue(text)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await shot('editor')
    await page.getByRole('button', { name: 'About saving session buffers' }).click()
    await expect(page.getByText(/without revision checks/)).toBeVisible()
    await shot('semantics')
    await page.keyboard.press('Escape')
    readOnly = true
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(editor).toHaveAttribute('readonly', '')
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await shot('readonly')
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    available = false
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByText(/Enable and approve the devkit backend/)).toBeVisible()
    await shot('unavailable')
    expect(errors).toEqual([])
  } finally { await page.goto('about:blank'); await server.close() }
})
