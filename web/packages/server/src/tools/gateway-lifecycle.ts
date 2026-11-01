/**
 * TAL-1627: whether Web's local `hermes gateway` CLI controls the Gateway it monitors. Health can watch a Gateway behind an
 * explicit URL (`remoteGatewayBaseUrl`) while every lifecycle entry point drives the active profile's local CLI, so each of
 * them, and Settings, reads this one answer instead of inferring ownership from health or the URL.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { isIPv4 } from 'node:net'
import { join } from 'node:path'
import type { GatewayLifecycle } from '@maudecode/talaria-web-contracts'
import { atomicWriteText } from '../fs/atomic.js'
import { PROFILE_ID_RE } from '../profiles/profiles.js'
import type { SidecarLike } from '../sidecar/client.js'
import { remoteGatewayBaseUrl } from './health.js'

export const LOCAL_GATEWAY: GatewayLifecycle = { managed: true, reason: 'local_gateway', start_command: null }
const EXTERNAL: GatewayLifecycle = { managed: false, reason: 'external_gateway', start_command: null }
const UNVERIFIED: GatewayLifecycle = { managed: false, reason: 'unverified', start_command: null }
const unproven = (startCommand: string | null): GatewayLifecycle => ({ managed: false, reason: 'local_gateway_unproven', start_command: startCommand })

/** The 409 message of a refused lifecycle action; Web's wording is localized from `lifecycle.reason`. */
export const EXTERNALLY_MANAGED = 'This Gateway is managed outside Talaria. Start, stop, or restart it where it runs.'

export interface GatewayLifecycleDeps {
  env: Record<string, string | undefined>
  /** Web's own state directory: the custody record never lives in an Agent profile home. */
  stateDir: string
  sidecar: () => SidecarLike | null
  /** Something answers the monitored endpoint now (Agent health `alive`); read only while no local gateway runs. */
  answering: (profileHome: string) => Promise<boolean>
  log: (line: string) => void
}

/**
 * The credential-free `scheme://host:port[/path]` identity and port of a loopback Gateway URL, or null for anything else.
 * Only literal loopback hosts count (`localhost`, 127/8, `::1`); a look-alike name is external and no hostname is resolved.
 */
export function loopbackEndpoint(base: string): { endpoint: string; port: number } | null {
  let url: URL
  try { url = new URL(base) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host !== 'localhost' && host !== '::1' && !(isIPv4(host) && host.startsWith('127.'))) return null
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  return { endpoint: `${url.protocol}//${host.includes(':') ? `[${host}]` : host}:${String(port)}${url.pathname.replace(/\/+$/, '')}`, port }
}

const CUSTODY_FILE = 'gateway-lifecycle-custody.json'
const CUSTODY_VERSION = 1
type Owners = Record<string, { endpoint: string; proven_at: string }>

/**
 * Proven custody of a loopback endpoint, keyed by canonical profile home. A verified gateway of the profile once owned the
 * endpoint, so Start after Stop, a crash, or a Web restart stays available. A malformed record reads as unreadable
 * (`null`): nothing is proven until a live proof rewrites it.
 */
class Custody {
  private readonly path: string
  constructor(stateDir: string, private readonly log: (line: string) => void) { this.path = join(stateDir, CUSTODY_FILE) }

  private read(): Owners | null {
    let raw: string
    try { raw = readFileSync(this.path, 'utf8') } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null }
    try {
      const data = JSON.parse(raw) as { version?: unknown; owners?: unknown }
      if (data.version !== CUSTODY_VERSION || !data.owners || typeof data.owners !== 'object' || Array.isArray(data.owners)) return null
      const owners: Owners = {}
      for (const [home, row] of Object.entries(data.owners as Record<string, unknown>)) {
        const { endpoint, proven_at } = (row ?? {}) as { endpoint?: unknown; proven_at?: unknown }
        if (typeof endpoint !== 'string' || typeof proven_at !== 'string') return null
        owners[home] = { endpoint, proven_at }
      }
      return owners
    } catch { return null }
  }

  private write(owners: Owners): boolean {
    try { atomicWriteText(this.path, JSON.stringify({ version: CUSTODY_VERSION, owners }, null, 2)); return true } catch (error) {
      this.log(`[gateway] could not write the lifecycle custody record: ${(error as Error).message}`)
      return false
    }
  }

  /** A live proof replaces whatever was there, a malformed record included. */
  record(home: string, endpoint: string): void {
    const owners = this.read() ?? {}
    if (owners[home]?.endpoint === endpoint) return
    this.write({ ...owners, [home]: { endpoint, proven_at: new Date().toISOString() } })
  }

  /** True only for exactly this home and endpoint; a record naming another endpoint is dropped (the target changed). */
  proven(home: string, endpoint: string): boolean {
    const owners = this.read()
    const row = owners?.[home]
    if (!owners || !row) return false
    if (row.endpoint === endpoint) return true
    this.forget(home)
    return false
  }

  forget(home: string): void {
    const owners = this.read()
    if (!owners?.[home]) return
    this.write(Object.fromEntries(Object.entries(owners).filter(([key]) => key !== home)))
  }
}

/** The sidecar's start command, echoed only in its exact `hermes --profile <valid id> gateway start` form. */
function validStartCommand(command: string | null): string | null {
  const name = /^hermes --profile (\S+) gateway start$/.exec(command ?? '')?.[1]
  return name !== undefined && PROFILE_ID_RE.test(name) ? command : null
}

/**
 * The lifecycle capability for the profile at `profileHome`. No explicit Gateway URL keeps the local profile's lifecycle.
 * A non-loopback or malformed URL is external. A loopback URL is managed only when the sidecar proves, with the Agent's own
 * gateway identity checks, that this profile's gateway owns the endpoint, now or (while none runs) in Web's custody record.
 * Every unreadable or unknown answer fails closed.
 */
export async function gatewayLifecycle(deps: GatewayLifecycleDeps, profileHome: string): Promise<GatewayLifecycle> {
  const base = remoteGatewayBaseUrl(deps.env)
  if (base === null) return LOCAL_GATEWAY
  const target = loopbackEndpoint(base)
  if (target === null) return EXTERNAL
  const sidecar = deps.sidecar()
  let home: string
  try { home = realpathSync(profileHome) } catch { return UNVERIFIED }
  if (!sidecar) return UNVERIFIED
  let probe: { state: string; start_command: string | null }
  try { probe = await sidecar.call('gateway.ownership', { profile_home: home, port: target.port }, { timeoutMs: 15_000 }) } catch (error) {
    deps.log(`[gateway] lifecycle ownership unavailable: ${(error as Error).message}`)
    return UNVERIFIED
  }
  const custody = new Custody(deps.stateDir, deps.log)
  switch (probe.state) {
    case 'owned': custody.record(home, target.endpoint); return LOCAL_GATEWAY
    case 'foreign': custody.forget(home); return EXTERNAL
    case 'unbound': return custody.proven(home, target.endpoint) ? LOCAL_GATEWAY : unproven(null)
    case 'stopped': {
      // A tunnel or port map answering where no local gateway runs is someone else's Gateway.
      let answering: boolean
      try { answering = await deps.answering(home) } catch { return UNVERIFIED }
      if (answering) return EXTERNAL
      return custody.proven(home, target.endpoint) ? LOCAL_GATEWAY : unproven(validStartCommand(probe.start_command))
    }
    default: return UNVERIFIED
  }
}
