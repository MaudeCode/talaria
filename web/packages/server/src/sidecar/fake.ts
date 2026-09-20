/**
 * In-process fake sidecar for unit tests. Answers each method from the
 * contracts fixtures (or a per-test override) and validates params and
 * results with the same schemas the real client uses, so a test can never
 * pass against a shape the real sidecar would reject.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SIDECAR_METHODS, type RuntimeDescribe, type SidecarMethodName, type SidecarParams, type SidecarResult } from '@maudecode/talaria-web-contracts'
import { SidecarError, type CallOptions, type SidecarLike, type SidecarStatus, type StreamFrame } from './client.js'

type Responder<M extends SidecarMethodName> = (params: SidecarParams<M>, emit: (frame: Omit<StreamFrame, 'seq'>) => void) => SidecarResult<M> | Promise<SidecarResult<M>>

export interface FakeSidecarOptions {
  fixturesDir?: string
  status?: SidecarStatus
}

export class FakeSidecar implements SidecarLike {
  status: SidecarStatus
  describe: RuntimeDescribe | null = null
  readonly calls: { method: SidecarMethodName; params: unknown }[] = []
  private readonly responders = new Map<SidecarMethodName, Responder<SidecarMethodName>>()
  private readonly fixtures = new Map<string, { params: unknown; result: unknown }>()

  constructor(opts: FakeSidecarOptions = {}) {
    this.status = opts.status ?? 'ready'
    const dir = opts.fixturesDir ?? resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar')
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      this.fixtures.set(file.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as { params: unknown; result: unknown })
    }
    const handshake = this.fixtures.get('runtime.handshake')
    if (handshake) this.describe = SIDECAR_METHODS['runtime.handshake'].result.parse(handshake.result)
  }

  /** Override one method for the rest of the test. */
  respond<M extends SidecarMethodName>(method: M, responder: Responder<M>): void {
    this.responders.set(method, responder)
  }

  async call<M extends SidecarMethodName>(method: M, params: SidecarParams<M>, opts: CallOptions = {}): Promise<SidecarResult<M>> {
    const schema = SIDECAR_METHODS[method]
    const parsedParams = schema.params.parse(params) as SidecarParams<M>
    this.calls.push({ method, params: parsedParams })
    if (this.status !== 'ready' && !method.startsWith('runtime.')) {
      throw new SidecarError(`sidecar not ready (${this.status})`, { condition: 'sidecar_unavailable' })
    }
    let seq = 0
    const emit = (frame: Omit<StreamFrame, 'seq'>) => { opts.onStream?.({ ...frame, seq: ++seq }) }
    const responder = this.responders.get(method)
    let raw: unknown
    if (responder) {
      raw = await responder(parsedParams, emit)
    } else {
      const fixture = this.fixtures.get(method)
      if (!fixture) throw new SidecarError(`no fixture or responder for ${method}`, { condition: 'sidecar_error' })
      raw = fixture.result
    }
    return schema.result.parse(raw) as SidecarResult<M>
  }

  close(): Promise<void> {
    this.status = 'stopped'
    return Promise.resolve()
  }
}
