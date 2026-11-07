import { expect, settle, test } from './fixtures'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'

test.use({ serviceWorkers: 'block', video: 'on' })

test('pinned boards persist through the real settings API and fit foldable viewports', async ({ page }, info) => {
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  let current = 'default'
  const names = { default: 'Release planning', ops: 'Operations', research: 'Research and customer interviews' }
  sidecar.respond('kanban.boards', () => ({ current, read_only: false, boards: Object.entries(names).map(([slug, name]) => ({ slug, name, is_current: current === slug, counts: {}, total: 0 })) }))
  sidecar.respond('kanban.board', () => ({ changed: true, columns: [{ name: 'todo', label: 'To do', tasks: [] }], latest_event_id: 0, read_only: false, assignees: [], tenants: [], filters: { tenant: null, assignee: null, include_archived: false, only_mine: false, profile: null } }))
  sidecar.respond('kanban.stats', () => ({ by_status: { todo: 0 }, column_order: ['todo'] }))
  sidecar.respond('kanban.switch_board', p => { current = p.slug; return { current, read_only: false } })
  const choose = async (name: string) => { await page.getByRole('combobox', { name: 'Board', exact: true }).click(); await page.getByRole('option', { name, exact: true }).click() }
  const pin = async () => { await page.getByRole('button', { name: 'Board actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Pin board', exact: true }).click() }
  const pins = async () => (await (await server.get('/api/kanban/boards')).json() as { pinned: string[] }).pinned
  try {
    await page.goto(`${server.base}/kanban`)
    await settle(page)
    await expect(page.getByRole('combobox', { name: 'Board', exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('before-pinning.png'), fullPage: true })
    await pin()
    await expect.poll(pins).toEqual(['default'])
    await choose('Operations (0)')
    await pin()
    await expect.poll(pins).toEqual(['default', 'ops'])
    await choose('Research and customer interviews (0)')
    await pin()
    await expect.poll(pins).toEqual(['default', 'ops', 'research'])
    await page.getByRole('tab', { name: 'Release planning', exact: true }).click()
    await expect.poll(() => current).toBe('default')
    await page.getByRole('tab', { name: 'Release planning', exact: true }).press('Alt+ArrowRight')
    await expect.poll(pins).toEqual(['ops', 'default', 'research'])
    await expect(page.getByRole('tab', { name: 'Release planning', exact: true })).toHaveAttribute('aria-selected', 'true')
    if (info.project.name === 'desktop') {
      await page.getByRole('tab', { name: 'Operations', exact: true }).dragTo(page.getByRole('tab', { name: 'Research and customer interviews', exact: true }))
      await expect.poll(pins).toEqual(['default', 'research', 'ops'])
    }
    await page.reload()
    await expect(page.getByRole('tab', { name: 'Release planning', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.screenshot({ path: info.outputPath('after-pinning.png'), fullPage: true })
    if (info.project.name === 'desktop') {
      for (const [name, width, height] of [['outer-portrait', 382, 580], ['outer-landscape', 594, 368], ['inner-split', 385, 571], ['inner-portrait', 669, 867], ['inner-landscape', 951, 585]] as const) {
        await page.setViewportSize({ width, height })
        await expect(page.getByRole('button', { name: 'Board actions', exact: true })).toBeVisible()
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
        await page.screenshot({ path: info.outputPath(`pins-${name}.png`), fullPage: true })
      }
    }
  } finally { await server.close() }
})
