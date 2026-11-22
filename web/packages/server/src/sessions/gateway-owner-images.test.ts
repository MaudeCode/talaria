import { readFileSync, writeFileSync } from 'node:fs'
import { crc32 } from 'node:zlib'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionEnvelopeSchema, type GatewaySessionParams, type GatewaySessionResult } from '@maudecode/talaria-web-contracts'
import type { TestServer } from '../test/harness.js'
import type { FakeSidecar } from '../sidecar/fake.js'
import { admission, attached, bootOwnerAttachment, fixture, ownerHelpers, sid, snapshot } from '../test/gateway-owner.js'

const shared = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/gateway-owner.json', import.meta.url), 'utf8')) as { images: Record<string, unknown> }

// One complete image of each kind the owner stages.
const IMAGES = {
  'shot.png': Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082', 'hex'),
  'photo.jpg': Buffer.from('ffd8ffc0000b080001000101011100ffda000801010000003f00d2cf20ffd9', 'hex'),
  'loop.gif': Buffer.from('474946383961010001000000002c00000000010001000002024401003b', 'hex'),
  'still.webp': Buffer.concat([Buffer.from('RIFF'), Buffer.from([18, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.from([5, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0])]),
}
const EXT = { 'shot.png': 'png', 'photo.jpg': 'jpg', 'loop.gif': 'gif', 'still.webp': 'webp' }
/** A complete PNG of about `bytes`, padded with one ancillary text chunk. */
const bigPng = (bytes: number): Buffer => {
  const type = Buffer.from('tEXt')
  const data = Buffer.concat([Buffer.from('pad\0'), Buffer.alloc(bytes, 0x61)])
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])))
  const png = IMAGES['shot.png']
  return Buffer.concat([png.subarray(0, 33), length, type, data, crc, png.subarray(33)])
}

describe('images sent to a canonical owner chat (TAL-1344)', () => {
  let s: TestServer
  let db: DatabaseSync
  let sidecar: FakeSidecar
  let owned: { image_attachments?: boolean; authority_epoch?: number }
  let submitted: GatewayResultFor
  beforeEach(async () => {
    ({ s, db, sidecar } = await bootOwnerAttachment())
    owned = { image_attachments: true }
    submitted = () => ({ ...attached(snapshot(owned)), receipt: admission('queued') })
    sidecar.respond('gateway.session', (params) => params.action === 'submit' ? submitted(params) : attached(snapshot(owned)))
  })
  afterEach(async () => { db.close(); await s.close() })
  const { post } = ownerHelpers(() => ({ s, sidecar }))

  type GatewayResultFor = (params: GatewaySessionParams) => GatewaySessionResult
  const upload = (name: string, body: Buffer, session = sid) => {
    const head = ['--b', 'Content-Disposition: form-data; name="session_id"', '', session, '--b', `Content-Disposition: form-data; name="file"; filename="${name}"`, 'Content-Type: application/octet-stream', '', ''].join('\r\n')
    return s.get('/api/upload', { method: 'POST', body: Buffer.concat([Buffer.from(head), body, Buffer.from('\r\n--b--\r\n')]), headers: { 'content-type': 'multipart/form-data; boundary=b' } })
  }
  const uploaded = async (name: string, body: Buffer) => {
    const response = await upload(name, body)
    expect(response.status, await response.clone().text()).toBe(200)
    return await response.json() as { path: string; filename: string; mime: string; rollback_token: string }
  }
  const send = (attachments: { path: string; mime?: string; name?: string }[], submission_id = 'image-input', message = 'Look at these') =>
    post('/api/chat/start', { session_id: sid, message, submission_id, attachments })
  const submits = () => sidecar.calls.filter((call) => call.method === 'gateway.session' && (call.params as GatewaySessionParams).action === 'submit').map((call) => call.params as GatewaySessionParams)

  it('offers the owner\'s image kinds only while the owner stages images', async () => {
    const view = async () => SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${sid}`)).json()).session.owner_attachment
    expect(await view()).toMatchObject(shared.images)
    owned = {}
    expect(await view()).toMatchObject({ can_submit: true, can_attach: false, attachment_mimes: [] })
  })

  it('stages every accepted kind through the owner submit under the stable identity, with no bytes in logs', async () => {
    const files = await Promise.all(Object.entries(IMAGES).map(([name, body]) => uploaded(name, body)))
    owned = { image_attachments: true, authority_epoch: 7 }
    const response = await send(files.map((file) => ({ path: file.path, mime: file.mime, name: file.filename })), 'image-input', '')
    expect(response.status, await response.clone().text()).toBe(200)
    expect(submits()).toEqual([expect.objectContaining({ request_id: 'image-input', text: '', authority_epoch: 7,
      images: Object.entries(IMAGES).map(([name, body]) => ({ data_base64: body.toString('base64'), ext: EXT[name as keyof typeof EXT] })) })])
    expect(s.logs.join('\n')).not.toContain(IMAGES['shot.png'].toString('base64'))
  })

  it.each([
    ['a document', 'notes.txt', Buffer.from('plain notes')],
    ['bytes another kind than the name', 'shot.png', IMAGES['photo.jpg']],
    ['a truncated image', 'shot.png', IMAGES['shot.png'].subarray(0, 40)],
    ['an image kind the owner cannot stage', 'scan.bmp', Buffer.concat([Buffer.from('BM'), Buffer.alloc(40)])],
  ])('refuses %s at upload, before it joins the draft', async (_label, name, body) => {
    const response = await upload(name, body)
    expect(response.status).toBe(415)
    expect(await response.json()).toMatchObject({ code: 'owner_attachment_unsupported' })
  })

  it.each([
    ['bytes swapped after upload', (path: string) => { writeFileSync(path, IMAGES['photo.jpg']) }],
    ['bytes over the owner limit', (path: string) => { writeFileSync(path, Buffer.concat([IMAGES['shot.png'], Buffer.alloc(20 * 1024 * 1024)])) }],
  ])('verifies the stored file again at send and refuses %s without submitting', async (_label, change) => {
    const file = await uploaded('shot.png', IMAGES['shot.png'])
    change(file.path)
    const response = await send([{ path: file.path, mime: file.mime }])
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'owner_attachment_unsupported' })
    expect(submits()).toEqual([])
  })

  it('refuses a file outside this chat\'s own inbox, and a rolled-back receipt, without submitting', async () => {
    const other = Object.values(fixture.sessions).find((id) => id !== sid)!
    const foreign = await s.deps.uploads.store(other, 'shot.png', IMAGES['shot.png'])
    const mine = await uploaded('shot.png', IMAGES['shot.png'])
    const rolled = await post('/api/upload/rollback', { session_id: sid, rollback_tokens: [mine.rollback_token] })
    expect(await rolled.json()).toMatchObject({ ok: true, rolled_back: 1 })
    for (const path of [foreign.path, mine.path, '/etc/hosts']) {
      const response = await send([{ path, mime: 'image/png' }])
      expect(response.status, path).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'owner_attachment_unsupported' })
    }
    expect(submits()).toEqual([])
  })

  it('refuses images to an owner that cannot stage them, and more than it takes at once', async () => {
    const file = await uploaded('shot.png', IMAGES['shot.png'])
    expect((await send(Array.from({ length: 11 }, () => ({ path: file.path, mime: file.mime })))).status).toBe(400)
    owned = {}
    const response = await send([{ path: file.path, mime: file.mime }])
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'owner_attachments_unavailable' })
    expect(submits()).toEqual([])
  })

  it('refuses one file named twice, and more bytes in one message than the owner path carries', async () => {
    const small = await uploaded('shot.png', IMAGES['shot.png'])
    const first = await s.deps.uploads.store(sid, 'first.png', bigPng(17 * 1024 * 1024))
    const second = await s.deps.uploads.store(sid, 'second.png', bigPng(17 * 1024 * 1024))
    for (const [files, reason] of [[[small, small], 'duplicate'], [[first, second], 'too_large_total']] as const) {
      const response = await send(files.map((file) => ({ path: file.path, mime: file.mime })))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'owner_attachment_unsupported', reason })
    }
    expect(submits()).toEqual([])
  })

  it('holds image bytes for one send at a time, and frees them once the owner answers', async () => {
    const first = await s.deps.uploads.store(sid, 'first.png', bigPng(17 * 1024 * 1024))
    const second = await s.deps.uploads.store(sid, 'second.png', bigPng(17 * 1024 * 1024))
    let answer!: () => void
    const held = new Promise<void>((resolve) => { answer = resolve })
    submitted = () => ({ ...attached(snapshot(owned)), receipt: admission('queued') })
    sidecar.respond('gateway.session', async (params) => {
      if (params.action !== 'submit') return attached(snapshot(owned))
      if (params.request_id === 'held') await held
      return submitted(params)
    })
    const pending = send([{ path: first.path, mime: first.mime }], 'held')
    await vi.waitFor(() => { expect(submits()).toHaveLength(1) })
    const busy = await send([{ path: second.path, mime: second.mime }], 'concurrent')
    expect(busy.status).toBe(503)
    expect(await busy.json()).toMatchObject({ code: 'owner_images_busy' })
    answer()
    expect((await pending).status).toBe(200)
    expect((await send([{ path: second.path, mime: second.mime }], 'concurrent')).status).toBe(200)
  })

  it.each(['owner_image_refused', 'owner_changed', 'owner_images_unsupported', 'invalid_params'])('answers a %s refusal as not admitted, so the draft comes back', async (reason) => {
    const file = await uploaded('shot.png', IMAGES['shot.png'])
    submitted = () => ({ state: reason === 'owner_images_unsupported' ? 'incompatible' : 'refused', reason, snapshot: null, receipt: null })
    const response = await send([{ path: file.path, mime: file.mime }])
    expect(response.status).toBe(409)
    const body = await response.json() as Record<string, unknown>
    expect(body.outcome_unknown).not.toBe(true)
    expect(JSON.stringify(body)).not.toContain('cache/images')
    expect(submits()).toHaveLength(1)
  })

  it('reports a lost acknowledgement as unknown and restages the same bytes only when the client retries that identity', async () => {
    const file = await uploaded('shot.png', IMAGES['shot.png'])
    submitted = () => ({ state: 'unavailable', reason: 'owner_connection_lost', snapshot: null, receipt: null })
    const lost = await send([{ path: file.path, mime: file.mime }], 'stable-image')
    expect(lost.status).toBe(409)
    expect(await lost.json()).toMatchObject({ outcome_unknown: true })
    expect(submits()).toHaveLength(1)
    submitted = () => ({ ...attached(snapshot(owned)), receipt: admission('queued') })
    expect((await send([{ path: file.path, mime: file.mime }], 'stable-image')).status).toBe(200)
    const [first, retry] = submits()
    expect(retry).toEqual(first)
    expect(retry).toMatchObject({ request_id: 'stable-image', images: [{ data_base64: IMAGES['shot.png'].toString('base64'), ext: 'png' }] })
  })
})
