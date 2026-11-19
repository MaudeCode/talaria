/** TAL-2199: the server relays only remote images it vouched for, over https, as an allowed image within a cap. */
import { afterEach, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { fetchRemoteImage, inlineRemoteImage, RemoteImageError, vouchRemoteImage } from './remote-image.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const urlOf = (input: Parameters<typeof fetch>[0]): string => (input instanceof Request ? input.url : input.toString())
const png = (headers: Record<string, string> = {}): Response => new Response(PNG, { headers: { 'content-type': 'image/png', ...headers } })

describe('fetchRemoteImage', () => {
  it('refuses a URL it would not fetch before asking the network', async () => {
    const asked: string[] = []
    const fake: typeof fetch = (input) => { asked.push(urlOf(input)); return Promise.resolve(png()) }
    for (const url of ['http://cdn.example/a.png', 'https://user:pw@cdn.example/a.png', 'https://cdn.example:8443/a.png', 'file:///etc/passwd', 'not a url']) {
      await expect(fetchRemoteImage(url, { fetch: fake }), url).rejects.toMatchObject({ reason: 'unreachable' })
    }
    expect(asked).toEqual([])
  })

  it('relays an allowed image without redirects, and refuses another type, a failed answer or bytes over the cap', async () => {
    const inits: (RequestInit | undefined)[] = []
    const answering = (response: () => Response): typeof fetch => (_input, init) => { inits.push(init); return Promise.resolve(response()) }
    const image = await fetchRemoteImage('https://cdn.example/a.png', { fetch: answering(() => png({ 'content-type': 'image/png; charset=binary' })) })
    expect([image.type, [...image.body]]).toEqual(['image/png', [...PNG]])
    expect(inits[0]?.redirect).toBe('error')
    await expect(fetchRemoteImage('https://cdn.example/a.svg', { fetch: answering(() => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })) })).rejects.toMatchObject({ reason: 'not_image' })
    await expect(fetchRemoteImage('https://cdn.example/a.png', { fetch: answering(() => new Response('gone', { status: 404, headers: { 'content-type': 'image/png' } })) })).rejects.toMatchObject({ reason: 'not_image', status: 404 })
    await expect(fetchRemoteImage('https://cdn.example/a.png', { fetch: answering(() => png()), maxBytes: 3 })).rejects.toMatchObject({ reason: 'too_large' })
    await expect(fetchRemoteImage('https://cdn.example/a.png', { fetch: () => Promise.reject(new TypeError('redirect')) })).rejects.toBeInstanceOf(RemoteImageError)
  })

  it('inlines a logo as a data URL once per URL, and an SVG among the logo types', async () => {
    let calls = 0
    const svg: typeof fetch = () => { calls += 1; return Promise.resolve(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })) }
    const twice = await Promise.all([inlineRemoteImage('https://logos.example/a.svg', svg), inlineRemoteImage('https://logos.example/a.svg', svg)])
    expect(twice).toEqual(Array(2).fill(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`))
    expect(calls).toBe(1)
    expect(await inlineRemoteImage('https://logos.example/big.png', () => Promise.resolve(png({ 'content-length': String(64 * 1024) })))).toBeNull()
  })
})

describe('GET /api/remote-image', () => {
  let server: TestServer | undefined
  afterEach(async () => { await server?.close(); server = undefined })

  it('relays a vouched image sandboxed from a public address, and never one the server did not vouch for or a private address', async () => {
    const fetched: { url: string; addresses: string[] }[] = []
    server = await bootTestServer({ deps: (deps) => {
      deps.dnsLookup = (host) => Promise.resolve(host === 'cdn.example' ? [{ address: '93.184.216.34', family: 4 }] : host === 'intranet.example' ? [{ address: '10.0.0.5', family: 4 }] : [])
      deps.pinnedFetch = (url, _init, addresses) => { fetched.push({ url, addresses }); return Promise.resolve(png()) }
    } })
    const relay = vouchRemoteImage('https://cdn.example/out/cat.png')
    expect(relay).toMatch(/^\.\/api\/remote-image\?id=[0-9a-f]{32}$/)
    expect(vouchRemoteImage('http://cdn.example/out/cat.png')).toBeNull()
    const res = await server.get(`/${relay!.slice(2)}`)
    expect(res.status).toBe(200)
    expect([res.headers.get('content-type'), res.headers.get('content-security-policy')]).toEqual(['image/png', "default-src 'none'; sandbox"])
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...PNG])
    expect((await server.get(`/api/remote-image?id=${'0'.repeat(32)}`)).status).toBe(404)
    // A HEAD would download a body only to drop it, so it fetches nothing.
    expect((await server.get(`/${relay!.slice(2)}`, { method: 'HEAD' })).status).toBe(405)
    // A vouched URL can come from an imported session: one naming or resolving to a non-public address is never requested.
    for (const url of ['https://127.0.0.1/x.png', 'https://10.0.0.1/x.png', 'https://[::1]/x.png', 'https://intranet.example/x.png']) {
      expect((await server.get(`/${vouchRemoteImage(url)!.slice(2)}`)).status, url).toBe(502)
    }
    expect(fetched).toEqual([{ url: 'https://cdn.example/out/cat.png', addresses: ['93.184.216.34'] }])
  })
})
