/**
 * Extension host (HWEB-100): one instance per sandboxed iframe. Owns the
 * handshake, binds the channel to the iframe and extension identity, validates
 * every inbound message with Zod, enforces declared capabilities, bounds
 * payload sizes, and fails closed on unknown versions or messages.
 */
import {
  EXTENSION_PROTOCOL_VERSION, HelloMessageSchema, IframeMessageSchema, LifecycleSubscribeParams, MAX_MESSAGE_BYTES, MAX_STORAGE_KEYS, METHOD_CAPABILITY,
  NavigateSessionParams, SettingsGetParams, SettingsSetParams, SidecarFetchParams, SidecarFetchResult, StorageKeyParams, StorageSetParams, ToastParams, TtsRegisterParams,
  byteLength, type Capability, type ExtensionManifest, type LifecyclePayload, type Method,
} from '../contracts/extension'
import { z } from 'zod'
import { readPersisted, readPersistedJson, removePersisted, writePersistedJson } from '../lib/persisted'

export interface HostServices {
  fetchSidecar: (extensionId: string, params: z.infer<typeof SidecarFetchParams>) => Promise<z.infer<typeof SidecarFetchResult>>
  currentSession: () => { sessionId: string | null; title: string | null }
  currentTheme: () => { theme: string; skin: string; dark: boolean }
  toast: (text: string, ttl: number) => void
  navigateSession: (sessionId: string) => void
  registerTts: (extensionId: string, engine: { id: string; label: string }, synthesize: (text: string, opts: { voice: string | null; rate: number | null; pitch: number | null }) => Promise<ArrayBuffer>) => () => void
  subscribeLifecycle: (listener: (event: LifecyclePayload) => void) => () => void
}

export type HostStatus = 'loading' | 'ready' | 'error' | 'closed'

export class ProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

function nonce(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const SETTINGS_PREFIX = 'hermes.ext.settings.'
const STORAGE_PREFIX = 'hermes.ext.storage.'
const SettingsBlob = z.record(z.string(), z.union([z.boolean(), z.string(), z.number(), z.null()]))
const StorageBlob = z.record(z.string(), z.string())

export class ExtensionHost {
  readonly nonce = nonce()
  private port: MessagePort | null = null
  private status: HostStatus = 'loading'
  private readonly listeners = new Set<(s: HostStatus, detail?: string) => void>()
  private lifecycleUnsub: (() => void) | null = null
  private lifecycleEvents = new Set<string>()
  private ttsUnsub: (() => void) | null = null
  private ttsPending = new Map<number, { resolve: (buf: ArrayBuffer) => void; reject: (e: Error) => void }>()
  private ttsSeq = 0
  private readonly onWindowMessage = (ev: MessageEvent) => this.handleWindowMessage(ev)
  private helloTimer: number | null = null
  readonly violations: string[] = []

  constructor(readonly manifest: ExtensionManifest, readonly iframe: HTMLIFrameElement, private readonly services: HostServices) {}

  onStatus(listener: (s: HostStatus, detail?: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setStatus(s: HostStatus, detail?: string): void {
    this.status = s
    for (const l of this.listeners) l(s, detail)
  }

  getStatus(): HostStatus {
    return this.status
  }

  /** Called once the iframe document has loaded: post hello with the port. */
  start(): void {
    if (!this.iframe.contentWindow) return
    const channel = new MessageChannel()
    this.port = channel.port1
    this.port.onmessage = (ev) => this.handlePortMessage(ev)
    window.addEventListener('message', this.onWindowMessage)
    const hello = { type: 'hermes:hello', version: EXTENSION_PROTOCOL_VERSION, nonce: this.nonce, extensionId: this.manifest.id, capabilities: this.manifest.capabilities }
    HelloMessageSchema.parse(hello)
    // Sandboxed frames have an opaque origin, so the target origin must be '*'; the
    // port itself is what binds the channel to this iframe: nobody else holds port2.
    this.iframe.contentWindow.postMessage(hello, '*', [channel.port2])
    this.helloTimer = window.setTimeout(() => { if (this.status === 'loading') this.setStatus('error', 'handshake_timeout') }, 8000)
  }

  close(): void {
    if (this.helloTimer) window.clearTimeout(this.helloTimer)
    window.removeEventListener('message', this.onWindowMessage)
    this.port?.close()
    this.port = null
    this.lifecycleUnsub?.()
    this.ttsUnsub?.()
    for (const p of this.ttsPending.values()) p.reject(new Error('closed'))
    this.ttsPending.clear()
    this.setStatus('closed')
  }

  /** window.postMessage from the frame is never accepted: the protocol lives on the port only. */
  private handleWindowMessage(ev: MessageEvent): void {
    if (ev.source === this.iframe.contentWindow) this.violation('window_message_ignored')
  }

  private violation(code: string): void {
    this.violations.push(code)
    if (this.violations.length > 50) this.violations.shift()
  }

  private handlePortMessage(ev: MessageEvent): void {
    const raw: unknown = ev.data
    // Audio replies carry a transferred ArrayBuffer and are bounded separately.
    if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'tts:audio') { this.handleTtsAudio(raw); return }
    if (byteLength(raw) > MAX_MESSAGE_BYTES) { this.violation('message_too_large'); return }
    const parsed = IframeMessageSchema.safeParse(raw)
    if (!parsed.success) { this.violation('malformed_message'); return }
    const msg = parsed.data
    if (msg.nonce !== this.nonce) { this.violation('nonce_mismatch'); return }
    if (msg.type === 'hermes:ready') {
      if (msg.version !== EXTENSION_PROTOCOL_VERSION) { this.violation('version_mismatch'); this.setStatus('error', 'version_mismatch'); return }
      if (this.helloTimer) window.clearTimeout(this.helloTimer)
      this.setStatus('ready')
      return
    }
    if (this.status !== 'ready') { this.violation('request_before_ready'); return }
    if (msg.type === 'tts:result') { this.finishTts(msg.requestId, msg.ok, msg.error); return }
    void this.dispatch(msg.id, msg.method, msg.params)
  }

  private reply(id: number, ok: boolean, result?: unknown, error?: { code: string; message: string }): void {
    if (!this.port) return
    const payload = { type: 'response', nonce: this.nonce, id, ok, ...(ok ? { result } : { error }) }
    if (byteLength(payload) > MAX_MESSAGE_BYTES) {
      this.port.postMessage({ type: 'response', nonce: this.nonce, id, ok: false, error: { code: 'result_too_large', message: 'Result exceeds the message size bound' } })
      return
    }
    this.port.postMessage(payload)
  }

  private emit(name: 'turn:start' | 'turn:complete' | 'turn:error' | 'turn:cancel' | 'theme:changed' | 'tts:synthesize', payload: unknown): void {
    if (!this.port || this.status !== 'ready') return
    const msg = { type: 'event', nonce: this.nonce, name, payload }
    if (byteLength(msg) > MAX_MESSAGE_BYTES) return
    this.port.postMessage(msg)
  }

  hasCapability(cap: Capability): boolean {
    return this.manifest.capabilities.includes(cap)
  }

  private settingsKey(): string {
    return SETTINGS_PREFIX + encodeURIComponent(this.manifest.id)
  }
  private storageKey(): string {
    return STORAGE_PREFIX + encodeURIComponent(this.manifest.id)
  }
  private readSettings(): Record<string, boolean | string | number | null> {
    const stored = readPersistedJson(this.settingsKey(), SettingsBlob) ?? {}
    const out: Record<string, boolean | string | number | null> = {}
    for (const f of this.manifest.settings_schema) out[f.key] = stored[f.key] ?? f.default ?? null
    return out
  }
  private validateSetting(key: string, value: unknown): boolean | string | number | null {
    const field = this.manifest.settings_schema.find((f) => f.key === key)
    if (!field) throw new ProtocolError('unknown_setting', `Unknown setting ${key}`)
    if (value === null) return field.default ?? null
    switch (field.type) {
      case 'boolean': if (typeof value !== 'boolean') throw new ProtocolError('invalid_value', 'boolean expected'); return value
      case 'string': if (typeof value !== 'string') throw new ProtocolError('invalid_value', 'string expected'); return value.slice(0, 2000)
      case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) throw new ProtocolError('invalid_value', 'number expected'); return value
      case 'integer': if (typeof value !== 'number' || !Number.isInteger(value)) throw new ProtocolError('invalid_value', 'integer expected'); return value
      case 'enum': if (typeof value !== 'string' || !field.options?.some((o) => o.value === value)) throw new ProtocolError('invalid_value', 'enum option expected'); return value
    }
  }

  private async dispatch(id: number, method: Method, params: unknown): Promise<void> {
    const cap = METHOD_CAPABILITY[method]
    if (!this.hasCapability(cap)) { this.violation('capability_denied'); this.reply(id, false, undefined, { code: 'capability_denied', message: `Capability "${cap}" is not declared by ${this.manifest.id}` }); return }
    try {
      const result = await this.invoke(method, params)
      this.reply(id, true, result)
    } catch (e) {
      if (e instanceof ProtocolError) { this.violation(e.code); this.reply(id, false, undefined, { code: e.code, message: e.message }) }
      else this.reply(id, false, undefined, { code: 'internal', message: e instanceof Error ? e.message.slice(0, 300) : 'error' })
    }
  }

  private async invoke(method: Method, params: unknown): Promise<unknown> {
    switch (method) {
      case 'settings.get': {
        const p = SettingsGetParams.parse(params ?? {})
        const all = this.readSettings()
        return p.key ? { value: all[p.key] ?? null } : { values: all }
      }
      case 'settings.set': {
        const p = SettingsSetParams.parse(params)
        const value = this.validateSetting(p.key, p.value)
        const stored = readPersistedJson(this.settingsKey(), SettingsBlob) ?? {}
        writePersistedJson(this.settingsKey(), { ...stored, [p.key]: value })
        return { value }
      }
      case 'settings.reset':
        removePersisted(this.settingsKey())
        return { values: this.readSettings() }
      case 'storage.get': {
        const p = StorageKeyParams.parse(params)
        const blob = readPersistedJson(this.storageKey(), StorageBlob) ?? {}
        return { value: blob[p.key] ?? null }
      }
      case 'storage.set': {
        const p = StorageSetParams.parse(params)
        const blob = readPersistedJson(this.storageKey(), StorageBlob) ?? {}
        if (!(p.key in blob) && Object.keys(blob).length >= MAX_STORAGE_KEYS) throw new ProtocolError('storage_full', `At most ${MAX_STORAGE_KEYS} keys`)
        writePersistedJson(this.storageKey(), { ...blob, [p.key]: p.value })
        return { ok: true }
      }
      case 'storage.remove': {
        const p = StorageKeyParams.parse(params)
        const blob = readPersistedJson(this.storageKey(), StorageBlob) ?? {}
        const next = Object.fromEntries(Object.entries(blob).filter(([k]) => k !== p.key))
        writePersistedJson(this.storageKey(), next)
        return { ok: true }
      }
      case 'storage.clear':
        removePersisted(this.storageKey())
        return { ok: true }
      case 'storage.keys':
        return { keys: Object.keys(readPersistedJson(this.storageKey(), StorageBlob) ?? {}) }
      case 'sidecar.fetch': {
        if (!this.manifest.sidecar) throw new ProtocolError('no_sidecar', 'No sidecar declared')
        const p = SidecarFetchParams.parse(params)
        return this.services.fetchSidecar(this.manifest.id, p)
      }
      case 'lifecycle.subscribe': {
        const p = LifecycleSubscribeParams.parse(params)
        for (const e of p.events) this.lifecycleEvents.add(e)
        this.lifecycleUnsub ??= this.services.subscribeLifecycle((event) => { if (this.lifecycleEvents.has(event.type)) this.emit(event.type, event) })
        return { events: [...this.lifecycleEvents] }
      }
      case 'lifecycle.unsubscribe':
        this.lifecycleEvents.clear()
        this.lifecycleUnsub?.()
        this.lifecycleUnsub = null
        return { ok: true }
      case 'session.current':
        return this.services.currentSession()
      case 'theme.current':
        return this.services.currentTheme()
      case 'toast.show': {
        const p = ToastParams.parse(params)
        this.services.toast(`${this.manifest.name}: ${p.text}`, p.ttl ?? 2500)
        return { ok: true }
      }
      case 'navigate.session': {
        const p = NavigateSessionParams.parse(params)
        this.services.navigateSession(p.sessionId)
        return { ok: true }
      }
      case 'tts.register': {
        const p = TtsRegisterParams.parse(params)
        if (this.manifest.tts?.id !== p.id) throw new ProtocolError('tts_not_declared', 'The manifest does not declare this TTS engine')
        this.ttsUnsub?.()
        this.ttsUnsub = this.services.registerTts(this.manifest.id, p, (text, opts) => this.synthesize(text, opts))
        return { ok: true }
      }
    }
  }

  private synthesize(text: string, opts: { voice: string | null; rate: number | null; pitch: number | null }): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const requestId = ++this.ttsSeq
      this.ttsPending.set(requestId, { resolve, reject })
      this.emit('tts:synthesize', { requestId, text: text.slice(0, 4000), ...opts })
      window.setTimeout(() => { if (this.ttsPending.delete(requestId)) reject(new Error('tts_timeout')) }, 30_000)
    })
  }

  private finishTts(requestId: number, ok: boolean, error?: string): void {
    const pending = this.ttsPending.get(requestId)
    if (!pending) { this.violation('tts_unknown_request'); return }
    this.ttsPending.delete(requestId)
    if (!ok) { pending.reject(new Error(error ?? 'tts_failed')); return }
    pending.reject(new Error('tts_audio_missing'))
  }

  private handleTtsAudio(msg: { nonce?: unknown; requestId?: unknown; audio?: unknown }): void {
    if (msg.nonce !== this.nonce || this.status !== 'ready') { this.violation('nonce_mismatch'); return }
    if (typeof msg.requestId !== 'number') { this.violation('malformed_message'); return }
    const pending = this.ttsPending.get(msg.requestId)
    if (!pending) { this.violation('tts_unknown_request'); return }
    this.ttsPending.delete(msg.requestId)
    const audio = msg.audio
    if (!(audio instanceof ArrayBuffer) || audio.byteLength === 0 || audio.byteLength > 8 * 1024 * 1024) { pending.reject(new Error('tts_audio_invalid')); this.violation('tts_audio_invalid'); return }
    pending.resolve(audio)
  }

  notifyTheme(theme: { theme: string; skin: string; dark: boolean }): void {
    if (this.hasCapability('theme')) this.emit('theme:changed', theme)
  }

  /** Test hook: feed a message as if it came from the port. */
  __simulatePortMessage(data: unknown): void {
    this.handlePortMessage({ data } as MessageEvent)
  }
  __attachPortForTests(port: MessagePort): void {
    this.port = port
    this.port.onmessage = (ev) => this.handlePortMessage(ev)
  }
  __setReadyForTests(): void {
    this.setStatus('ready')
  }
}

export { readPersisted }
