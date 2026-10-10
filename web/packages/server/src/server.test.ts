/** Listener timeouts: a stalled request body cannot hold a socket open indefinitely, while responses stay unbounded. */
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
