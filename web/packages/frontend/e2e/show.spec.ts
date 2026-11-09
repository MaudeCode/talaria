import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { Session } from '../../server/dist/sessions/session.js'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

/** Phone, the Duo outer display and split view, and the Duo inner display (foldable-web viewports). */
const WIDTHS = [[382, 580], [385, 571], [669, 867], [951, 585]] as const
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000010000000100802000000909168360000001649444154789c63d0a83841126218d530aa61f86a0000c34a681005a20e7b0000000049454e44ae426082', 'hex')
/** The page reports what its sandbox lets it reach: its cookie, and the API the app it sits in serves. */
const PAGE = `<!doctype html><html><body style="font-family:sans-serif;margin:12px"><h1 style="font-size:18px">Release checklist</h1><ul><li>Build passes</li><li>Notes written</li></ul>
<p id="cookie">cookie: pending</p><p id="api">api: pending</p><script>
let cookie; try { cookie = document.cookie === '' ? 'empty' : 'readable' } catch (e) { cookie = 'blocked' }
document.getElementById('cookie').textContent = 'cookie: ' + cookie
fetch('/api/sessions', { credentials: 'include' }).then((r) => { document.getElementById('api').textContent = 'api: reached ' + r.status }, () => { document.getElementById('api').textContent = 'api: blocked' })
</script></body></html>`

// TAL-1968: the agent shows a file, a table, a chart and an HTML page through the harness toolset's `show`; the
// transcript renders each from the server's block, and the page runs in a sandbox with no cookie and no API.
test('renders every show block kind, and the HTML frame reaches neither the session cookie nor /api', async ({ page, errors }, testInfo) => {
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const sid = '20261109_090000_showcase'
  const now = Math.floor(Date.now() / 1000)
  const shot = async (name: string) => { if (process.env.TAL1968_SHOTS) await page.screenshot({ path: `${process.env.TAL1968_SHOTS}/${name}-${testInfo.project.name}.png`, fullPage: true }) }
  try {
    const workspace = join(server.state, 'workspace')
    mkdirSync(join(workspace, 'reports'), { recursive: true })
    writeFileSync(join(workspace, 'reports', 'funnel.png'), PNG)
    writeFileSync(join(workspace, 'notes.md'), '# Release notes\n\n- Faster startup\n')
    await server.deps.sessionStore.save(new Session({ session_id: sid, title: 'Release review', profile: 'default', workspace, messages: [] }, { workspace, model: null }))
    const calls: [string, Record<string, unknown>][] = [
      ['file', { path: 'reports/funnel.png', title: 'Signup funnel' }],
      ['file', { path: 'notes.md' }],
      ['table', { title: 'Latency by region', columns: ['Region', 'p50 ms', 'p99 ms'], rows: [['us-east', 42, 180], ['eu-west', 57, 210], ['ap-south', 88, 340]] }],
      ['chart', { title: 'Requests per day', kind: 'bar', series: [{ name: 'Requests', points: [{ label: 'Mon', value: 1200 }, { label: 'Tue', value: 1850.5 }, { label: 'Wed', value: 900 }, { label: 'Thu', value: 1400 }] }] }],
      ['chart', { title: 'Error rate', kind: 'line', unit: '%', series: [{ name: 'API', points: [{ label: 'Mon', value: 1.5 }, { label: 'Tue', value: 0.75 }, { label: 'Wed', value: 2 }, { label: 'Thu', value: 1.25 }] }] }],
      ['html', { title: 'Release checklist', body: PAGE }],
    ]
    const ids: string[] = []
    const row = await server.deps.sessionStore.get(sid)
    row.messages = [{ role: 'user', content: 'Show me the release status', timestamp: now - 60 }]
    for (const [index, [kind, payload]] of calls.entries()) {
      const reply = await sidecar.serverRequest('server.show_put', { caller_session_id: sid, kind, payload })
      if (!('result' in reply)) throw new Error(JSON.stringify(reply))
      const result = reply.result as { block_id: string }
      ids.push(result.block_id)
      row.messages.push(
        { role: 'assistant', content: '', tool_calls: [{ id: `call-${String(index)}`, function: { name: 'show', arguments: JSON.stringify({ kind, payload }) } }], timestamp: now - 50 + index },
        { role: 'tool', tool_call_id: `call-${String(index)}`, content: JSON.stringify(result), timestamp: now - 50 + index },
      )
    }
    row.messages.push({ role: 'assistant', content: 'Here is where the release stands.', timestamp: now - 30 })
    await server.deps.sessionStore.save(row)
    // A cookie the app's own pages carry; the sandboxed page must not see it.
    await page.context().addCookies([{ name: 'talaria_probe', value: 'secret', url: server.base }])
    const apiFromFrame: string[] = []
    page.on('request', (request) => { if (request.frame() !== page.mainFrame() && new URL(request.url()).pathname.startsWith('/api/')) apiFromFrame.push(request.url()) })

    await page.goto(`${server.base}/session/${sid}`)
    await settle(page)
    const block = (index: number) => page.locator(`[data-show-block="${ids[index]!}"]`)
    await expect(block(0)).toHaveAttribute('data-kind', 'file')
    const image = block(0).locator('img[alt="Signup funnel"]')
    await image.scrollIntoViewIfNeeded()
    await expect(image).toHaveJSProperty('naturalWidth', 16)
    await expect(block(1)).toContainText('notes.md')
    await expect(block(2).getByRole('table', { name: 'Latency by region' })).toContainText('ap-south')
    await expect(block(3).getByRole('img', { name: 'Requests per day: peak 1,850.5 at Tue' })).toBeVisible()
    await expect(block(4).locator('polyline')).toHaveCount(1)
    const frame = page.frameLocator(`[data-show-block="${ids[5]!}"] iframe`)
    await expect(frame.locator('#cookie')).toHaveText(/cookie: (blocked|empty)/)
    await expect(frame.locator('#api')).toHaveText('api: blocked')
    expect(apiFromFrame, 'the frame made no API request').toEqual([])
    // The page's own refused fetch, and the service-worker blocking Playwright applies to every frame, which an opaque origin refuses.
    errors.splice(0, errors.length, ...errors.filter((e) => !/Content Security Policy.*|Refused to connect because it violates the document's Content Security Policy|Service worker is disabled because the context is sandboxed/.test(e)))
    await shot('blocks')
    // Headless capture leaves a sandboxed frame blank; the evidence shot opens the frame's own URL as a page.
    if (process.env.TAL1968_SHOTS) {
      const framePage = await page.context().newPage()
      await framePage.goto(String(await page.locator(`[data-show-block="${ids[5]!}"] iframe`).getAttribute('src')))
      await framePage.screenshot({ path: `${process.env.TAL1968_SHOTS}/html-page-${testInfo.project.name}.png` })
      await framePage.close()
    }
    for (const index of [0, 2, 3, 4, 5]) {
      await block(index).scrollIntoViewIfNeeded()
      await shot(`kind-${String(index)}`)
    }

    const original = page.viewportSize()
    for (const [width, height] of WIDTHS) {
      await page.setViewportSize({ width, height })
      for (const index of [2, 3, 5]) {
        await block(index).scrollIntoViewIfNeeded()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll at ${String(width)}px`).toBe(true)
        await shot(`block-${String(index)}-${String(width)}`)
      }
    }
    if (original) await page.setViewportSize(original)

    // Open on the text file shows it on the side panel's Files page.
    await block(1).getByRole('button', { name: 'Open' }).click()
    await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('Faster startup')).toBeVisible()
    await shot('file-open')
  } finally {
    await page.goto('about:blank')
    await server.close()
  }
})

// TAL-1971: the agent hands over files with the harness toolset's `deliver`; each row offers Download (and Open for a
// viewable file), names the file's size and type, survives a reload as it was, and notes a file changed after delivery.
test('renders delivered files with Download, and notes one that changed after delivery', async ({ page }, testInfo) => {
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const sid = '20261109_090000_delivery'
  const now = Math.floor(Date.now() / 1000)
  const shot = async (name: string) => { if (process.env.TAL1968_SHOTS) await page.screenshot({ path: `${process.env.TAL1968_SHOTS}/deliver-${name}-${testInfo.project.name}.png`, fullPage: true }) }
  try {
    const workspace = join(server.state, 'workspace')
    mkdirSync(join(workspace, 'reports'), { recursive: true })
    mkdirSync(join(workspace, 'dist'), { recursive: true })
    writeFileSync(join(workspace, 'reports', 'week-45.md'), '# Week 45\n\nSignups up 12%.\n')
    writeFileSync(join(workspace, 'reports', 'funnel.png'), PNG)
    writeFileSync(join(workspace, 'dist', 'build.zip'), Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]))
    await server.deps.sessionStore.save(new Session({ session_id: sid, title: 'Weekly report', profile: 'default', workspace, messages: [] }, { workspace, model: null }))
    const calls: Record<string, unknown>[] = [{ path: 'reports/week-45.md', title: 'Weekly report' }, { path: 'reports/funnel.png', title: 'Signup funnel' }, { path: 'dist/build.zip' }]
    const ids: string[] = []
    const row = await server.deps.sessionStore.get(sid)
    row.messages = [{ role: 'user', content: 'Send me the report and the build', timestamp: now - 60 }]
    for (const [index, args] of calls.entries()) {
      const reply = await sidecar.serverRequest('server.deliver', { caller_session_id: sid, ...args })
      if (!('result' in reply)) throw new Error(JSON.stringify(reply))
      const result = reply.result as { block_id: string }
      ids.push(result.block_id)
      row.messages.push(
        { role: 'assistant', content: '', tool_calls: [{ id: `call-${String(index)}`, function: { name: 'deliver', arguments: JSON.stringify(args) } }], timestamp: now - 50 + index },
        { role: 'tool', tool_call_id: `call-${String(index)}`, content: JSON.stringify(result), timestamp: now - 50 + index },
      )
    }
    row.messages.push({ role: 'assistant', content: 'Both files are attached.', timestamp: now - 30 })
    await server.deps.sessionStore.save(row)

    await page.goto(`${server.base}/session/${sid}`)
    await settle(page)
    const block = (index: number) => page.locator(`[data-show-block="${ids[index]!}"]`)
    await expect(block(0)).toContainText('week-45.md · 27 B · text/markdown')
    await expect(block(1).locator('img[alt="Signup funnel"]')).toHaveJSProperty('naturalWidth', 16)
    await expect(block(2)).toContainText('build.zip · 8 B · application/octet-stream')
    await expect(block(2).getByRole('button', { name: 'Open' })).toHaveCount(0)
    await expect(page.getByRole('note')).toHaveCount(0)
    const rows = await Promise.all([0, 1, 2].map((index) => block(index).innerText()))
    await shot('rows')

    const download = page.waitForEvent('download')
    await block(2).getByRole('button', { name: 'Download' }).click()
    expect((await download).suggestedFilename()).toBe('build.zip')

    // The agent rewrites the report: after a reload every row reads as before, and the report says it changed.
    writeFileSync(join(workspace, 'reports', 'week-45.md'), '# Week 45\n\nSignups up 14%.\n')
    await page.reload()
    await settle(page)
    await expect(block(0).getByRole('note')).toHaveText('Changed since delivered')
    expect(await Promise.all([1, 2].map((index) => block(index).innerText()))).toEqual(rows.slice(1))
    await shot('changed')

    const original = page.viewportSize()
    for (const [width, height] of WIDTHS) {
      await page.setViewportSize({ width, height })
      await block(0).scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal scroll at ${String(width)}px`).toBe(true)
      await shot(`width-${String(width)}`)
    }
    if (original) await page.setViewportSize(original)

    // Open on the text report shows it on the side panel's Files page.
    await block(0).getByRole('button', { name: 'Open' }).click()
    await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('Signups up 14%.')).toBeVisible()
    await shot('open')
  } finally {
    await page.goto('about:blank')
    await server.close()
  }
})
