import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SIDECAR_SERVER_METHODS, ShowBlockSchema } from '@maudecode/talaria-web-contracts'
import { FakeSidecar } from '../sidecar/fake.js'
import { Session } from './session.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { createStorage } from '../runtime.js'
import type { DocumentBackend } from './storage/backend.js'
import { toolOutcome } from './merge.js'
import { SHOW_FRAME_CSP } from './show.js'

type Json = Record<string, unknown>
const fixtures = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar/show.json'), 'utf8')) as Record<'server.show_put', { params: Json; result: Json }[]>
const CALLER = '20261109_090000_caller'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4440000000049454e44ae426082', 'hex')

describe('show blocks (TAL-1968)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  let workspace: string
  let documents: DocumentBackend
  const clock = 1_794_100_000
  const put = async (kind: string, payload: Json, caller = CALLER) => {
    const reply = await sidecar.serverRequest('server.show_put', { caller_session_id: caller, kind, payload })
    return 'error' in reply ? { condition: (reply.error as { data?: { condition?: string } }).data?.condition, message: reply.error.message } : { result: SIDECAR_SERVER_METHODS['server.show_put'].result.parse(reply.result) }
  }
  const block = async (id: string) => {
    const res = await s.get(`/api/show/${id}`)
    return { status: res.status, body: await res.json() as Json }
  }
  const shown = async (kind: string, payload: Json) => {
    const reply = await put(kind, payload)
    if (!reply.result) throw new Error(`refused: ${String(reply.condition)} ${reply.message}`)
    return { reply: reply.result, block: ShowBlockSchema.parse((await block(reply.result.block_id)).body) }
  }

  beforeEach(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar, now: () => clock, storage: async (config) => { const backend = await createStorage(config, () => clock); documents = backend.documents; return backend } })
    workspace = join(s.state, 'workspace')
    mkdirSync(join(workspace, 'reports'), { recursive: true })
    await s.deps.sessionStore.save(new Session({ session_id: CALLER, title: CALLER, profile: 'default', workspace, updated_at: clock, messages: [{ role: 'user', content: 'hi', timestamp: clock }] }, { workspace, model: null }))
  })
  afterEach(async () => { await s.close() })

  it('records the server.show_put fixture from the real handler, and the block replays from the store', async () => {
    const [recorded] = fixtures['server.show_put']
    const reply = await put('table', recorded!.params.payload as Json)
    const id = reply.result!.block_id
    expect(reply).toEqual({ result: { ...recorded!.result, block_id: id } })
    const first = await block(id)
    expect(first).toEqual({ status: 200, body: { block_id: id, session_id: CALLER, kind: 'table', title: 'Latency by region', created_at: clock, columns: ['Region', 'p50 ms'], rows: [['us-east', '42'], ['eu-west', '57']], truncation: null, tsv: 'Region\tp50 ms\nus-east\t42\neu-west\t57' } })
    expect(await block(id), 'A block never changes once stored').toEqual(first)
    // The persisted tool result projects the same reference live and after reload.
    const content = JSON.stringify(reply.result)
    expect(toolOutcome(content, 'show').result_view.block).toEqual({ block_id: id, kind: 'table', title: 'Latency by region' })
    expect(toolOutcome(JSON.stringify({ error: 'nope', condition: 'payload_invalid' }), 'show').result_view.block).toBeUndefined()
  })

  it('shows an image as a media row served by /api/file/raw, and a text file as a file row for the companion page', async () => {
    writeFileSync(join(workspace, 'reports', 'funnel.png'), PNG)
    writeFileSync(join(workspace, 'notes.md'), '# Notes\n')
    const image = await shown('file', { path: 'reports/funnel.png', title: 'Signup funnel' })
    expect(image.block).toEqual({
      block_id: image.reply.block_id, session_id: CALLER, kind: 'file', title: 'Signup funnel', created_at: clock, file: { path: 'reports/funnel.png', name: 'funnel.png', size: PNG.length },
      media: { url: `./api/file/raw?session_id=${CALLER}&path=reports%2Ffunnel.png&inline=1`, name: 'funnel.png', mime: 'image/png', kind: 'image' }, focus_path: null,
    })
    const raw = await s.get((image.block as { media: { url: string } }).media.url.slice(1))
    expect(raw.status).toBe(200)
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(PNG)
    // An absolute path inside the workspace is the same file.
    const text = await shown('file', { path: join(workspace, 'notes.md') })
    expect(text.block).toMatchObject({ title: 'notes.md', file: { path: 'notes.md', name: 'notes.md', size: 8 }, media: null, focus_path: 'notes.md' })
  })

  it('refuses a file outside the workspace, a missing one, a symlink out of it and an unsupported binary, storing nothing', async () => {
    writeFileSync(join(s.state, 'secret.txt'), 'outside')
    symlinkSync(join(s.state, 'secret.txt'), join(workspace, 'link.txt'))
    writeFileSync(join(workspace, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254]))
    await shown('table', { columns: ['a'], rows: [] })
    expect(await put('file', { path: '../secret.txt' })).toMatchObject({ condition: 'path_outside_workspace' })
    expect(await put('file', { path: join(s.state, 'secret.txt') })).toMatchObject({ condition: 'path_outside_workspace' })
    expect(await put('file', { path: 'link.txt' })).toMatchObject({ condition: 'path_outside_workspace' })
    expect(await put('file', { path: 'missing.md' })).toMatchObject({ condition: 'file_not_found' })
    expect(await put('file', { path: 'blob.bin' })).toMatchObject({ condition: 'media_unsupported' })
    expect(await put('file', {})).toMatchObject({ condition: 'payload_invalid', message: 'path is required' })
    expect(await documents.list('show-blocks'), 'Only the table was stored').toHaveLength(1)
  })

  it('cuts a table to its caps and says so, and formats cells as text', async () => {
    const columns = Array.from({ length: 22 }, (_, i) => `c${String(i)}`)
    const rows = Array.from({ length: 503 }, (_, r) => [r, true, null, { a: 1 }, 'x'.repeat(2100), 'tab\there'])
    const { reply, block: table } = await shown('table', { columns, rows })
    expect(reply.note).toBe('Showing 500 of 503 rows and 20 of 22 columns; a table shows at most 500 rows and 20 columns.')
    expect(table).toMatchObject({ title: 'Table', truncation: { total_rows: 503, total_columns: 22 } })
    const shownTable = table as Extract<typeof table, { kind: 'table' }>
    expect(shownTable.columns).toHaveLength(20)
    expect(shownTable.rows).toHaveLength(500)
    expect(shownTable.rows[1]!.slice(0, 6)).toEqual(['1', 'true', '', '{"a":1}', `${'x'.repeat(1999)}…`, 'tab\there'])
    expect(shownTable.rows[1]![6]).toBe('')
    expect(shownTable.tsv.split('\n')[2]!.split('\t').slice(5, 7)).toEqual(['tab here', ''])
    expect(await put('table', { columns: [], rows: [] })).toMatchObject({ condition: 'payload_invalid' })
    expect(await put('table', { columns: ['a'], rows: ['not a row'] })).toMatchObject({ condition: 'payload_invalid' })
  })

  it('formats chart values with the unit and refuses a malformed series', async () => {
    const { block: chart } = await shown('chart', { title: 'Error rate', kind: 'line', unit: '%', series: [{ name: 'API', points: [{ label: 'Mon', value: 1.5 }, { label: 'Tue', value: 1234.567 }] }] })
    expect(chart).toMatchObject({ chart: 'line', unit: '%', series: [{ name: 'API', points: [{ label: 'Mon', value: 1.5, display: '1.5%' }, { label: 'Tue', value: 1234.567, display: '1,234.57%' }], max_display: '1,234.57%', peak: { label: 'Tue', display: '1,234.57%' } }] })
    const bar = await shown('chart', { title: 'Latency', kind: 'bar', unit: 'ms', series: [{ points: [{ label: 'a', value: -3 }] }] })
    expect(bar.block).toMatchObject({ series: [{ name: 'Latency', points: [{ display: '-3 ms' }], max_display: '0 ms', peak: { label: 'a', display: '-3 ms' } }] })
    expect(await put('chart', { title: 'x', kind: 'pie', series: [] })).toMatchObject({ condition: 'payload_invalid', message: 'kind must be bar or line' })
    expect(await put('chart', { title: 'x', kind: 'bar', series: [{ points: [{ label: 'a', value: 'NaN' }] }] })).toMatchObject({ condition: 'payload_invalid' })
    expect(await put('chart', { title: 'x', kind: 'bar', series: [{ points: [{ label: 'a', value: 1 }, { label: 'a', value: 2 }] }] })).toMatchObject({ condition: 'payload_invalid', message: 'series[0] repeats the label a' })
    expect(await put('chart', { title: 'x', kind: 'bar', series: Array.from({ length: 7 }, () => ({ points: [{ label: 'a', value: 1 }] })) })).toMatchObject({ condition: 'payload_invalid' })
  })

  it('serves an HTML block from an expiring, cookie-free grant with the sandbox CSP, and refuses a body over 512 KB', async () => {
    const body = '<!doctype html><title>t</title><p id="x">Hello</p><script>document.getElementById("x").textContent = "Ran"</script>'
    const { reply, block: page } = await shown('html', { title: 'Checklist', body })
    expect(page).toMatchObject({ kind: 'html', title: 'Checklist', bytes: Buffer.byteLength(body), expires_at: (Math.ceil(Date.now() / 3_600_000) + 1) * 3600 })
    expect(page).not.toHaveProperty('body')
    const frameUrl = (page as { frame_url: string }).frame_url
    expect(frameUrl).toMatch(/^show-frame\/[^/]+$/)
    const frame = await s.get(`/${frameUrl}`)
    expect(frame.status).toBe(200)
    expect(frame.headers.get('content-security-policy')).toBe(SHOW_FRAME_CSP)
    expect(frame.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts; default-src 'none';/)
    expect(frame.headers.get('set-cookie')).toBeNull()
    expect(await frame.text()).toBe(body)
    // A forged grant, or another block's id under it, serves nothing.
    expect((await s.get(`/${frameUrl.slice(0, -2)}00`)).status).toBe(404)
    expect((await s.get('/show-frame/' + Buffer.from(reply.block_id).toString('base64url') + '.9999999999.00')).status).toBe(404)
    expect(await put('html', { title: 'Big', body: 'x'.repeat(512 * 1024 + 1) })).toMatchObject({ condition: 'html_too_large' })
    expect(await put('html', { title: 'Empty', body: '' })).toMatchObject({ condition: 'payload_invalid' })
  })

  it('refuses an unknown kind and deletes a session\'s blocks with the session', async () => {
    expect(await put('map', {})).toMatchObject({ condition: 'kind_unknown' })
    const { reply } = await shown('chart', { title: 'x', kind: 'bar', series: [{ points: [{ label: 'a', value: 1 }] }] })
    expect((await block('sb_000000000000')).status).toBe(404)
    expect((await block('not-an-id')).status).toBe(404)
    sidecar.respond('state_db.delete_cli_session', () => ({ ok: true, deleted_ids: [CALLER] }))
    const deleted = await s.get('/api/session/delete', { method: 'POST', body: JSON.stringify({ session_id: CALLER }), headers: { 'content-type': 'application/json' } })
    expect(deleted.status).toBe(200)
    expect((await block(reply.block_id)).status).toBe(404)
  })
})
