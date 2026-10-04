/**
 * In-process fake sidecar for unit tests. Answers each method from the
 * contracts fixtures (or a per-test override) and validates params and
 * results with the same schemas the real client uses, so a test can never
 * pass against a shape the real sidecar would reject.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SIDECAR_METHODS, SIDECAR_RPC_VERSION, type RuntimeDescribe, type SidecarMethodName, type SidecarParams, type SidecarResult } from '@maudecode/talaria-web-contracts'
import { SidecarError, type CallOptions, type SidecarLike, type SidecarStatus, type StreamFrame } from './client.js'

type Responder<M extends SidecarMethodName> = (params: SidecarParams<M>, emit: (frame: Omit<StreamFrame, 'seq'>) => void, opts: CallOptions) => SidecarResult<M> | Promise<SidecarResult<M>>

export interface FakeSidecarOptions {
  fixturesDir?: string
  status?: SidecarStatus
}

export interface FixtureEntry { params: unknown; result: unknown; stream?: { event: string; data: unknown }[] }

/** Recorded sidecar responses: one JSON file per namespace mapping method to recorded calls (sidecar/scripts/record-fixtures.py). */
export function loadSidecarFixtures(dir = resolve(import.meta.dirname, '../../../contracts/fixtures/sidecar')): Map<string, FixtureEntry[]> {
  const out = new Map<string, FixtureEntry[]>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const byMethod = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as Record<string, FixtureEntry[]>
    for (const [method, entries] of Object.entries(byMethod)) out.set(method, entries)
  }
  return out
}

export class FakeSidecar implements SidecarLike {
  status: SidecarStatus
  describe: RuntimeDescribe | null = null
  readonly calls: { method: SidecarMethodName; params: unknown }[] = []
  private readonly responders = new Map<SidecarMethodName, Responder<SidecarMethodName>>()
  private readonly fixtures = new Map<string, FixtureEntry[]>()

  constructor(opts: FakeSidecarOptions = {}) {
    this.status = opts.status ?? 'ready'
    for (const [method, entries] of loadSidecarFixtures(opts.fixturesDir)) this.fixtures.set(method, entries)
    const handshake = this.fixtures.get('runtime.handshake')?.[0]
    if (handshake) this.describe = SIDECAR_METHODS['runtime.handshake'].result.parse(handshake.result)
    // Every settled turn asks the goal judge (TAL-396); a fresh fake has no goal, so it answers as the sidecar does then.
    this.respond('goals.evaluate', () => ({ status: null, should_continue: false, continuation_prompt: null, verdict: 'inactive', reason: 'no active goal', message: '' }))
  }

  /** The responder currently installed for `method`, so a test can restore it. */
  responderFor<M extends SidecarMethodName>(method: M): Responder<M> | undefined {
    return this.responders.get(method)
  }

  /** Override one method for the rest of the test. */
  respond<M extends SidecarMethodName>(method: M, responder: Responder<M>): void {
    this.responders.set(method, responder)
  }

  async call<M extends SidecarMethodName>(method: M, params: SidecarParams<M>, opts: CallOptions = {}): Promise<SidecarResult<M>> {
    const schema = SIDECAR_METHODS[method]
    const parsedParams = schema.params.parse(params) as SidecarParams<M>
    this.calls.push({ method, params: parsedParams })
    const configAccess = (method === 'config.get' || method === 'config.set') && this.status === 'incompatible' && this.describe?.rpc_version === SIDECAR_RPC_VERSION
    if (this.status !== 'ready' && !configAccess && !method.startsWith('runtime.')) {
      throw new SidecarError(`sidecar not ready (${this.status})`, { condition: 'sidecar_unavailable' })
    }
    let seq = 0
    const emit = (frame: Omit<StreamFrame, 'seq'>) => { opts.onStream?.({ ...frame, seq: ++seq }) }
    const responder = this.responders.get(method)
    let raw: unknown
    if (responder) {
      raw = await responder(parsedParams, emit, opts)
    } else {
      const fixture = this.fixtures.get(method)?.[0]
      if (!fixture) throw new SidecarError(`no fixture or responder for ${method}`, { condition: 'sidecar_error' })
      for (const frame of fixture.stream ?? []) emit(frame)
      raw = fixture.result
    }
    return schema.result.parse(raw) as SidecarResult<M>
  }

  close(): Promise<void> {
    this.status = 'stopped'
    return Promise.resolve()
  }

  readonly recycled: string[] = []
  recycle(reason: string): void {
    this.recycled.push(reason)
    this.status = 'restarting'
  }
}
