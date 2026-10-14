import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** TAL-819: the recorded sidecar answer for a staged skill create. */
const recorded = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../contracts/fixtures/sidecar/write_approval.json'), 'utf8')) as { 'write_approval.pending': { result: { items: unknown[] } }[] }
const skill = recorded['write_approval.pending'][0]!.result.items[0]
const memory = {
  id: 'f00dcafe', kind: 'memory', target: 'memory', op: 'patch', summary: "patch in memory: entry matching: tabs\nspan 'tabs' becomes: spaces", origin: 'background_review', created_at: 1,
  approvable: true, revision: 'b'.repeat(64),
  diff: '--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1,3 +1,3 @@\n-User prefers tabs over spaces\n+User prefers spaces over spaces\n §\n Deploys go through the staging host first\n',
}

test('staged writes show on the Skills and Memory pages and leave once approved or rejected', async ({ page }, testInfo) => {
  const pending: Record<string, unknown[]> = { skills: [skill], memory: [memory] }
  const reviews: unknown[] = []
  await page.route('**/api/pending-writes?**', (route) => {
    const kind = new URL(route.request().url()).searchParams.get('kind')!
    return route.fulfill({ json: { kind, visible: pending[kind]!.length > 0, enabled: true, items: pending[kind] } })
  })
  await page.route(/\/api\/pending-writes\/(approve|reject)$/, (route) => {
    const body = route.request().postDataJSON() as { kind: string; writes: { id: string; revision: string }[] }
    const verb = route.request().url().split('/').pop()
    reviews.push({ verb, ...body })
    pending[body.kind] = []
    return route.fulfill({ json: { results: body.writes.map(({ id }) => ({ id, done: true, message: `${verb === 'approve' ? 'Approved' : 'Rejected'} 1 ${body.kind} write(s).` })) } })
  })

  await page.goto('/skills')
  await settle(page)
  const skills = page.locator('#pending-skills')
  await expect(skills).toContainText("create 'demo-skill'")
  await skills.getByText('Diff').click()
  await expect(skills.locator('pre')).toContainText('name: demo-skill')
  await page.screenshot({ path: testInfo.outputPath('skills-pending.png') })
  await skills.getByRole('button', { name: 'Approve' }).click()
  await expect(skills).toHaveCount(0)

  await page.goto('/memory')
  await settle(page)
  const memories = page.locator('#pending-memory')
  await memories.getByText('Diff').click()
  await expect(memories.locator('pre')).toContainText('+User prefers spaces over spaces')
  await page.screenshot({ path: testInfo.outputPath('memory-pending.png') })
  await memories.getByRole('button', { name: 'Reject' }).click()
  await expect(memories).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('memory-after.png') })
  expect(reviews).toEqual([{ verb: 'approve', kind: 'skills', writes: [{ id: (skill as { id: string }).id, revision: (skill as { revision: string }).revision }] }, { verb: 'reject', kind: 'memory', writes: [{ id: 'f00dcafe', revision: 'b'.repeat(64) }] }])
})
