import { describe, expect, it } from 'vitest'
import { SSE_MAX_BUFFERED_BYTES, SseWriter } from './sse-routes.js'
import type { RequestContext } from '../http/context.js'

function fakeCtx(writableLength: number): { ctx: RequestContext; written: string[]; destroyed: () => boolean; logs: string[] } {
  const written: string[] = []
  const logs: string[] = []
  let destroyed = false
  const res = {
    destroyed: false,
    get writableLength() { return writableLength },
    on: () => undefined,
    write: (chunk: string) => { written.push(chunk); return true },
    writeHead: () => undefined,
    flushHeaders: () => undefined,
    end: () => undefined,
    destroy: () => { destroyed = true },
  }
  const ctx = { res, pendingCookies: [], securityHeaders: () => ({}), markFinished: () => undefined, deps: { log: (line: string) => { logs.push(line) } } } as unknown as RequestContext
  return { ctx, written, destroyed: () => destroyed, logs }
}

describe('SseWriter backpressure', () => {
  it('writes while the response buffer is small', () => {
    const { ctx, written, destroyed } = fakeCtx(1024)
    const sse = new SseWriter(ctx, () => undefined, false)
    sse.start()
    sse.event('token', { text: 'hi' }, 'run:1')
    sse.comment('heartbeat')
    expect(written).toEqual(['id: run:1\nevent: token\ndata: {"text":"hi"}\n\n', ': heartbeat\n\n'])
    expect(destroyed()).toBe(false)
  })

  it('closes a slow consumer instead of growing the response buffer without bound', () => {
    const { ctx, written, destroyed, logs } = fakeCtx(SSE_MAX_BUFFERED_BYTES + 1)
    let released = 0
    const sse = new SseWriter(ctx, () => { released += 1 }, false)
    sse.start()
    sse.event('token', { text: 'dropped' })
    expect(written).toEqual([])
    expect(destroyed()).toBe(true)
    expect(sse.isClosed).toBe(true)
    expect(released).toBe(1)
    expect(logs[0]).toContain('closing slow event-stream client')
    sse.event('token', { text: 'after close' })
    expect(written).toEqual([])
  })
})
