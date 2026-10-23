import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

test('reviews memory compaction, keeps a refused review, and applies a fresh preview', async ({ page, errors }, info) => {
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' }, deps: (deps) => { deps.fetch = () => Promise.reject(new Error('Network forbidden in compaction validation')) } })
  sidecar.respond('write_approval.pending', () => ({ supported: true, enabled: false, items: [] }))
  const file = join(server.state, 'memories/MEMORY.md')
  const source = 'Prefers concise answers.\n§\nPrefers brief answers.\n§\nUses TypeScript for Web projects.'
  const proposed = 'Prefers concise answers. Uses TypeScript for Web projects.'
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, source)
  sidecar.respond('aux.complete', () => ({ model: 'synthetic-compression', text: JSON.stringify({ entries: [proposed] }), usage: null, finish_reason: 'stop' }))
  sidecar.respond('memory.check', ({ content }) => ({ count: content.length, limit: 2200 }))
  sidecar.respond('memory.write', ({ base, content }) => {
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== base) return { written: false }
    writeFileSync(file, content)
    return { written: true }
  })
  const evidence = process.env.TALARIA_COMPACTION_EVIDENCE
  const screenshot = async (state: string) => {
    if (!evidence) return
    mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, `${state}-${info.project.name}.png`), fullPage: true })
  }
  try {
    await page.goto(`${server.base}/memory`)
    const editor = page.getByRole('textbox', { name: 'Memory', exact: true })
    await expect(editor).toHaveValue(source)
    if (process.env.TALARIA_COMPACTION_BASELINE) { await screenshot('before'); return }
    await screenshot('saved-source')
    await page.getByRole('button', { name: 'Preview compaction' }).click()
    const review = page.getByRole('region', { name: 'Compaction preview' })
    await expect(review.getByRole('textbox', { name: 'Source' })).toHaveValue(source)
    await expect(review.getByRole('textbox', { name: 'Proposed' })).toHaveValue(proposed)
    await expect(review.getByRole('button', { name: 'Apply compaction' })).toBeInViewport()
    expect(readFileSync(file, 'utf8')).toBe(source)
    await screenshot('preview')
    writeFileSync(file, source + '\n§\nNew knowledge learned during review.')
    await page.getByRole('button', { name: 'Apply compaction' }).click()
    await expect(page.getByRole('alert')).toContainText('Review a new compaction preview')
    await expect(review).toBeVisible()
    await expect(review.getByRole('textbox', { name: 'Proposed' })).toHaveValue(proposed)
    expect(readFileSync(file, 'utf8')).toContain('New knowledge')
    // The expected refusal is part of the test, not an unhandled request failure.
    expect(errors.filter((e) => e.includes('409 POST') || e.includes('status of 409'))).toHaveLength(2)
    errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('409 POST') && !e.includes('status of 409')))
    await screenshot('refused-review')
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click()
    await expect(editor).toHaveValue(source + '\n§\nNew knowledge learned during review.')
    sidecar.respond('aux.complete', () => ({ model: 'synthetic-compression', text: JSON.stringify({ entries: [proposed, 'New knowledge learned during review.'] }), usage: null }))
    await page.getByRole('button', { name: 'Preview compaction' }).click()
    await expect(review).toBeVisible()
    await page.getByRole('button', { name: 'Apply compaction' }).click()
    await expect(review).toBeHidden()
    await expect(editor).toHaveValue(proposed + '\n§\nNew knowledge learned during review.')
    expect(readFileSync(file, 'utf8')).toBe(proposed + '\n§\nNew knowledge learned during review.')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await screenshot('applied')
  } finally {
    await server.close()
  }
})
