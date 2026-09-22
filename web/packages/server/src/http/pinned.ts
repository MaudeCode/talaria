/**
 * Outbound requests whose destination address must be vetted before a secret
 * travels with them. `vettedAddresses` resolves the hostname and rejects it if
 * any answer is blocked; `pinnedFetch` then connects only to those answers
 * (TLS still validates the URL hostname, SNI and `Host` are untouched), so a
 * record that rebinds between the check and the connection cannot redirect the
 * request. Both are injectable (`AppDeps.dnsLookup`, `AppDeps.pinnedFetch`) so
 * tests never touch real DNS.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, isIPv6 } from 'node:net'
import { Readable } from 'node:stream'

export type DnsLookup = (hostname: string) => Promise<{ address: string; family: number }[]>

export const systemDnsLookup: DnsLookup = (hostname) => dnsLookup(hostname, { all: true })

export class BlockedAddressError extends Error {}

/** Every address `hostname` resolves to, or a `BlockedAddressError` when any of them is refused by `blocked`. */
export async function vettedAddresses(hostname: string, blocked: (address: string) => boolean, lookup: DnsLookup = systemDnsLookup): Promise<string[]> {
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (isIP(bare)) {
    if (blocked(bare)) throw new BlockedAddressError(`blocked address ${bare}`)
    return [bare]
  }
  const answers = await lookup(bare)
  if (!answers.length) throw new BlockedAddressError(`no address for ${bare}`)
  for (const a of answers) if (blocked(a.address)) throw new BlockedAddressError(`${bare} resolves to blocked address ${a.address}`)
  return answers.map((a) => a.address)
}

export interface PinnedInit { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
export type PinnedFetch = (url: string, init: PinnedInit, addresses: string[]) => Promise<Response>

type LookupCallback = ((err: NodeJS.ErrnoException | null, address: string, family: number) => void) & ((err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void)

/** `fetch` that only ever connects to `addresses`; redirects are returned as-is (never followed). */
export const pinnedFetch: PinnedFetch = (url, init, addresses) => {
  const u = new URL(url)
  const pinned = addresses.map((address) => ({ address, family: isIPv6(address) ? 6 : 4 }))
  const first = pinned[0]
  if (!first) return Promise.reject(new BlockedAddressError('no vetted address'))
  const lookup = (_host: string, opts: { all?: boolean }, cb: LookupCallback): void => {
    if (opts.all) cb(null, pinned)
    else cb(null, first.address, first.family)
  }
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method: init.method ?? 'GET', headers: init.headers ?? {}, lookup: lookup as never, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v); else if (Array.isArray(v)) for (const item of v) headers.append(k, item)
      resolve(new Response(Readable.toWeb(res) as ReadableStream, { status: res.statusCode ?? 0, headers }))
    })
    req.on('error', reject)
    req.end(init.body)
  })
}
