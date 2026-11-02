import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { expect, vi } from 'vitest'
import { SessionEnvelopeSchema, type GatewaySnapshot, type GatewaySessionResult } from '@maudecode/talaria-web-contracts'
import type { StreamFrame } from '../sidecar/client.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, openStateDb, type TestServer } from './harness.js'

// Shared by the gateway session test files. The canonical owner attachment tests are split across files so that CI
// shards can balance them (TAL-1774).
export const fixture = JSON.parse(readFileSync(new URL('./fixtures/canonical-ownership.json', import.meta.url), 'utf8')) as { sessions: Record<string, string>; diagnostic: Record<'safe' | 'ignore_config' | 'fresh', string>; schema: string[]; inserts: string[] }
export const nativeNotices = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/web-native-notices.json', import.meta.url), 'utf8')) as { events: Record<string, unknown>[] }
export const ownerEvents = JSON.parse(readFileSync(new URL('./fixtures/gateway-owner-events.json', import.meta.url), 'utf8')) as { events: Record<string, unknown>[] }
export const cronRefusal = JSON.parse(readFileSync(new URL('../../../../../contracts/fixtures/native-cron-refusal.json', import.meta.url), 'utf8')) as { completion: Record<string, unknown>; event: { event: string; data: Record<string, unknown> } }
export const sid = fixture.sessions.cli!
export const snapshot = (extra: Partial<GatewaySnapshot> = {}): GatewaySnapshot => ({ session_id: sid, stored_session_id: sid,
  messages: [{ role: 'user', content: 'native question' }, { role: 'assistant', content: 'owner answer' }], message_count: 2,
  running: false, authority_epoch: 1, replay_epoch: 'owner-epoch', last_sequence: 4, subscription_id: 'viewer', revision: 2,
  execution_generation: 1, pending: [], prompts: [], info: { title: 'Native chat', model: 'native-model' }, ...extra })
export const attached = (snap: GatewaySnapshot): GatewaySessionResult => ({ state: 'attached', reason: null, receipt: null, snapshot: snap })
export const admission = (status: 'queued' | 'started' | 'unknown' | 'terminal' = 'started') => ({ admission_id: 'native-input', sequence: 1, status, outcome: null, authority_epoch: 1, execution_generation: 1, text: 'native work', input_id: 'stable-input' })

export interface OwnerAttachment { s: TestServer; db: DatabaseSync; sidecar: FakeSidecar }

/** Boots a server whose sidecar is fake and whose Agent state.db holds the canonical-ownership fixture. */
export async function bootOwnerAttachment(): Promise<OwnerAttachment> {
  const sidecar = new FakeSidecar()
  const s = await bootTestServer({ sidecar })
  const db = openStateDb(join(s.state, 'state.db'))
  db.exec(fixture.schema.join('\n'))
  for (const sql of fixture.inserts) db.exec(sql)
  await s.deps.settings.save({ show_cli_sessions: true })
  return { s, db, sidecar }
}

/** Request helpers over the current test's owner attachment, read when each helper runs. */
export function ownerHelpers(current: () => Pick<OwnerAttachment, 's' | 'sidecar'>) {
  const post = (path: string, body: unknown) => current().s.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  /** Own one synthetic owner connection and exercise its actual journalled SSE projection. */
  const observeOwner = async (initial: GatewaySnapshot, profile = 'default') => {
    const { s, sidecar } = current()
    let snap = initial
    let outcome = 'completed'
    let emit: ((frame: Omit<StreamFrame, 'seq'>) => void) | undefined
    const original = sidecar.responderFor('gateway.session')
    const headers = { cookie: `hermes_profile=${profile}` }
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.session_id !== initial.session_id || params.profile_home !== s.deps.profileHome(profile)) return original!(params, send, opts)
      if (params.action !== 'watch') return { ...attached(snap), receipt: params.action === 'receipt' ? { ...admission('terminal'), admission_id: params.admission_id!, execution_generation: snap.execution_generation, authority_epoch: snap.authority_epoch, outcome } : null }
      emit = send
      send({ event: 'snapshot', data: attached(snap) })
      return new Promise((resolve) => { opts.signal!.addEventListener('abort', () => { resolve(attached(snap)) }, { once: true }) })
    })
    const row = SessionEnvelopeSchema.parse(await (await s.get(`/api/session?session_id=${initial.session_id}`, { headers })).json())
    const stream = row.session.active_stream_id!
    const read = s.sse(`/api/chat/stream?stream_id=${stream}&replay=1&after_seq=0`, (frame) => frame.event === 'stream_end' || frame.event === 'apperror', { headers })
    await vi.waitFor(() => { expect(s.deps.registry.peek(stream)?.subscriberCount).toBe(1) })
    return { stream, read, get attached() { return Boolean(emit) },
      event: (type: string, payload: Record<string, unknown>, generation = snap.execution_generation, stamps: Record<string, unknown> = {}) => {
        emit!({ event: 'event', data: { type, payload, authority_epoch: snap.authority_epoch, replay_epoch: snap.replay_epoch, execution_generation: generation, session_id: snap.session_id, ...stamps } })
      },
      snapshot: (extra: Partial<GatewaySnapshot>, replayGap = false, notify = true) => {
        snap = { ...snap, ...extra }
        if (notify) emit!({ event: 'snapshot', data: { ...attached(snap), replay_gap: replayGap } })
      },
      reactionSnapshot: () => { emit!({ event: 'snapshot', data: { ...attached({ ...snap, running: false, pending: [] }), reaction_only: true } }) },
      replaySnapshot: () => { emit!({ event: 'snapshot', data: { ...attached(snap), replaying: true } }) },
      replayComplete: (terminalOutcome: string) => { outcome = terminalOutcome; emit!({ event: 'replay_complete', data: {} }) },
      finish: (generation = snap.execution_generation, terminalOutcome = 'completed') => {
        outcome = terminalOutcome
        snap = { ...snap, execution_generation: generation, running: false, pending: [] }
        emit!({ event: 'event', data: { type: 'session.info', payload: { authority_epoch: snap.authority_epoch, execution_generation: generation, running: false, pending: [] } } })
      },
    }
  }

  const holdOwnerReceipt = () => {
    const { sidecar } = current()
    const original = sidecar.responderFor('gateway.session')!
    let resolve!: (result: GatewaySessionResult) => void
    const receipt = new Promise<GatewaySessionResult>((release) => { resolve = release })
    let requested = false
    sidecar.respond('gateway.session', (params, send, opts) => {
      if (params.action === 'receipt' && !requested) { requested = true; return receipt }
      return original(params, send, opts)
    })
    return { get requested() { return requested }, release: () => { resolve({ ...attached(snapshot()), receipt: { ...admission('terminal'), outcome: 'completed' } }) } }
  }
  return { post, observeOwner, holdOwnerReceipt }
}
