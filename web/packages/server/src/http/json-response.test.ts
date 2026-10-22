import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { gzip, gzipSync, gunzipSync } from 'node:zlib'
import { os } from '@orpc/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RequestContext } from './context.js'
import { createApp } from '../app.js'
import type { ApiContext } from '../api/router.js'
import { SseWriter } from '../api/sse-routes.js'
import { bootTestServer, type TestServer } from '../test/harness.js'

vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>()
  return { ...actual, gzip: vi.fn(actual.gzip), gzipSync: vi.fn(actual.gzipSync) }
})

function response(s: TestServer, encoding = 'gzip', method = 'GET') {
  const req = new IncomingMessage(new Socket())
  req.url = '/test-json'
  req.method = method
  req.headers = { host: 'localhost', 'accept-encoding': encoding }
  const res = new ServerResponse(req)
  const writeHead = vi.spyOn(res, 'writeHead')
  const header = (name: string) => Object.entries(writeHead.mock.calls[0]?.[1] ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]
  const end = vi.spyOn(res, 'end').mockImplementation(() => { res.emit('close'); return res })
  return { req, res, ctx: new RequestContext(req, res, s.deps), end, header, body: () => end.mock.calls[0]?.[0] as Buffer | undefined }
}

function send(s: TestServer, out: ReturnType<typeof response>, payload: { text: string }, path: 'raw' | 'orpc') {
  return path === 'raw' ? out.ctx.json(payload) : createApp(s.deps, {
    router: { json: os.$context<ApiContext>().route({ method: 'GET', path: '/test-json' }).handler(() => payload) },
  }).handler(out.req, out.res)
}

describe('JSON response encoding', () => {
  let s: TestServer
  beforeAll(async () => { s = await bootTestServer() })
  afterAll(() => s.close())
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks() })

  it.each(['raw', 'orpc'] as const)('%s yields to an SSE heartbeat while compressing 2 MiB without gzipSync', async (path) => {
    vi.mocked(gzipSync).mockClear()
    const out = response(s)
    const stream = response(s)
    vi.spyOn(stream.res, 'flushHeaders').mockImplementation(() => undefined)
    const write = vi.spyOn(stream.res, 'write').mockReturnValue(true)
    const sse = new SseWriter(stream.ctx, () => undefined, false)
    sse.start()
    const payload = { text: 'x'.repeat(2 * 1024 * 1024) }
    let started: () => void = () => undefined
    const compressionStarted = new Promise<void>((resolve) => { started = resolve })
    const sync = vi.mocked(gzipSync).getMockImplementation()!
    const asyncGzip = vi.mocked(gzip).getMockImplementation()!
    vi.mocked(gzipSync).mockImplementationOnce((...args) => { started(); return sync(...args) })
    vi.mocked(gzip).mockImplementationOnce((...args) => { started(); asyncGzip(...args) })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    setTimeout(() => { sse.comment('heartbeat') }, 0)
    const sending = send(s, out, payload, path)
    try {
      await compressionStarted
      vi.advanceTimersByTime(0)
      expect(write).toHaveBeenCalledWith(': heartbeat\n\n')
      expect(out.end, 'JSON must still be compressing when the heartbeat is delivered').not.toHaveBeenCalled()
      expect(gzipSync).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      await sending
    }
    const body = out.body()!
    expect(JSON.parse(gunzipSync(body).toString())).toEqual(payload)
    expect(out.header('content-length')).toBe(String(body.length))
  })

  it.each(['raw', 'orpc'] as const)('%s handles compression failure without writing a partial response', async (path) => {
    const out = response(s)
    const error = new Error('synthetic gzip failure')
    vi.mocked(gzip).mockImplementationOnce((_input, _options, callback) => { callback(error, Buffer.alloc(0)) })
    const payload = { text: 'x'.repeat(2048) }
    if (path === 'raw') {
      await expect(out.ctx.json(payload)).rejects.toThrow(error)
    } else {
      const destroy = out.res.destroy.bind(out.res)
      const destroyed = vi.spyOn(out.res, 'destroy').mockImplementation((reason) => { destroy(reason); out.res.emit('close'); return out.res })
      await send(s, out, payload, path)
      expect(destroyed).toHaveBeenCalledWith(error)
    }
    expect(out.res.destroyed).toBe(true)
    expect(out.end).not.toHaveBeenCalled()
    expect(out.res.headersSent).toBe(false)
  })

  it.each(['raw', 'orpc'] as const)('%s discards compressed output when the client disconnects', async (path) => {
    const out = response(s)
    const asyncGzip = vi.mocked(gzip).getMockImplementation()!
    vi.mocked(gzip).mockImplementationOnce((input, options, callback) => {
      asyncGzip(input, options, (error, body) => {
        out.res.destroy()
        out.res.emit('close')
        callback(error, body)
      })
    })
    const payload = { text: 'x'.repeat(2048) }
    await send(s, out, payload, path)
    expect(out.res.destroyed).toBe(true)
    expect(out.end).not.toHaveBeenCalled()
    expect(out.res.headersSent).toBe(false)
  })

  it('uses compact JSON by default, preserves explicit pretty output and ETags', async () => {
    const payload = { nested: { text: '日本語', list: [1, 2] } }
    for (const pretty of [undefined, false, true]) {
      const out = response(s, 'identity')
      await out.ctx.json(payload, { etag: 'W/"fixture"', ...(pretty === undefined ? {} : { pretty }) })
      const expected = JSON.stringify(payload, null, pretty === true ? 2 : undefined)
      expect(out.body()?.toString()).toBe(expected)
      expect(out.header('etag')).toBe('W/"fixture"')
      expect(out.header('content-length')).toBe(String(Buffer.byteLength(expected)))
    }
    const cached = response(s)
    cached.req.headers['if-none-match'] = '"fixture"'
    await cached.ctx.json(payload, { etag: 'W/"fixture"' })
    expect(cached.res.statusCode).toBe(304)
    expect(cached.body()).toEqual(Buffer.alloc(0))
    expect(cached.header('content-encoding')).toBeUndefined()
  })

  it.each([1024, 1025])('keeps the exact compression byte threshold at %i bytes', async (size) => {
    const out = response(s)
    const payload = { text: 'x'.repeat(size - 11) }
    await out.ctx.json(payload)
    expect(out.header('content-encoding')).toBe(size > 1024 ? 'gzip' : undefined)
    const body = out.body()!
    expect(JSON.parse((size > 1024 ? gunzipSync(body) : body).toString())).toEqual(payload)
  })

  it.each(['identity', 'gzip;q=0', '*;q=0'])('does not compress when negotiation refuses gzip: %s', async (encoding) => {
    const out = response(s, encoding)
    const payload = { text: 'x'.repeat(2048) }
    await out.ctx.json(payload)
    expect(out.header('content-encoding')).toBeUndefined()
    expect(JSON.parse(out.body()?.toString() ?? '')).toEqual(payload)
  })
})
