import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MeshyCard, MeshyOverview, MeshySidecarResult } from '@maudecode/talaria-web-contracts'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { SidecarError } from '../sidecar/client.js'
import { parseMeshyDirective } from '../workspace/media-refs.js'

const TASK = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b'
const REVISION = 'c16e967d798d8dd3b1827a62673c18627f31e0ed'
const THUMB = 'https://assets.meshy.ai/tasks/thumb.png?Expires=1&Signature=s'

/** A synthetic binary glTF: one JSON chunk and one BIN chunk. */
export function glb(json: Record<string, unknown> = { asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] }): Buffer {
  let chunk = Buffer.from(JSON.stringify(json))
  if (chunk.length % 4) chunk = Buffer.concat([chunk, Buffer.alloc(4 - (chunk.length % 4), 0x20)])
  const bin = Buffer.alloc(4)
  const total = 12 + 8 + chunk.length + 8 + bin.length
  const head = Buffer.alloc(12)
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8)
  const jsonHead = Buffer.alloc(8); jsonHead.writeUInt32LE(chunk.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4)
  const binHead = Buffer.alloc(8); binHead.writeUInt32LE(bin.length, 0); binHead.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([head, jsonHead, chunk, binHead, bin])
}

let server: TestServer | undefined
afterEach(async () => { await server?.close(); server = undefined })

interface Backend { sidecar: FakeSidecar; model: string; consent: { ok: boolean; revision: string }; fetched: { url: string; init: RequestInit | undefined }[]; image: () => Response }

async function backend(): Promise<Backend & { server: TestServer }> {
  const sidecar = new FakeSidecar()
  const fetched: Backend['fetched'] = []
  const state: Backend = { sidecar, model: '', consent: { ok: true, revision: REVISION }, fetched, image: () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': 'image/png' } }) }
  server = await bootTestServer({ sidecar, deps: (deps) => { deps.fetch = (input, init) => { fetched.push({ url: input instanceof Request ? input.url : input.toString(), init }); return Promise.resolve(state.image()) } } })
  const data = join(server.state, 'plugin-data', 'agent-plugin-meshy-0', 'meshy_output', TASK)
  mkdirSync(data, { recursive: true })
  state.model = join(data, 'model.glb')
  writeFileSync(state.model, glb())
  const local = (path = state.model) => ({ path, name: 'model.glb', kind: 'model' as const, task_id: TASK, prompt: 'A small robot', modified: 2, bytes: 32, images: [], download_incomplete: false })
  sidecar.respond('plugins.meshy', (params): MeshySidecarResult => {
    const base = { availability: 'ready' as const, message: null, balance: 42, revision: state.consent.ok ? state.consent.revision : null }
    if (!state.consent.ok) return { ...base, availability: 'plugin_unavailable', balance: null }
    switch (params.action) {
      case 'asset': return { ...base, asset: params.path === state.model || params.path?.endsWith('.glb') ? { path: params.path, anchor: join(server!.state, 'plugin-data'), mime: 'model/gltf-binary', bytes: 32 } : null }
      case 'card': return { ...base, local: params.path === state.model || (!params.path && params.task_id === TASK) ? [local()] : [], task: params.task_id ? { task_id: params.task_id, status: 'succeeded', progress: 100, terminal: true, stage: 'preview', error: null, prompt: 'A small robot', thumbnail_url: THUMB, credits: null, has_model: true, task_type: 'text-to-3d-preview' } : null }
      case 'overview': return { ...base, auto_rotate: false, active: [], local: [local()], recent: [{ task_id: TASK, task_type: 'text-to-3d', kind: 'model', prompt: 'A small robot', created_at: 5, credits: null, thumbnail_url: THUMB, image_urls: [], expired: false, local_path: state.model }] }
      case 'save': return { ...base, saved: ['model.fbx'], complete: true, error: null }
      default: return base
    }
  })
  return Object.assign(state, { server })
}

async function sessionWith(s: TestServer, content: string): Promise<string> {
  const session = await s.deps.sessionStore.newSession()
  session.messages = [{ role: 'user', content: 'make a robot' }, { role: 'assistant', content }]
  await s.deps.sessionStore.save(session)
  return session.session_id
}

const card = async (s: TestServer, sid: string, ref: string) => s.get(`/api/meshy/card?${new URLSearchParams({ session_id: sid, ref }).toString()}`)

describe('Meshy previews (TAL-1514)', () => {
  it('projects a directive into a model item and serves its GLB only through that session and the native inventory', async () => {
    const b = await backend()
    const directive = `::meshy-model{path="${b.model}" task="${TASK}" title="Robot"}`
    const sid = await sessionWith(b.server, `Saved it.\n\n${directive}`)
    const detail = await (await b.server.get(`/api/session?session_id=${sid}`)).json() as { session: { messages: { _media?: { kind: string; model?: { ref: string } }[]; _display_content?: string }[] } }
    const assistant = detail.session.messages.find((m) => m._media)!
    expect(assistant._display_content).not.toContain('::meshy-model')
    const ref = assistant._media![0]!.model!.ref
    const response = await card(b.server, sid, ref)
    expect(response.status).toBe(200)
    const body = await response.json() as MeshyCard
    expect(body).toMatchObject({ availability: 'ready', title: 'Robot', task: { status: 'succeeded', terminal: true }, item: { task_id: TASK, saved: true, can_download: true } })
    expect(JSON.stringify(body)).not.toContain(b.server.state)
    expect(JSON.stringify(body)).not.toContain('Signature=')
    const bytes = await b.server.get('/' + body.item!.model!.url.replace(/^\.\//, ''))
    expect(bytes.status).toBe(200)
    expect(bytes.headers.get('content-type')).toBe('model/gltf-binary')
    expect(Buffer.from(await bytes.arrayBuffer()).equals(glb())).toBe(true)

    // A ref the session's assistant text does not contain grants nothing, even for a real native file.
    const forged = parseMeshyDirective(`::meshy-model{path="${b.model}"}`)!.ref
    expect((await card(b.server, sid, forged)).status).toBe(404)
    const other = await sessionWith(b.server, 'no models here')
    expect((await card(b.server, other, ref)).status).toBe(404)
  })

  it('refuses unlisted, non-self-contained, foreign-owner, revoked and stale-revision assets before any byte', async () => {
    const b = await backend()
    const sid = await sessionWith(b.server, `::meshy-model{path="${b.model}" task="${TASK}"}`)
    const ref = parseMeshyDirective(`::meshy-model{path="${b.model}" task="${TASK}"}`)!.ref
    const url = '/' + ((await (await card(b.server, sid, ref)).json()) as MeshyCard).item!.model!.url.replace(/^\.\//, '')
    expect((await b.server.get(url)).status).toBe(200)

    writeFileSync(b.model, glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'https://evil.example/b.bin' }] }))
    const external = await b.server.get(url)
    expect(external.status).toBe(403)
    expect(await external.text()).toContain('outside itself')
    writeFileSync(b.model, glb({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] }))
    expect((await b.server.get(url)).status).toBe(403)
    writeFileSync(b.model, Buffer.concat([glb(), Buffer.from('trailing')]))
    expect((await b.server.get(url)).status, 'A header length that disagrees with the file').toBe(403)
    writeFileSync(b.model, glb())

    expect((await b.server.get(url, { headers: { cookie: 'hermes_profile=beta' } })).status, 'Another profile').toBe(404)
    b.consent.revision = 'f'.repeat(40)
    expect((await b.server.get(url)).status, 'A different plugin revision').toBe(404)
    b.consent.revision = REVISION
    b.consent.ok = false
    expect((await b.server.get(url)).status, 'Consent withdrawn').toBe(404)
    b.consent.ok = true
    const switched = await b.server.get('/api/profile/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'default' }) })
    expect(switched.status).toBe(200)
    expect((await b.server.get(url)).status, 'A profile switch revokes every grant').toBe(404)
    expect((await b.server.get('/api/meshy/asset?grant=forged.1.0')).status).toBe(404)
  })

  it('relays remote images only from the asset host with redirects refused', async () => {
    const b = await backend()
    const overview = await (await b.server.get('/api/meshy/overview')).json() as MeshyOverview
    expect(overview).toMatchObject({ availability: 'ready', balance: 42, auto_rotate: false, recent: [{ task_id: TASK, credits: null, saved: true }] })
    expect(JSON.stringify(overview)).not.toContain('assets.meshy.ai')
    const thumb = '/' + overview.recent[0]!.thumbnail!.url.replace(/^\.\//, '')
    const ok = await b.server.get(thumb)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(b.fetched.map((f) => [f.url, f.init?.redirect])).toEqual([[THUMB, 'error']])
    b.image = () => new Response('<script>', { headers: { 'content-type': 'text/html' } })
    expect((await b.server.get(thumb)).status).toBe(502)
    b.image = () => { throw new TypeError('redirect mode is set to error') }
    expect((await b.server.get(thumb)).status).toBe(502)
  })

  it('names missing-key, plugin and old-Agent states instead of failing', async () => {
    const b = await backend()
    b.sidecar.respond('plugins.meshy', () => ({ availability: 'missing_key', message: 'Add a Meshy API key in Plugins to see generations and download files.', balance: null, revision: REVISION, auto_rotate: true, recent: [], active: [], local: [] }))
    expect(await (await b.server.get('/api/meshy/overview')).json()).toMatchObject({ availability: 'missing_key', balance: null, recent: [] })
    b.sidecar.respond('plugins.meshy', () => ({ availability: 'plugin_unavailable', message: null, balance: null, revision: null }))
    expect(await (await b.server.get('/api/meshy/overview')).json()).toMatchObject({ availability: 'plugin_unavailable' })
    expect(((await (await b.server.get('/api/meshy/overview')).json()) as MeshyOverview).message).toContain('Meshy plugin')
    b.sidecar.respond('plugins.meshy', () => { throw new SidecarError('Method not found', { code: -32601, condition: 'sidecar_error' }) })
    expect(await (await b.server.get('/api/meshy/overview')).json()).toMatchObject({ availability: 'agent_incompatible', local: [], recent: [] })
  })

  it('answers unavailable, not an error, when no Agent sidecar runs', async () => {
    server = await bootTestServer({ sidecar: null })
    const response = await server.get('/api/meshy/overview')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ availability: 'unavailable', recent: [], local: [] })
  })

  it('saves beside a model only from a grant the caller holds', async () => {
    const b = await backend()
    const overview = await (await b.server.get('/api/meshy/overview')).json() as MeshyOverview
    const beside = overview.local[0]!.model!.url
    const post = (body: unknown) => b.server.get('/api/meshy/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const saved = await post({ task_id: TASK, format: 'fbx', beside })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ saved: ['model.fbx'], complete: true, error: null })
    expect(b.sidecar.calls.filter((c) => c.method === 'plugins.meshy' && (c.params as { action: string }).action === 'save').map((c) => c.params)).toEqual([expect.objectContaining({ task_id: TASK, format: 'fbx', path: b.model })])
    expect((await post({ task_id: TASK, format: 'fbx', beside: './api/meshy/asset?grant=forged.1.0' })).status).toBe(409)
    expect((await post({ task_id: TASK, format: 'fbx', beside: `/abs${b.model}` })).status).toBe(409)
    expect((await post({ task_id: '../etc', format: 'fbx' })).status).toBe(400)
    expect(b.sidecar.calls.filter((c) => (c.params as { action?: string }).action === 'save')).toHaveLength(1)
  })

  it('lists the Meshy plugin under extension navigation with the native gallery, never its Desktop bundle', async () => {
    const b = await backend()
    b.sidecar.respond('plugins.dashboard_list', () => ({ supported: true, plugins: [{ name: 'meshy', label: 'Meshy', version: '0.2.0', description: '', enabled: true, panel: null, has_api: true }] }))
    const manifests = await (await b.server.get('/api/extensions/manifests')).json() as { manifests: { source: string; native_view?: string; panel: string | null; nav: { label: string } | null; warnings: string[] }[] }
    expect(manifests.manifests.find((m) => m.source === 'agent-plugin')).toMatchObject({ native_view: 'meshy_gallery', panel: null, nav: { label: 'Meshy' }, warnings: [] })
  })
})
