/** TAL-2380: the profile's Bot Screen, decided from the owner's `display.status` and bridged to a viewer behind Talaria auth. */
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { RPC_ERROR_CODES, SCREEN_CLOSE, SCREEN_STREAM_PATH, type ScreenView } from '@maudecode/talaria-web-contracts'
import { SidecarError } from '../sidecar/client.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, cookieHeader, type TestServer } from '../test/harness.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown): Promise<Response> => s.get(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

const lease = { holder: 'agent' as const, viewer_hash: null }
const ready = (status: { supported: boolean; installed: boolean; running: boolean; install_command?: string | null }) => ({ state: 'ready' as const, reason: null, status: { install_command: null, ...status, lease } })
/** The shared fixture clients decode (TAL-2381), produced here. */
const { views } = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/screen.json'), 'utf8')) as { views: Record<'running' | 'not_installed' | 'unavailable', ScreenView> }
const unavailable = views.unavailable

describe('session detail screen (TAL-2380)', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  // The server's clock: each case moves it past the screen's cache, so it reads the owner afresh.
  let clock = 1_800_000_000
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar, now: () => clock })
  })
  afterAll(async () => { await s.close() })

  /** The detail of a fresh chat while the owner's `display.status` answers `answer`. */
  const screenOf = async (answer: () => unknown): Promise<unknown> => {
    sidecar.respond('display.status', () => answer() as never)
    clock += 60
    const created = (await (await post(s, '/api/session/new', {})).json()) as { session: Json }
    const detail = (await (await s.get(`/api/session?session_id=${String(created.session.session_id)}`)).json()) as { session: Json }
    return detail.session.screen
  }

  it.each<[string, () => unknown, ScreenView]>([
    ['a running screen', () => ready({ supported: true, installed: true, running: true }), views.running],
    ['a stopped screen', () => ready({ supported: true, installed: true, running: false }), { available: true, state: 'stopped', control: 'agent', install_command: null }],
    ['a host without the desktop packages', () => ready({ supported: true, installed: false, running: false, install_command: views.not_installed.install_command }), views.not_installed],
    ['an unsupported host', () => ready({ supported: false, installed: false, running: false }), unavailable],
    ['an owner without display.* (-32601)', () => ({ state: 'unavailable', reason: 'display_unsupported', status: null }), unavailable],
    ['a sidecar without display.status (-32601)', () => { throw new SidecarError('Method not found', { code: RPC_ERROR_CODES.methodNotFound, condition: 'method_not_found' }) }, unavailable],
  ])('%s', async (_name, answer, expected) => {
    expect(await screenOf(answer)).toEqual(expected)
  })
})

/** The profile owner's RFB socket: records each dial, sends `greeting` on open and keeps what the viewer sends. */
class FakeOwnerScreen {
  readonly dials: string[] = []
  readonly received: Buffer[] = []
  private readonly server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  private socket: WebSocket | null = null
  readonly connected: Promise<void>
  constructor(greeting: Buffer) {
    this.connected = new Promise((resolve) => {
      this.server.on('connection', (socket, req) => {
        this.dials.push(req.url ?? '')
        this.socket = socket
        socket.on('message', (data: Buffer) => { this.received.push(data) })
        socket.send(greeting)
        resolve()
      })
    })
  }
  url(ticket: string): string { return `ws://127.0.0.1:${String((this.server.address() as AddressInfo).port)}/api/display/ws?display_ticket=${ticket}` }
  close(code: number): void { this.socket?.close(code) }
  stop(): Promise<void> { return new Promise((resolve) => { this.server.close(() => { resolve() }) }) }
}

describe('screen viewer bridge (TAL-2380)', () => {
  const PASSWORD = 'synthetic-screen-pw'
  const TICKET = 'synthetic-display-ticket-7f3a'
  const GREETING = Buffer.from('RFB 003.008\n')
  let s: TestServer
  let sidecar: FakeSidecar
  let owner: FakeOwnerScreen
  let cookie: string
  let ended: Promise<void>
  /** The owner's lease: who holds it and, for a human, the hash of the viewer that took it. */
  let holder: { holder: 'agent' | 'human'; viewer_hash: string | null }

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar, env: { TALARIA_WEB_PASSWORD: PASSWORD } })
    cookie = cookieHeader((await post(s, '/api/auth/login', { password: PASSWORD })).headers.getSetCookie(), 'hermes_session')!
  })
  afterAll(async () => { await s.close() })
  beforeEach(() => {
    owner = new FakeOwnerScreen(GREETING)
    holder = { holder: 'agent', viewer_hash: null }
    let end: () => void = () => undefined
    ended = new Promise((resolve) => { end = resolve })
    // Each view is its own owner connection, which mints its own viewer (`sidecar-view-N`, hash `viewer-hash-N`).
    let views = 0
    sidecar.respond('display.status', () => ({ state: 'ready', reason: null, status: { supported: true, installed: true, running: true, install_command: null, lease: holder } }))
    sidecar.respond('display.view', (_params, emit, opts) => new Promise((_resolve, reject) => {
      const n = ++views
      opts.signal?.addEventListener('abort', () => { end(); reject(new SidecarError('cancelled', { condition: 'cancelled' })) }, { once: true })
      emit({ event: 'ready', data: { rfb_url: owner.url(TICKET), view_id: `sidecar-view-${String(n)}`, viewer_hash: `viewer-hash-${String(n)}` } })
    }))
    const hashOf = (viewId: string) => viewId.replace('sidecar-view-', 'viewer-hash-')
    sidecar.respond('display.lease.acquire', (params) => { holder = { holder: 'human', viewer_hash: hashOf(params.view_id) }; return { lease: holder } })
    sidecar.respond('display.lease.release', (params) => { if (holder.viewer_hash === hashOf(params.view_id)) holder = { holder: 'agent', viewer_hash: null }; return { lease: holder } })
    sidecar.calls.length = 0
  })
  afterEach(async () => { await owner.stop() })

  /** A viewer socket and everything the browser side of it observed. */
  const open = (headers: Record<string, string>, viewId = 'browser-view-1') => {
    const seen: { messages: Buffer[]; status: number | null; closeCode: number | null; closeReason: string } = { messages: [], status: null, closeCode: null, closeReason: '' }
    const ws = new WebSocket(`${s.base.replace(/^http/, 'ws')}${SCREEN_STREAM_PATH}?view_id=${viewId}`, { headers })
    let first: () => void = () => undefined
    const greeted = new Promise<void>((resolve) => { first = resolve })
    ws.on('message', (data: Buffer) => { seen.messages.push(data); first() })
    const closed = new Promise<void>((resolve) => {
      ws.on('unexpected-response', (_req, res) => { seen.status = res.statusCode ?? null; res.resume(); resolve() })
      ws.on('close', (code, reason) => { seen.closeCode = code; seen.closeReason = reason.toString('utf8'); resolve() })
    })
    return { ws, seen, greeted, closed }
  }
  const lease = (action: 'acquire' | 'release', viewId = 'browser-view-1') => s.get('/api/screen/lease', { method: 'POST', body: JSON.stringify({ view_id: viewId, action }), headers: { 'content-type': 'application/json', cookie } })
  const read = async (viewId: string): Promise<unknown> => (await s.get(`/api/screen/view?view_id=${viewId}`, { headers: { cookie } })).json()

  it('refuses a viewer that has not signed in, before reaching the owner', async () => {
    const viewer = open({})
    await viewer.closed
    expect(viewer.seen.status).toBe(401)
    expect(sidecar.calls.map((call) => call.method)).not.toContain('display.view')
    expect(owner.dials).toEqual([])
  })

  it('relays RFB both ways while the display ticket stays on the server', async () => {
    const viewer = open({ cookie })
    await viewer.greeted
    viewer.ws.send(Buffer.from('RFB 003.008\n'))
    const answer = await (await lease('acquire')).text()
    viewer.ws.close(1000)
    await viewer.closed
    await ended
    expect(owner.dials).toEqual([`/api/display/ws?display_ticket=${TICKET}`])
    expect(Buffer.concat(viewer.seen.messages)).toEqual(GREETING)
    expect(Buffer.concat(owner.received)).toEqual(Buffer.from('RFB 003.008\n'))
    expect([answer, viewer.seen.closeReason, ...viewer.seen.messages.map((m) => m.toString('latin1'))].join('\n')).not.toContain(TICKET)
  })

  it('takes over and hands back through the open viewer, and closing it hands back', async () => {
    const viewer = open({ cookie })
    await viewer.greeted
    expect(await (await lease('acquire')).json()).toMatchObject({ control: 'you' })
    expect(await (await lease('release')).json()).toMatchObject({ control: 'agent' })
    await lease('acquire')
    viewer.ws.close(1000)
    await ended
    const leaseCalls = sidecar.calls.filter((call) => call.method.startsWith('display.lease.'))
    expect(leaseCalls).toEqual([
      { method: 'display.lease.acquire', params: { view_id: 'sidecar-view-1' } },
      { method: 'display.lease.release', params: { view_id: 'sidecar-view-1' } },
      { method: 'display.lease.acquire', params: { view_id: 'sidecar-view-1' } },
      { method: 'display.lease.release', params: { view_id: 'sidecar-view-1' } },
    ])
    expect((await lease('release')).status).toBe(404)
  })

  it('passes the owner\'s control-taken close to the viewer', async () => {
    const viewer = open({ cookie })
    await viewer.greeted
    owner.close(SCREEN_CLOSE.controlTaken)
    await viewer.closed
    expect(viewer.seen.closeCode).toBe(SCREEN_CLOSE.controlTaken)
  })

  it('reports control for the viewer that asks, and session detail never as yours (TAL-2380)', async () => {
    const first = open({ cookie }, 'browser-view-1')
    const second = open({ cookie }, 'browser-view-2')
    await Promise.all([first.greeted, second.greeted])
    expect(await (await lease('acquire', 'browser-view-1')).json()).toMatchObject({ control: 'you' })
    // A session detail names no viewer, so a viewer it opens next starts without the first one's control.
    const created = (await (await s.get('/api/session/new', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', cookie } })).json()) as { session: Json }
    const detail = (await (await s.get(`/api/session?session_id=${String(created.session.session_id)}`, { headers: { cookie } })).json()) as { session: Json }
    expect(detail.session.screen).toMatchObject({ control: 'other' })
    expect(await read('browser-view-1')).toMatchObject({ control: 'you' })
    expect(await read('browser-view-2')).toMatchObject({ control: 'other' })
    first.ws.close(1000)
    second.ws.close(1000)
    await Promise.all([first.closed, second.closed])
  })

  it('closes a viewer whose login signs out, and hands its control back (TAL-2380)', async () => {
    const login = cookieHeader((await post(s, '/api/auth/login', { password: PASSWORD })).headers.getSetCookie(), 'hermes_session')!
    s.deps.screens.loginCheckMs = 20
    const viewer = open({ cookie: login })
    await viewer.greeted
    await s.get('/api/screen/lease', { method: 'POST', body: JSON.stringify({ view_id: 'browser-view-1', action: 'acquire' }), headers: { 'content-type': 'application/json', cookie: login } })
    expect((await s.get('/api/auth/logout', { method: 'POST', headers: { cookie: login } })).status).toBe(200)
    await vi.waitFor(() => { expect(viewer.seen.closeCode).toBe(4401) }, { timeout: 2_000 })
    await ended
    expect(holder.holder).toBe('agent')
  })
})

