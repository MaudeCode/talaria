/** Vetted outbound: DNS answers are checked and the connection goes only to them, with the URL host kept for Host/SNI. */
import { spawnSync } from 'node:child_process'
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
  // A child proves callback exceptions cannot terminate the caller's process.
  it.each([
    { status: 204, method: 'GET' },
    { status: 205, method: 'GET' },
    { status: 304, method: 'GET' },
    { status: 200, method: 'HEAD' },
    { status: 600, method: 'GET' },
  ])('survives $method $status responses and releases their streams', ({ status, method }) => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      import { createServer } from 'node:http'
      import { once } from 'node:events'
      import { pinnedFetch } from ${JSON.stringify(new URL('./pinned.ts', import.meta.url).href)}
      const status = ${String(status)}
      const method = ${JSON.stringify(method)}
      let closed
      const server = createServer((req, res) => {
        closed = once(res, 'close')
        res.writeHead(status, { 'x-upstream': 'preserved' })
        if (status === 600 || status === 205) res.write('unfinished discarded response')
        else res.end('discarded body')
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      try {
        const result = pinnedFetch('http://pinned.invalid:' + server.address().port, { method }, ['127.0.0.1'])
        if (status === 600) await assert.rejects(result, RangeError)
        else {
          const response = await result
          assert.equal(response.status, status)
          assert.equal(response.headers.get('x-upstream'), 'preserved')
          assert.equal(response.body, null)
          assert.equal(await response.text(), '')
        }
        await closed
      } finally {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
      }
      console.log('request settled and stream closed')
    `], { encoding: 'utf8', timeout: 10_000 })
    expect(child.error, child.stderr).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toContain('request settled and stream closed')
  })

  let server: Server
  let port = 0
  let finishStream = (): void => undefined
  const seen: { host: string | undefined; method: string | undefined; body: string }[] = []
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => { body += c.toString() })
      req.on('end', () => {
        seen.push({ host: req.headers.host, method: req.method, body })
        if (req.url === '/redirect') { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); return }
        if (req.url === '/stream') {
          res.write('first')
          finishStream = () => { res.end('last') }
          return
        }
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

  it('streams ordinary responses before the upstream finishes', async () => {
    const res = await pinnedFetch(`http://pinned.invalid:${String(port)}/stream`, {}, ['127.0.0.1'])
    const reader = res.body!.getReader()
    try {
      expect(res.status).toBe(200)
      const first = await reader.read()
      expect(Buffer.from(first.value).toString()).toBe('first')
      expect(first.done).toBe(false)
      finishStream()
      expect(Buffer.from((await reader.read()).value).toString()).toBe('last')
      expect((await reader.read()).done).toBe(true)
    } finally {
      finishStream()
      await reader.cancel()
    }
  })
})
