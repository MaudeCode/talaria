/**
 * Hermes extension SDK (protocol v1). Served as static/dist/extension-sdk.js
 * and loaded by extension panel documents inside the sandboxed iframe.
 *
 *   const hermes = await Hermes.connect()
 *   const { values } = await hermes.call('settings.get')
 *   hermes.on('turn:complete', (e) => ...)
 *
 * The SDK waits for the host's hello (which carries the MessagePort), replies
 * ready with the nonce, and multiplexes request/response by id. It never uses
 * window.postMessage for protocol traffic after the handshake.
 */
const VERSION = 1
const SDK_VERSION = '1.0.0'

type Listener = (payload: unknown) => void
interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

export interface HermesApi {
  readonly extensionId: string
  readonly capabilities: readonly string[]
  call(method: string, params?: unknown): Promise<unknown>
  on(event: string, listener: Listener): () => void
  /** Register a TTS engine: the host will call `synthesize` through `tts:synthesize` events. */
  registerTts(engine: { id: string; label: string }, synthesize: (text: string, opts: { voice: string | null; rate: number | null; pitch: number | null }) => Promise<ArrayBuffer>): Promise<void>
}

function connect(): Promise<HermesApi> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hermes host handshake timed out')), 10_000)
    const onHello = (ev: MessageEvent) => {
      const d = ev.data as { type?: unknown; version?: unknown; nonce?: unknown; extensionId?: unknown; capabilities?: unknown } | null
      const port = ev.ports[0]
      if (d?.type !== 'hermes:hello' || !port || ev.ports.length !== 1) return
      window.removeEventListener('message', onHello)
      clearTimeout(timer)
      if (d.version !== VERSION) { reject(new Error(`Unsupported Hermes protocol version ${String(d.version)}`)); return }
      const nonce = String(d.nonce)
      const extensionId = String(d.extensionId)
      const capabilities = Array.isArray(d.capabilities) ? d.capabilities.map(String) : []
      let seq = 0
      const pending = new Map<number, Pending>()
      const listeners = new Map<string, Set<Listener>>()
      let ttsSynth: ((text: string, opts: { voice: string | null; rate: number | null; pitch: number | null }) => Promise<ArrayBuffer>) | null = null
      port.onmessage = (m: MessageEvent) => {
        const msg = m.data as { type?: string; nonce?: string; id?: number; ok?: boolean; result?: unknown; error?: { message?: string; code?: string }; name?: string; payload?: unknown }
        if (msg?.nonce !== nonce) return
        if (msg.type === 'response' && typeof msg.id === 'number') {
          const p = pending.get(msg.id)
          if (!p) return
          pending.delete(msg.id)
          if (msg.ok) p.resolve(msg.result)
          else p.reject(Object.assign(new Error(msg.error?.message ?? 'Hermes request failed'), { code: msg.error?.code }))
          return
        }
        if (msg.type === 'event' && typeof msg.name === 'string') {
          if (msg.name === 'tts:synthesize' && ttsSynth) {
            const payload = msg.payload as { requestId: number; text: string; voice: string | null; rate: number | null; pitch: number | null }
            ttsSynth(payload.text, { voice: payload.voice, rate: payload.rate, pitch: payload.pitch })
              .then((audio) => port.postMessage({ type: 'tts:audio', nonce, requestId: payload.requestId, audio }, [audio]))
              .catch((e: unknown) => port.postMessage({ type: 'tts:result', nonce, requestId: payload.requestId, ok: false, error: e instanceof Error ? e.message.slice(0, 300) : 'failed' }))
            return
          }
          for (const l of listeners.get(msg.name) ?? []) { try { l(msg.payload) } catch { /* listener error isolated */ } }
        }
      }
      const api: HermesApi = {
        extensionId,
        capabilities,
        call(method, params) {
          return new Promise((res, rej) => {
            const id = ++seq
            pending.set(id, { resolve: res, reject: rej })
            port.postMessage({ type: 'request', nonce, id, method, ...(params !== undefined ? { params } : {}) })
          })
        },
        on(event, listener) {
          const set = listeners.get(event) ?? new Set<Listener>()
          set.add(listener)
          listeners.set(event, set)
          if (event.startsWith('turn:')) void api.call('lifecycle.subscribe', { events: [event] }).catch(() => undefined)
          return () => { set.delete(listener) }
        },
        async registerTts(engine, synthesize) {
          ttsSynth = synthesize
          await api.call('tts.register', engine)
        },
      }
      port.postMessage({ type: 'hermes:ready', version: VERSION, nonce, sdkVersion: SDK_VERSION })
      resolve(api)
    }
    window.addEventListener('message', onHello)
  })
}

const Hermes = { connect, version: VERSION, sdkVersion: SDK_VERSION }
;(globalThis as unknown as { Hermes: typeof Hermes }).Hermes = Hermes
export default Hermes
