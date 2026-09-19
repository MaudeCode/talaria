/**
 * Hostile-extension tests: the host must fail closed on every malformed,
 * unauthorised, oversized or mis-bound message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionHost, type HostServices } from './host'
import { EXTENSION_PROTOCOL_VERSION, type ExtensionManifest, MAX_MESSAGE_BYTES } from '../contracts/extension'

function manifest(over: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: 'demo', name: 'Demo', source: 'manifest', enabled: true, panel: 'extensions/demo/index.html', nav: { label: 'Demo' },
    capabilities: ['settings', 'storage', 'toast'], settings_schema: [{ key: 'show_badge', type: 'boolean', label: 'Badge', default: true }, { key: 'mode', type: 'enum', label: 'Mode', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
    theme: null, tts: null, sidecar: null, legacy_injection: false, warnings: [], ...over,
  }
}

function services(): HostServices & { toasts: string[]; navigated: string[] } {
  const s = {
    toasts: [] as string[],
    navigated: [] as string[],
    fetchSidecar: vi.fn(() => Promise.resolve({ status: 200, headers: {}, body: 'ok' })),
    currentSession: () => ({ sessionId: 's1', title: 'T' }),
    currentTheme: () => ({ theme: 'dark', skin: 'default', dark: true }),
    toast: (text: string) => { s.toasts.push(text) },
    navigateSession: (id: string) => { s.navigated.push(id) },
    registerTts: vi.fn(() => () => undefined),
    subscribeLifecycle: vi.fn(() => () => undefined),
  }
  return s
}

interface Sent { type: string; id?: number; ok?: boolean; result?: unknown; error?: { code: string }; name?: string }

function setup(over: Partial<ExtensionManifest> = {}) {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const svc = services()
  const host = new ExtensionHost(manifest(over), iframe, svc)
  const sent: Sent[] = []
  const fakePort = { postMessage: (m: unknown) => { sent.push(m as Sent) }, close: () => undefined, onmessage: null } as unknown as MessagePort
  host.__attachPortForTests(fakePort)
  const send = (data: unknown) => host.__simulatePortMessage(data)
  const ready = () => send({ type: 'hermes:ready', version: EXTENSION_PROTOCOL_VERSION, nonce: host.nonce })
  const call = (id: number, method: string, params?: unknown, nonce = host.nonce) => send({ type: 'request', nonce, id, method, params })
  const last = () => sent[sent.length - 1]
  return { host, svc, sent, send, ready, call, last, iframe }
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { document.body.innerHTML = '' })

describe('handshake', () => {
  it('becomes ready only with the right nonce and version', () => {
    const { host, send, ready } = setup()
    send({ type: 'hermes:ready', version: EXTENSION_PROTOCOL_VERSION, nonce: 'wrong-nonce-wrong-nonce' })
    expect(host.getStatus()).toBe('loading')
    send({ type: 'hermes:ready', version: 2, nonce: host.nonce })
    expect(host.getStatus()).toBe('loading')
    ready()
    expect(host.getStatus()).toBe('ready')
  })
  it('rejects requests before ready', () => {
    const { host, call, sent } = setup()
    call(1, 'toast.show', { text: 'hi' })
    expect(sent).toHaveLength(0)
    expect(host.violations).toContain('request_before_ready')
  })
  it('ignores window.postMessage traffic from the frame', () => {
    const { host, iframe } = setup()
    host.start()
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'request' }, source: iframe.contentWindow }))
    expect(host.violations).toContain('window_message_ignored')
    host.close()
  })
})

describe('validation and bounds', () => {
  it('drops malformed messages and unknown types', () => {
    const { host, send, ready } = setup()
    ready()
    send({ type: 'weird', nonce: host.nonce })
    send('string')
    send({ type: 'request', nonce: host.nonce, id: -1, method: 'toast.show' })
    send({ type: 'request', nonce: host.nonce, id: 1, method: 'not.a.method' })
    expect(host.violations.filter((v) => v === 'malformed_message')).toHaveLength(4)
  })
  it('drops oversized messages', () => {
    const { host, send, ready, sent } = setup()
    ready()
    send({ type: 'request', nonce: host.nonce, id: 1, method: 'toast.show', params: { text: 'x'.repeat(MAX_MESSAGE_BYTES) } })
    expect(host.violations).toContain('message_too_large')
    expect(sent).toHaveLength(0)
  })
  it('rejects a request carrying another nonce', () => {
    const { host, ready, call, sent } = setup()
    ready()
    call(1, 'toast.show', { text: 'hi' }, 'AAAAAAAAAAAAAAAAAAAAAAAA')
    expect(sent).toHaveLength(0)
    expect(host.violations).toContain('nonce_mismatch')
  })
  it('bounds toast text and storage values', async () => {
    const { ready, call, last } = setup()
    ready()
    call(1, 'toast.show', { text: 'x'.repeat(500) })
    await Promise.resolve()
    expect(last()).toMatchObject({ id: 1, ok: false })
    call(2, 'storage.set', { key: 'k', value: 'v'.repeat(40_000) })
    await Promise.resolve()
    expect(last()).toMatchObject({ id: 2, ok: false })
  })
})

describe('capabilities', () => {
  it('denies methods whose capability is not declared', async () => {
    const { host, ready, call, last, svc } = setup({ capabilities: ['toast'] })
    ready()
    call(1, 'navigate.session', { sessionId: 'abc' })
    await Promise.resolve()
    expect(last()).toMatchObject({ id: 1, ok: false, error: { code: 'capability_denied' } })
    expect(svc.navigated).toEqual([])
    expect(host.violations).toContain('capability_denied')
  })
  it('refuses sidecar calls without a declared sidecar even with the capability', async () => {
    const { ready, call, last, svc } = setup({ capabilities: ['sidecar'] })
    ready()
    call(1, 'sidecar.fetch', { path: 'health' })
    await Promise.resolve()
    await Promise.resolve()
    expect(last()).toMatchObject({ id: 1, ok: false, error: { code: 'no_sidecar' } })
    expect(svc.fetchSidecar).not.toHaveBeenCalled()
  })
  it('routes sidecar requests through the host bridge when declared', async () => {
    const { ready, call, last, svc } = setup({ capabilities: ['sidecar'], sidecar: { origin: 'http://127.0.0.1:17787', consented: true } })
    ready()
    call(1, 'sidecar.fetch', { path: 'health', method: 'GET' })
    await new Promise((r) => setTimeout(r, 0))
    expect(svc.fetchSidecar).toHaveBeenCalledWith('demo', expect.objectContaining({ path: 'health' }))
    expect(last()).toMatchObject({ id: 1, ok: true, result: { status: 200 } })
  })
})

describe('settings and storage', () => {
  it('serves schema defaults, validates types and enum options, and namespaces persistence', async () => {
    const { ready, call, last } = setup()
    ready()
    call(1, 'settings.get')
    await Promise.resolve()
    expect(last()).toMatchObject({ ok: true, result: { values: { show_badge: true, mode: 'a' } } })
    call(2, 'settings.set', { key: 'show_badge', value: 'nope' })
    await Promise.resolve()
    expect(last()).toMatchObject({ ok: false, error: { code: 'invalid_value' } })
    call(3, 'settings.set', { key: 'mode', value: 'z' })
    await Promise.resolve()
    expect(last()).toMatchObject({ ok: false })
    call(4, 'settings.set', { key: 'mode', value: 'b' })
    await Promise.resolve()
    expect(last()).toMatchObject({ ok: true, result: { value: 'b' } })
    call(5, 'settings.set', { key: 'unknown', value: 1 })
    await Promise.resolve()
    expect(last()).toMatchObject({ ok: false, error: { code: 'unknown_setting' } })
    expect(localStorage.getItem('hermes.ext.settings.demo')).toContain('"mode":"b"')
  })
  it('keeps storage per extension and bounded in key count', async () => {
    const { ready, call, last } = setup()
    ready()
    call(1, 'storage.set', { key: 'a', value: '1' })
    await Promise.resolve()
    call(2, 'storage.get', { key: 'a' })
    await Promise.resolve()
    expect(last()).toMatchObject({ ok: true, result: { value: '1' } })
    localStorage.setItem('hermes.ext.storage.demo', JSON.stringify(Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, 'v']))))
    call(3, 'storage.set', { key: 'overflow', value: 'v' })
    await Promise.resolve()
    expect(last()).toMatchObject({ ok: false, error: { code: 'storage_full' } })
    expect(localStorage.getItem('hermes.ext.storage.other')).toBeNull()
  })
})

describe('events', () => {
  it('delivers only subscribed lifecycle events and stops on close', () => {
    let listener: ((e: { type: string; sessionId: string; streamId: string; timestamp: number }) => void) | null = null
    const { host, ready, call, sent, svc } = setup({ capabilities: ['lifecycle'] })
    svc.subscribeLifecycle = vi.fn((l) => { listener = l; return () => { listener = null } })
    ready()
    call(1, 'lifecycle.subscribe', { events: ['turn:complete'] })
    return Promise.resolve().then(() => {
      expect(listener).not.toBeNull()
      listener?.({ type: 'turn:start', sessionId: 's', streamId: 'x', timestamp: 1 })
      listener?.({ type: 'turn:complete', sessionId: 's', streamId: 'x', timestamp: 2 })
      const events = sent.filter((m) => m.type === 'event')
      expect(events.map((e) => e.name)).toEqual(['turn:complete'])
      host.close()
      expect(listener).toBeNull()
    })
  })
  it('rejects an audio reply for an unknown request or with an invalid buffer', () => {
    const { host, ready, send } = setup({ capabilities: ['tts'], tts: { id: 'voicevox', label: 'V' } })
    ready()
    send({ type: 'tts:audio', nonce: host.nonce, requestId: 99, audio: new ArrayBuffer(4) })
    expect(host.violations).toContain('tts_unknown_request')
    send({ type: 'tts:audio', nonce: 'BBBBBBBBBBBBBBBBBBBBBBBB', requestId: 1, audio: new ArrayBuffer(4) })
    expect(host.violations.filter((v) => v === 'nonce_mismatch')).toHaveLength(1)
  })
})
