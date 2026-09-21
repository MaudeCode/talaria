/** The streaming ZIP writer: a client that disconnects mid-entry fails the entry cleanly instead of crashing or hanging. */
import { Readable, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ZipWriter } from './zip.js'

describe('ZipWriter', () => {
  it('a client disconnect mid-file rejects addFile, releases the source, and raises no unhandled rejection', async () => {
    let received = 0
    const sink = new Writable({
      highWaterMark: 1024,
      write(chunk: Buffer, _enc, cb) {
        received += chunk.length
        if (received > 8 * 1024) { this.destroy(); return }
        cb()
      },
    })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const zip = new ZipWriter(sink)
      // Incompressible input so the deflated body keeps flowing into the destroyed sink.
      const chunks = Array.from({ length: 256 }, () => Buffer.from(Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256))))
      const source = Readable.from(chunks)
      await expect(Promise.race([zip.addFile('big.bin', source), new Promise((_, reject) => setTimeout(() => { reject(new Error('addFile hung')) }, 5_000))])).rejects.toThrow(/client disconnected/)
      expect(source.destroyed).toBe(true)
      await new Promise((r) => setImmediate(r))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
