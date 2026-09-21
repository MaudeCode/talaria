/** Vetted outbound: DNS answers are checked and the connection goes only to them, with the URL host kept for Host/SNI. */
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BlockedAddressError, pinnedFetch, vettedAddresses } from './pinned.js'

const privateV4 = (ip: string) => /^(10\.|127\.|192\.168\.)/.test(ip)

describe('vettedAddresses', () => {
  it('returns every answer when none is blocked and refuses the host when any is', async () => {
    const lookup = (h: string) => Promise.resolve(h === 'good.example' ? [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }] : [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }])
    await expect(vettedAddresses('good.example', privateV4, lookup)).resolves.toEqual(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])
    await expect(vettedAddresses('rebind.example', privateV4, lookup)).rejects.toBeInstanceOf(BlockedAddressError)
    await expect(vettedAddresses('10.0.0.5', privateV4, lookup)).rejects.toBeInstanceOf(BlockedAddressError)
    await expect(vettedAddresses('[2606:2800::1]', privateV4, lookup)).resolves.toEqual(['2606:2800::1'])
    await expect(vettedAddresses('empty.example', privateV4, () => Promise.resolve([]))).rejects.toBeInstanceOf(BlockedAddressError)
    await expect(vettedAddresses('nx.example', privateV4, () => Promise.reject(new Error('ENOTFOUND')))).rejects.toThrow('ENOTFOUND')
  })
})

describe('pinnedFetch', () => {
  let server: Server
  let port = 0
  const seen: { host: string | undefined; method: string | undefined; body: string }[] = []
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => { body += c.toString() })
      req.on('end', () => {
        seen.push({ host: req.headers.host, method: req.method, body })
        if (req.url === '/redirect') { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); return }
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-multi': ['a', 'b'] })
        res.end('ID3pinned')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })
  afterAll(() => new Promise<void>((r) => server.close(() => { r() })))

  it('connects to the pinned address while the URL hostname stays in the Host header; redirects are returned, not followed', async () => {
    // `pinned.invalid` never resolves; the request reaches the loopback server only through the pinned address.
    const res = await pinnedFetch(`http://pinned.invalid:${String(port)}/audio`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"input":"x"}' }, ['127.0.0.1'])
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('x-multi')).toBe('a, b')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('ID3pinned')
    expect(seen.at(-1)).toEqual({ host: `pinned.invalid:${String(port)}`, method: 'POST', body: '{"input":"x"}' })
    const redirect = await pinnedFetch(`http://pinned.invalid:${String(port)}/redirect`, {}, ['127.0.0.1'])
    expect(redirect.status).toBe(302)
    expect(redirect.ok).toBe(false)
    await redirect.body?.cancel()
    await expect(pinnedFetch(`http://pinned.invalid:${String(port)}/audio`, {}, [])).rejects.toBeInstanceOf(BlockedAddressError)
  })

  it('honours an abort signal', async () => {
    const signal = AbortSignal.timeout(1)
    await new Promise((r) => setTimeout(r, 5))
    await expect(pinnedFetch(`http://pinned.invalid:${String(port)}/audio`, { signal }, ['127.0.0.1'])).rejects.toThrow()
  })
})
