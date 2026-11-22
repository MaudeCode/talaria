/**
 * TAL-2684: the unsettled teammate deliveries of a profile's canonical Bot Chat, read through its native owner's
 * read-only `bot_delivery.list`. The Agent's receipt states become the three a client shows; failed deliveries are left out.
 * A transient owner failure is a 503, never an empty list, so a client keeps the last list it confirmed.
 */
import type { BotDelivery, SessionBotDeliveries } from '@maudecode/talaria-web-contracts'
import { redactString } from '../redact.js'
import type { SidecarLike } from '../sidecar/client.js'
import { HttpFailure } from './service.js'

const STATES: Partial<Record<string, BotDelivery['state']>> = { queued: 'queued', claimed: 'running', working: 'running', waiting_on_you: 'waiting_on_user' }
const UNAVAILABLE = { unsupported: 'agent_unsupported', stopped: 'gateway_stopped' } as const

const transient = (): HttpFailure => new HttpFailure(503, 'Could not read this bot\'s teammate requests right now.')

export async function botDeliveries(sidecar: SidecarLike | null, home: string, sid: string, redact: boolean): Promise<SessionBotDeliveries> {
  if (!sidecar) throw transient()
  let read
  try { read = await sidecar.call('gateway.bot_deliveries', { profile_home: home, session_id: sid }, { timeoutMs: 20_000 }) } catch { throw transient() }
  if (read.state === 'available') {
    const deliveries = read.deliveries.flatMap((row): BotDelivery[] => {
      const state = STATES[row.state]
      if (!state) return []
      const waitingOn = state === 'waiting_on_user' && (row.waiting_on === 'clarify' || row.waiting_on === 'approval') ? row.waiting_on : null
      return [{ delivery_id: row.delivery_id, target: row.target, target_handle: row.target_handle, state, waiting_on: waitingOn, since: row.since, preview: redactString(row.preview, redact) }]
    })
    return { session_id: sid, state: 'available', reason: null, deliveries }
  }
  if (read.state === 'not_bot_chat') return { session_id: sid, state: 'not_bot_chat', reason: null, deliveries: [] }
  if (read.state === 'unavailable') throw transient()
  return { session_id: sid, state: 'unavailable', reason: UNAVAILABLE[read.state], deliveries: [] }
}
