/**
 * TAL-2199: remote images the server vouches for. The CSP keeps every page's images on this origin, so an image a media
 * tool made on a provider's host loads through `GET /api/remote-image?id=`, and a connector's catalog logo ships inline
 * as a `data:` URL. Only URLs the server read from a tool result or the connector catalog get either; a remote image in
 * text the agent writes is a link (`linkRemoteImages`), never fetched for it.
 */
import { createHash } from 'node:crypto'

export const REMOTE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
const MAX_REMOTE_IMAGE_BYTES = 16 * 1024 * 1024

/** Why a remote image was not relayed: `status` is the upstream answer, null when none arrived. */
export class RemoteImageError extends Error {
  constructor(readonly reason: 'unreachable' | 'not_image' | 'too_large', readonly status: number | null = null) { super(`remote image ${reason}`) }
}

/** An `https:` URL on the default port with no credentials, which the server may fetch; else null. */
export function fetchableImageUrl(url: string): URL | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password && parsed.hostname ? parsed : null
}

/** One image over https, no redirects, an allowed type and a size cap: refused before any bytes are relayed. */
export async function fetchRemoteImage(url: string, opts: { fetch?: typeof fetch; signal?: AbortSignal; types?: ReadonlySet<string>; maxBytes?: number } = {}): Promise<{ type: string; body: Buffer }> {
  const types = opts.types ?? REMOTE_IMAGE_TYPES
  const maxBytes = opts.maxBytes ?? MAX_REMOTE_IMAGE_BYTES
  if (!fetchableImageUrl(url)) throw new RemoteImageError('unreachable')
  let response: Response
  try { response = await (opts.fetch ?? fetch)(url, { redirect: 'error', ...(opts.signal ? { signal: opts.signal } : {}), headers: { accept: [...types].join(',') } }) } catch { throw new RemoteImageError('unreachable') }
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (response.status !== 200 || response.redirected || !types.has(type) || declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new RemoteImageError('not_image', response.status)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body ?? []) {
    total += (chunk as Uint8Array).byteLength
    if (total > maxBytes) throw new RemoteImageError('too_large', response.status)
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  return { type, body: Buffer.concat(chunks) }
}

/** URLs the server vouched for, by id; the oldest leaves first. ponytail: in memory, so a restart forgets them until the transcript that names one loads again. */
const vouched = new Map<string, string>()
const MAX_VOUCHED = 4096

/** A media tool's remote image as the app URL that relays it, or null for one the server would not fetch. */
export function vouchRemoteImage(url: string): string | null {
  if (!fetchableImageUrl(url)) return null
  const id = createHash('sha256').update(url).digest('hex').slice(0, 32)
  vouched.delete(id)
  vouched.set(id, url)
  if (vouched.size > MAX_VOUCHED) vouched.delete(vouched.keys().next().value!)
  return `./api/remote-image?id=${id}`
}

/** The URL behind a relay id, or null when the server never vouched for it (or has forgotten it). */
export const vouchedRemoteImage = (id: string): string | null => vouched.get(id) ?? null

const LOGO_TYPES: ReadonlySet<string> = new Set([...REMOTE_IMAGE_TYPES, 'image/svg+xml'])
const MAX_LOGO_BYTES = 32 * 1024
const LOGO_FETCHES = 8
const inlined = new Map<string, Promise<string | null>>()
let active = 0
const waiting: (() => void)[] = []

/**
 * A catalog logo as a `data:` URL, fetched once per URL; null when it is not an allowed image within the cap. At most
 * `LOGO_FETCHES` run at once. An SVG shown through `<img>` runs no script and loads nothing else.
 */
export function inlineRemoteImage(url: string, fetchImpl?: typeof fetch): Promise<string | null> {
  let pending = inlined.get(url)
  if (!pending) {
    pending = (async () => {
      if (active >= LOGO_FETCHES) await new Promise<void>((resolve) => { waiting.push(resolve) })
      active += 1
      try {
        const image = await fetchRemoteImage(url, { types: LOGO_TYPES, maxBytes: MAX_LOGO_BYTES, signal: AbortSignal.timeout(10_000), ...(fetchImpl ? { fetch: fetchImpl } : {}) })
        return `data:${image.type};base64,${image.body.toString('base64')}`
      } catch { return null } finally {
        active -= 1
        waiting.shift()?.()
      }
    })()
    inlined.set(url, pending)
  }
  return pending
}
