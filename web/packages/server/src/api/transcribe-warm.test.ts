import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SidecarError } from '../sidecar/client.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

const capability = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../contracts/fixtures/transcribe-capability.json'), 'utf8')) as Record<'warmable' | 'unwarmable', unknown>

const warm = (s: TestServer): Promise<Response> => s.get('/api/transcribe/warm', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })

function transcribe(s: TestServer): Promise<Response> {
  const body = ['--abc', 'Content-Disposition: form-data; name="file"; filename="clip.m4a"', 'Content-Type: audio/mp4', '', 'audio', '--abc--', ''].join('\r\n')
  return s.get('/api/transcribe', { method: 'POST', body, headers: { 'content-type': 'multipart/form-data; boundary=abc' } })
}

/** The response, or `'blocked'` when it has not arrived within a second. */
async function within(response: Promise<Response>): Promise<Response | 'blocked'> {
  let timer: NodeJS.Timeout | undefined
  const blocked = new Promise<'blocked'>((resolve) => { timer = setTimeout(() => { resolve('blocked') }, 1_000) })
  try { return await Promise.race([response, blocked]) } finally { clearTimeout(timer) }
}

describe('local STT warm-up (TAL-916)', () => {
  let s: TestServer
  let sidecar: FakeSidecar

  beforeAll(async () => {
    sidecar = new FakeSidecar()
    s = await bootTestServer({ sidecar })
  })
  afterAll(async () => { await s.close() })

  it('ships warm_supported from the sidecar capability', async () => {
    sidecar.respond('stt.capability', () => ({ available: true, provider: 'local', streaming: false, warm_supported: true }))
    expect(await (await s.get('/api/transcribe/capability')).json()).toEqual(capability.warmable)
    sidecar.respond('stt.capability', () => ({ available: true, provider: 'openai', streaming: true, warm_supported: false }))
    expect(await (await s.get('/api/transcribe/capability')).json()).toEqual(capability.unwarmable)
    // An unavailable provider never asks a client to warm.
    sidecar.respond('stt.capability', () => ({ available: false, provider: 'none', streaming: false, warm_supported: true }))
    expect(await (await s.get('/api/transcribe/capability')).json()).toMatchObject({ available: false, warm_supported: false })
    sidecar.respond('stt.capability', undefined)
  })

  it('answers before the warm-up finishes and never holds a concurrent transcription behind it', async () => {
    let finish = (): void => undefined
    const loading = new Promise<void>((resolve) => { finish = resolve })
    const warms: string[] = []
    sidecar.respond('stt.warm', async (params) => {
      warms.push(params.profile_home)
      await loading
      return { provider: 'local', warmed: true, action: 'loaded' }
    })
    sidecar.respond('stt.transcribe', () => ({ transcript: 'hot', filtered: false }))
    try {
      const started = await within(warm(s))
      expect(started).not.toBe('blocked')
      expect((started as Response).status).toBe(200)
      expect(await (started as Response).json()).toEqual({ ok: true })
      expect(warms).toEqual([s.deps.profileHome('default')])
      // A second record start during the load joins it instead of holding another sidecar slot.
      expect(((await within(warm(s))) as Response).status).toBe(200)
      expect(warms).toHaveLength(1)
      const transcribed = await within(transcribe(s))
      expect(transcribed).not.toBe('blocked')
      expect(await (transcribed as Response).json()).toEqual({ ok: true, transcript: 'hot', filtered: false, no_speech: false })
    } finally {
      finish()
    }
    // Once the load settles, the next record start warms again (the Agent answers `cached` when still resident).
    await vi.waitFor(async () => {
      await warm(s)
      expect(warms).toHaveLength(2)
    })
    sidecar.respond('stt.warm', undefined)
    sidecar.respond('stt.transcribe', undefined)
  })

  it('keeps a running load joined until the sidecar call really exits', async () => {
    // `stt.warm` cannot be cancelled once the Agent starts loading. Like `SidecarClient`, the fake gives up on a call
    // the moment the server sets it a deadline (here: one shorter than the load) while the worker keeps loading.
    let finish = (): void => undefined
    const loading = new Promise<void>((resolve) => { finish = resolve })
    let workers = 0
    sidecar.respond('stt.warm', async (_params, _emit, opts) => {
      workers++
      const done = loading.then(() => ({ provider: 'local', warmed: true, action: 'loaded' }))
      if (opts.timeoutMs !== 0) throw new SidecarError('sidecar call stt.warm timed out', { condition: 'sidecar_timeout' })
      return await done
    })
    try {
      await warm(s)
      await new Promise((resolve) => setTimeout(resolve, 20))
      // A record start after the client-side give-up must not stack a second load onto the one still running.
      await warm(s)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(workers).toBe(1)
    } finally {
      finish()
      sidecar.respond('stt.warm', undefined)
    }
  })

  it('swallows a failed warm-up: the client never waits on or sees it', async () => {
    sidecar.respond('stt.warm', () => { throw new Error('download failed') })
    const res = await warm(s)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    sidecar.respond('stt.warm', undefined)
  })
})
