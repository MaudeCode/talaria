import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { bootTestServer, type TestServer } from '../test/harness.js'

// TAL-2194: a DNS-rebinding page reaches the loopback server under its own name; only names this server answers to pass.
let server: TestServer | null = null
afterEach(async () => { await server?.close(); server = null })

async function boot(env: Record<string, string> = {}): Promise<TestServer> {
  server = await bootTestServer({ env })
  return server
}

/** Status code of one raw request; raw so the test controls `Host` (or its absence) exactly. */
function status(s: TestServer, head: string[], body = ''): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: s.running.port }, () => { socket.write(`${head.join('\r\n')}\r\n\r\n${body}`) })
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1')
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(data)
      if (m) { socket.destroy(); resolve(Number(m[1])) }
    })
    socket.on('error', reject)
  })
}

const get = (s: TestServer, host: string | null, extra: string[] = [], path = '/api/session?session_id=x') =>
  status(s, [host === null ? `GET ${path} HTTP/1.0` : `GET ${path} HTTP/1.1`, ...(host === null ? [] : [`Host: ${host}`]), 'Connection: close', ...extra])

describe('Host allowlist', () => {
  it.each([['auth off', {}], ['auth on', { HERMES_WEBUI_PASSWORD: 'pw-for-tests' }]])('answers 421 to a rebound name before auth or routing (%s)', async (_label, env) => {
    const s = await boot(env)
    const origin = 'Origin: http://rebind.attacker.example:8787'
    expect(await get(s, 'rebind.attacker.example:8787', [origin])).toBe(421)
    expect(await status(s, ['POST /api/session/new HTTP/1.1', 'Host: rebind.attacker.example:8787', origin, 'Content-Type: application/json', 'Content-Length: 2', 'Connection: close'], '{}')).toBe(421)
    expect(await status(s, ['OPTIONS /api/session/new HTTP/1.1', 'Host: rebind.attacker.example:8787', origin, 'Connection: close'])).toBe(421)
    expect(await status(s, ['GET /api/terminal/ws HTTP/1.1', 'Host: rebind.attacker.example:8787', origin, 'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='])).toBe(421)
  })

  it('names the setting in the body and logs each rejected hostname once', async () => {
    const s = await boot()
    const res = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: s.running.port }, () => { socket.write('GET /api/session HTTP/1.1\r\nHost: Rebind.Attacker.Example\r\nConnection: close\r\n\r\n') })
      let data = ''
      socket.on('data', (chunk) => { data += chunk.toString() })
      socket.on('end', () => { resolve(data) })
      socket.on('error', reject)
    })
    expect(res).toMatch(/^HTTP\/1\.1 421/)
    expect(res).toContain('HERMES_WEBUI_ALLOWED_HOSTS')
    await get(s, 'rebind.attacker.example:9999')
    expect(s.logs.filter((line) => line.includes('rebind.attacker.example'))).toHaveLength(1)
  })

  it('serves loopback names, IP literals, the bind host and allowlisted names, case-insensitively and on any port', async () => {
    const s = await boot({ HERMES_WEBUI_ALLOWED_ORIGINS: 'https://Web.Example:8443', HERMES_WEBUI_ALLOWED_HOSTS: ' talaria.lan , ignored-port.lan:1 ' })
    // The listener is already bound to 127.0.0.1; a named HERMES_WEBUI_HOST is read per request.
    s.deps.config.host = 'Bind.Host.Lan'
    for (const host of ['localhost:8787', 'LOCALHOST', '127.0.0.1:8787', '127.9.9.9', '[::1]:8787', '192.168.1.20:8787', '[fd7a:115c:a1e0::1]:8787',
      'bind.host.lan:8787', 'web.example', 'WEB.EXAMPLE:1', 'talaria.lan:8787', 'Talaria.LAN', 'ignored-port.lan:443']) {
      expect([host, await get(s, host)]).not.toEqual([host, 421])
    }
    expect(await get(s, 'other.lan')).toBe(421)
  })

  it('honours X-Forwarded-Host only from a listed proxy with TRUST_FORWARDED_HOST on', async () => {
    const proxied = ['X-Forwarded-Host: talaria.lan']
    let s = await boot({ HERMES_WEBUI_ALLOWED_HOSTS: 'talaria.lan', HERMES_WEBUI_TRUST_FORWARDED_HOST: '1', HERMES_WEBUI_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' })
    expect(await get(s, 'talaria-upstream:8787', proxied)).not.toBe(421)
    expect(await get(s, 'talaria.lan', ['X-Forwarded-Host: rebind.attacker.example'])).toBe(421)
    await s.close()
    // Loopback is not an implicit proxy here: a rebound page on this host could otherwise name `localhost` itself.
    s = await boot({ HERMES_WEBUI_ALLOWED_HOSTS: 'talaria.lan', HERMES_WEBUI_TRUST_FORWARDED_HOST: '1' })
    expect(await get(s, 'rebind.attacker.example', proxied)).toBe(421)
    expect(await get(s, 'talaria.lan', ['X-Forwarded-Host: rebind.attacker.example'])).not.toBe(421)
    await s.close()
    s = await boot({ HERMES_WEBUI_ALLOWED_HOSTS: 'talaria.lan', HERMES_WEBUI_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' })
    expect(await get(s, 'rebind.attacker.example', proxied)).toBe(421)
  })

  it('serves a request without Host only when it carries no browser provenance', async () => {
    const s = await boot()
    expect(await get(s, null)).not.toBe(421)
    for (const header of ['Origin: http://rebind.attacker.example', 'Referer: http://rebind.attacker.example/', 'Sec-Fetch-Mode: cors', 'Sec-Fetch-Site: same-origin']) {
      expect([header, await get(s, null, [header])]).toEqual([header, 421])
    }
  })
})
