/**
 * In-process fake sidecar for unit tests. Answers each method from the
 * contracts fixtures (or a per-test override) and validates params and
 * results with the same schemas the real client uses, so a test can never
 * pass against a shape the real sidecar would reject.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RPC_ERROR_CODES, SIDECAR_METHODS, SIDECAR_RPC_VERSION, type RuntimeDescribe, type SidecarMethodName, type SidecarParams, type SidecarResult, type SidecarResultInput } from '@maudecode/talaria-web-contracts'
import { SidecarError, type CallOptions, type ReadyGate, type SidecarLike, type SidecarStatus, type StreamFrame } from './client.js'
import { writeEnvFile } from '../test/env-file.js'
import { answerSidecarRequest, type SidecarReply, type SidecarServerHandlers } from './server-methods.js'

type Responder<M extends SidecarMethodName> = (params: SidecarParams<M>, emit: (frame: Omit<StreamFrame, 'seq'>) => void, opts: CallOptions) => SidecarResultInput<M> | Promise<SidecarResultInput<M>>

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
  private readonly readyGates = new Set<ReadyGate>()

  constructor(opts: FakeSidecarOptions = {}) {
    this.status = opts.status ?? 'ready'
    for (const [method, entries] of loadSidecarFixtures(opts.fixturesDir)) this.fixtures.set(method, entries)
    const handshake = this.fixtures.get('runtime.handshake')?.[0]
    if (handshake) this.describe = SIDECAR_METHODS['runtime.handshake'].result.parse(handshake.result)
    // Every settled turn asks the goal judge (TAL-396); a fresh fake has no goal, so it answers as the sidecar does then.
    this.respond('models.selection_warnings', (params) => ({ warnings: [], context_tokens: params.context_tokens, provider: params.provider ?? '', base_url: '' }))
    this.respond('models.speed_tiers', (params) => ({ tiers: params.routes.map(() => []) }))
    this.respond('state_db.delete_cli_session', (params) => ({ ok: true, deleted_ids: [params.session_id] }))
    // Stands in for the Agent's locked `.env` writer so a test reads back what a save wrote.
    this.respond('config.env_write', (params) => {
      const path = join(params.profile_home, '.env')
      try {
        writeEnvFile(path, params.updates)
      } catch (error) {
        throw new SidecarError((error as Error).message, { code: RPC_ERROR_CODES.invalidParams, condition: 'invalid_params' })
      }
      return { ok: true as const, path }
    })
    // TAL-906: a recorded text gets the Agent's recorded script; any other text is spoken as written.
    this.respond('text.spoken', (params) => (this.fixtures.get('text.spoken')?.find((entry) => (entry.params as { text?: unknown }).text === params.text)?.result as { spoken_text: string } | undefined) ?? { spoken_text: params.text })
    this.respond('goals.evaluate', () => ({ status: null, should_continue: false, continuation_prompt: null, verdict: 'inactive', reason: 'no active goal', message: '' }))
  }

  /** The responder currently installed for `method`, so a test can restore it. */
  responderFor<M extends SidecarMethodName>(method: M): Responder<M> | undefined {
    return this.responders.get(method)
  }

  /** Override one method for the rest of the test; `undefined` restores its recorded fixture. */
  respond<M extends SidecarMethodName>(method: M, responder: Responder<M> | undefined): void {
    if (responder) this.responders.set(method, responder)
    else this.responders.delete(method)
  }

  private serverHandlers: SidecarServerHandlers = {}
  private serverSeq = 0

  serveSidecarRequests(handlers: SidecarServerHandlers): void {
    this.serverHandlers = handlers
  }

  /** What the server answers when the sidecar sends `method` (TAL-1164). */
  async serverRequest(method: string, params: Record<string, unknown>): Promise<SidecarReply> {
    return (await answerSidecarRequest(this.serverHandlers, { jsonrpc: '2.0', id: `s:${++this.serverSeq}`, method, params }))!
  }

  async addReadyGate(gate: ReadyGate): Promise<void> {
    this.readyGates.add(gate)
    if (this.status === 'ready') await gate((method, params, opts) => this.call(method, params, opts))
  }

  /** A sidecar restart as `SidecarClient` runs it: every ready gate completes before the status turns ready again. */
  async restart(): Promise<void> {
    this.status = 'starting'
    for (const gate of this.readyGates) await gate((method, params, opts) => this.call(method, params, opts, true))
    this.status = 'ready'
  }

  async call<M extends SidecarMethodName>(method: M, params: SidecarParams<M>, opts: CallOptions = {}, starting = false): Promise<SidecarResult<M>> {
    const schema = SIDECAR_METHODS[method]
    const parsedParams = schema.params.parse(params) as SidecarParams<M>
    this.calls.push({ method, params: parsedParams })
    const configAccess = (method === 'config.get' || method === 'config.set') && this.status === 'incompatible' && this.describe?.rpc_version === SIDECAR_RPC_VERSION
    if (this.status !== 'ready' && !configAccess && !method.startsWith('runtime.') && !starting) {
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
