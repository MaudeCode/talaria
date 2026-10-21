/**
 * TAL-1276: the browser sign-in of a plugin-declared OAuth client (provider `plugin:<key>:<id>`). The sidecar runs it
 * with the Agent's own PKCE, loopback listener and token request; the server remembers each started flow's redirect
 * address and `state`, so a pasted address that is not that flow's answer is refused before it reaches the sidecar.
 */
import { timingSafeEqual } from 'node:crypto'

export const PLUGIN_FLOW_PREFIX = 'plugin:'
/** An ended flow's record outlives its deadline this long, like the sidecar keeps an ended flow readable. */
const ENDED_GRACE_MS = 10 * 60_000

interface Expected { home: string; redirect: URL; state: string; until: number }
const FLOWS = new Map<string, Expected>()

export const isPluginFlow = (provider: string): boolean => provider.startsWith(PLUGIN_FLOW_PREFIX)

/** Records a started plugin flow; its authorize link carries the `state` the pasted answer must repeat. */
export function rememberPluginFlow(flowId: string, home: string, start: { verification_url: string; redirect_uri?: string | undefined; expires_in: number }, now = Date.now()): void {
  for (const [id, flow] of FLOWS) if (flow.until < now) FLOWS.delete(id)
  let state: string | null = null
  let redirect: URL | null = null
  try {
    state = new URL(start.verification_url).searchParams.get('state')
    redirect = start.redirect_uri ? new URL(start.redirect_uri) : null
  } catch {
    return
  }
  if (state && redirect) FLOWS.set(flowId, { home, redirect, state, until: now + start.expires_in * 1000 + ENDED_GRACE_MS })
}

export const forgetPluginFlow = (flowId: string): void => { FLOWS.delete(flowId) }

/**
 * `unknown` when this server started no such flow for `home`; `invalid` unless `raw` is the flow's own redirect
 * address on 127.0.0.1 carrying an answer (`code` or `error`) and the flow's `state`.
 */
export function checkPastedRedirect(flowId: string, home: string, raw: string): 'unknown' | 'invalid' | 'ok' {
  const expected = FLOWS.get(flowId)
  if (expected?.home !== home) return 'unknown'
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return 'invalid'
  }
  const { redirect } = expected
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === redirect.port && url.pathname === redirect.pathname
  if (!loopback || !(url.searchParams.has('code') || url.searchParams.has('error'))) return 'invalid'
  const given = Buffer.from(url.searchParams.get('state') ?? '')
  const wanted = Buffer.from(expected.state)
  return given.length === wanted.length && timingSafeEqual(given, wanted) ? 'ok' : 'invalid'
}
