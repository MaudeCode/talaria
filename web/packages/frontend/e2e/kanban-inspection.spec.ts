import { readFileSync } from 'node:fs'
import { expect, settle, test } from './fixtures'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import type { KanbanInspectionSnapshotSchema } from '@maudecode/talaria-web-contracts'
import type { z } from 'zod'

test.use({ serviceWorkers: 'block', video: 'on' })

test('timeline and accessible relationships share the server projection and existing optimistic actions', async ({ page }, testInfo) => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/kanban-inspection.json', import.meta.url), 'utf8')) as { snapshot: z.infer<typeof KanbanInspectionSnapshotSchema> }
  const snapshot = structuredClone(fixture.snapshot)
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const shown = (board: string | null | undefined) => snapshot.nodes.filter(n => !board || n.board === board)
  sidecar.respond('kanban.inspection', p => ({ ...snapshot, nodes: shown(p.board), edges: snapshot.edges.filter(e => shown(p.board).some(n => n.key === e.source)) }))
  sidecar.respond('kanban.boards', () => ({ current: 'default', read_only: false, boards: ['default', 'ops'].map(slug => ({ slug, name: slug === 'default' ? 'Release' : 'Operations', is_current: slug === 'default', counts: {}, total: shown(slug).length })) }))
  sidecar.respond('kanban.board', p => ({ changed: true, columns: ['todo', 'ready', 'running', 'done'].map(name => ({ name, label: name, tasks: shown(p.board ?? 'default').filter(n => n.task.status === name).map(n => n.task) })), latest_event_id: 4, read_only: false, tenants: [], assignees: ['builder'], filters: { tenant: null, assignee: null, include_archived: false, only_mine: false, profile: null } }))
  sidecar.respond('kanban.stats', p => ({ by_status: Object.fromEntries(['todo', 'ready', 'running', 'done'].map(status => [status, shown(p.board ?? 'default').filter(n => n.task.status === status).length])), column_order: ['todo', 'ready', 'running', 'done'] }))
  sidecar.respond('kanban.task', p => ({ task: shown(p.board).find(n => n.task.id === p.task_id)!.task, comments: [], events: [], links: { parents: [], children: [] }, link_tasks: [], runs: [], read_only: false }))
  sidecar.respond('kanban.task_log', p => ({ task_id: p.task_id, path: '', exists: false, size_bytes: 0, content: '', truncated: false }))
  const held = Promise.withResolvers<undefined>()
  sidecar.respond('kanban.patch_task', async p => {
    await held.promise
    const n = shown(p.board).find(n => n.task.id === p.task_id)!
    n.task.status = String(p.patch.status)
    return { task: n.task, read_only: false }
  })
  let live = false, sent = false
  await page.route('**/api/kanban/events/stream**', route => {
    const event = live && !sent
    if (event) sent = true
    return route.fulfill({ headers: { 'content-type': 'text/event-stream' }, body: `retry: 1000\n\nevent: hello\ndata: {"cursor":4}\n\n${event ? 'id: 5\nevent: events\ndata: {"events":[{"id":5,"task_id":"plan","kind":"updated"}],"cursor":5}\n\n' : ''}` })
  })
  const choose = async (name: string, value: string) => { await page.getByRole('combobox', { name, exact: true }).click(); await page.getByRole('option', { name: value, exact: true }).click() }
  try {
    await page.goto(`${server.base}/kanban`)
    await settle(page)
    await expect(page.getByRole('button', { name: 'Plan release', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`board-before-${testInfo.project.name}.png`), fullPage: true })
    await choose('View', 'Timeline')
    await choose('Inspection scope', 'All boards')
    const timeline = page.getByRole('region', { name: 'Timeline', exact: true })
    await expect(timeline.locator('[data-inspection-key]')).toHaveCount(6)
    await expect(timeline).toContainText('600 seconds')
    await expect(timeline).toContainText('Actual timing unknown')
    await expect(timeline.locator('[style*="width: 66.666"]')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`timeline-${testInfo.project.name}.png`), fullPage: true })
    await choose('View', 'Relationships')
    const relationships = page.getByRole('region', { name: 'Relationships', exact: true })
    const plan = relationships.locator('[data-inspection-key="default/plan"]')
    await plan.locator('summary').click()
    await expect(plan.getByRole('button', { name: 'default/ship', exact: true })).toBeVisible()
    await expect(relationships.getByText('Dependency cycle')).toHaveCount(2)
    await page.screenshot({ path: testInfo.outputPath(`relationships-${testInfo.project.name}.png`), fullPage: true })
    await plan.getByRole('button', { name: 'default/ship', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Publish notes', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await relationships.getByRole('button', { name: 'Operations audit', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Operations audit', exact: true })).toBeVisible()
    await choose('Column', 'todo')
    await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Column' })).toContainText('todo')
    expect(sidecar.calls.filter(c => c.method === 'kanban.patch_task').at(-1)?.params).toMatchObject({ board: 'ops', task_id: 'plan' })
    await page.screenshot({ path: testInfo.outputPath(`detail-${testInfo.project.name}.png`) })
    const reconciled = page.waitForResponse(r => r.url().includes('/api/kanban/inspection') && r.request().method() === 'GET')
    held.resolve(undefined)
    await (await reconciled).finished()
    await expect.poll(() => snapshot.nodes.find(n => n.key === 'ops/plan')?.task.status).toBe('todo')
    await page.keyboard.press('Escape')
    snapshot.nodes.find(n => n.key === 'ops/plan')!.task.title = 'Operations refreshed'
    live = true
    await expect(relationships.getByRole('button', { name: 'Operations refreshed', exact: true })).toBeVisible({ timeout: 6000 })
    await page.getByRole('switch', { name: 'Running + lineage' }).click()
    await expect(relationships.locator('[data-inspection-key]')).toHaveCount(3)
    await expect(relationships.getByRole('button', { name: 'Publish notes', exact: true })).toBeVisible()
    await expect(relationships.getByRole('button', { name: 'Operations refreshed', exact: true })).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    held.resolve(undefined)
    await page.goto('about:blank')
    await server.close()
  }
})
