/** Listener timeouts: a stalled request body cannot hold a socket open indefinitely, while responses stay unbounded. */
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect, createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CONFIG_EXIT_CODE } from './cli/supervise.js'

// TAL-2197: a bind name whose answer this file controls; `.invalid` never resolves in real DNS, so only a listener that
// uses the checked address can bind it.
vi.mock('node:dns/promises', async (original) => {
  const dns = await original<typeof import('node:dns/promises')>()
  const lookup = ((host: string, ...rest: [never]) => host === 'rebind.invalid' ? Promise.resolve({ address: '127.0.0.1', family: 4 }) : dns.lookup(host, ...rest)) as typeof dns.lookup
  return { ...dns, lookup }
})
import { REQUEST_TIMEOUT_MS } from './server.js'
import { bootTestServer, type TestServer } from './test/harness.js'

describe('request timeout', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())

  it('is finite, longer than the headers timeout, and answers 408 to a client that stops sending an in-limit body', async () => {
    expect(s.running.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS)
    expect(s.running.server.headersTimeout).toBeLessThan(REQUEST_TIMEOUT_MS)
    // The check interval is 5 s; shrink the deadline itself so the stalled body times out on the next sweep.
    const headersTimeout = s.running.server.headersTimeout
    s.running.server.headersTimeout = 200
    s.running.server.requestTimeout = 300
    try {
      const result = await new Promise<{ status: string; closed: boolean }>((resolve, reject) => {
        const socket = connect(s.running.port, '127.0.0.1', () => {
          socket.write('POST /api/auth/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"password":')
        })
        let out = ''
        socket.on('data', (d: Buffer) => { out += d.toString() })
        socket.on('close', () => { resolve({ status: out.split('\r\n')[0] ?? '', closed: true }) })
        socket.on('error', reject)
        setTimeout(() => { socket.destroy(); reject(new Error('socket still open after the request timeout sweep')) }, 12_000).unref()
      })
      expect(result.closed).toBe(true)
      expect(result.status).toContain('408')
    } finally {
      s.running.server.requestTimeout = REQUEST_TIMEOUT_MS
      s.running.server.headersTimeout = headersTimeout
    }
  }, 15_000)
})

describe('credential permissions at startup', () => {
  const bootWithEnvFile = async (env: Record<string, string> = {}) => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-hermes-home-'))
    const file = join(home, '.env')
    writeFileSync(file, 'OPENAI_API_KEY=sk-test\n')
    chmodSync(file, 0o644)
    const s = await bootTestServer({ env: { HERMES_HOME: home, ...env } })
    const mode = statSync(file).mode & 0o777
    await s.close()
    rmSync(home, { recursive: true, force: true })
    return mode
  }

  it('tightens a group- or world-readable .env to 0600', async () => {
    expect(await bootWithEnvFile()).toBe(0o600)
  })

  it('leaves the file alone when HERMES_SKIP_CHMOD=1', async () => {
    expect(await bootWithEnvFile({ HERMES_SKIP_CHMOD: '1' })).toBe(0o644)
  })

  it('removes only world bits when the operator declares HERMES_HOME_MODE', async () => {
    expect(await bootWithEnvFile({ HERMES_HOME_MODE: '0750' })).toBe(0o640)
  })

  it('never follows a symlinked credential name to its target', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talaria-hermes-home-'))
    const target = join(home, 'unrelated.txt')
    writeFileSync(target, 'shared\n')
    chmodSync(target, 0o644)
    symlinkSync(target, join(home, '.env'))
    const s = await bootTestServer({ env: { HERMES_HOME: home } })
    await s.close()
    expect(statSync(target).mode & 0o777).toBe(0o644)
    rmSync(home, { recursive: true, force: true })
  })
})

describe('unauthenticated bind at startup (TAL-2197)', () => {
  const bootLogs = async (env: Record<string, string>) => {
    const s = await bootTestServer({ env })
    await s.close()
    return s.logs.join('\n')
  }
  const freePort = async (): Promise<number> => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '0.0.0.0', resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise((resolve) => probe.close(resolve))
    return port
  }
  const bindable = (port: number): Promise<boolean> => new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => { resolve(false) })
    probe.listen(port, '0.0.0.0', () => probe.close(() => { resolve(true) }))
  })

  it('refuses 0.0.0.0 with no sign-in method before listening, naming both fixes and the fatal exit code', async () => {
    const port = await freePort()
    const refused = bootTestServer({ env: { TALARIA_WEB_HOST: '0.0.0.0', TALARIA_WEB_PORT: String(port) } })
    await expect(refused).rejects.toMatchObject({ exitCode: CONFIG_EXIT_CODE })
    await expect(refused).rejects.toThrow(/TALARIA_WEB_PASSWORD[\s\S]*TALARIA_WEB_ALLOW_UNAUTHENTICATED=1/)
    expect(await bindable(port)).toBe(true)
  })

  it('listens on the address it checked rather than resolving the name again', async () => {
    // A second lookup of the name (real DNS) fails, so the listener's address shows which resolution it used.
    const booted = await bootTestServer({ env: { TALARIA_WEB_HOST: 'rebind.invalid' } }).catch((error: unknown) => ({ error }))
    try { expect('running' in booted ? booted.running.server.address() : booted.error).toMatchObject({ address: '127.0.0.1' }) } finally {
      if ('running' in booted) await booted.close()
    }
  })

  it('starts 0.0.0.0 once a password or a trusted auth header is configured', async () => {
    for (const env of [{ TALARIA_WEB_PASSWORD: 'correct horse' }, { TALARIA_WEB_TRUSTED_AUTH_HEADER: 'X-Forwarded-User' }]) {
      expect(await bootLogs({ TALARIA_WEB_HOST: '0.0.0.0', ...env }), Object.keys(env)[0]).toContain('Talaria Web listening on http://0.0.0.0:')
    }
  })

  it('starts 0.0.0.0 with no sign-in method when TALARIA_WEB_ALLOW_UNAUTHENTICATED=1, and still warns', async () => {
    const logs = await bootLogs({ TALARIA_WEB_HOST: '0.0.0.0', TALARIA_WEB_ALLOW_UNAUTHENTICATED: '1' })
    expect(logs).toContain('Talaria Web listening on http://0.0.0.0:')
    expect(logs).toContain('[!!] WARNING: Binding to 0.0.0.0 with NO PASSWORD SET.')
  })

  it('starts on any loopback spelling with no sign-in method and no opt-out, without the warning', async () => {
    for (const host of ['127.0.0.1', 'localhost', '0:0:0:0:0:0:0:1']) {
      const logs = await bootLogs({ TALARIA_WEB_HOST: host })
      expect(logs, host).toContain('Talaria Web listening on')
      expect(logs, host).not.toContain('NO PASSWORD SET')
    }
  })
})

describe('forwarded-for proxy guidance at startup', () => {
  const bootLogs = async (env: Record<string, string>) => {
    const s = await bootTestServer({ env })
    await s.close()
    return s.logs.join('\n')
  }
  const GUIDANCE = 'lists no proxy outside this host'

  it('explains that loopback is trusted and other proxies must be listed when no outside proxy is configured', async () => {
    for (const cidrs of [undefined, '127.0.0.1/32', '127.0.0.0/8; ::1']) {
      const logs = await bootLogs({ TALARIA_WEB_TRUST_FORWARDED_FOR: '1', ...(cidrs ? { TALARIA_WEB_TRUSTED_PROXY_CIDRS: cidrs } : {}) })
      expect(logs, String(cidrs)).toContain(GUIDANCE)
      expect(logs).toContain('The request log trusts a proxy on this host through loopback')
      expect(logs).toContain('use its forwarded client only once it is listed (TALARIA_WEB_TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128)')
      expect(logs).toContain('TALARIA_WEB_TRUSTED_PROXY_CIDRS=172.17.0.1')
      expect(logs).toContain('$proxy_add_x_forwarded_for')
    }
  })

  it('stays quiet without the opt-in or once a proxy outside this host is listed', async () => {
    expect(await bootLogs({})).not.toContain(GUIDANCE)
    expect(await bootLogs({ TALARIA_WEB_TRUSTED_PROXY_CIDRS: '127.0.0.1/32' })).not.toContain(GUIDANCE)
    for (const cidrs of ['172.17.0.1', '10.0.0.0/8', '127.0.0.1, 2001:db8::/32', '0.0.0.0/0']) {
      expect(await bootLogs({ TALARIA_WEB_TRUST_FORWARDED_FOR: '1', TALARIA_WEB_TRUSTED_PROXY_CIDRS: cidrs }), cidrs).not.toContain(GUIDANCE)
    }
  })
})
