/**
 * Minimal streaming ZIP writer (deflate, data descriptors, zip64-free) for
 * `/api/folder/download`: each entry is deflated as it is read and written to
 * the response with backpressure, so memory stays bounded by one stream chunk
 * (Python streamed `zipfile.ZipFile(handler.wfile)` the same way).
 */
import { crc32, createDeflateRaw } from 'node:zlib'
export { crc32 } from 'node:zlib'
import type { Readable, Writable } from 'node:stream'

interface Entry { name: Buffer; crc: number; compressed: number; uncompressed: number; offset: number; time: number; date: number }

function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return [time, date]
}

export class ZipWriter {
  private readonly entries: Entry[] = []
  private offset = 0

  constructor(private readonly out: Writable, private readonly now = new Date()) {}

  private write(chunk: Buffer): Promise<void> {
    this.offset += chunk.length
    if (this.out.destroyed) return Promise.reject(new Error('client disconnected'))
    if (this.out.write(chunk)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = (): void => { this.out.off('close', done); this.out.off('error', reject); resolve() }
      this.out.once('drain', done); this.out.once('close', done); this.out.once('error', reject)
    })
  }

  /** Stream one file: local header with the data-descriptor flag, deflated body, then crc and sizes. */
  async addFile(name: string, data: Readable): Promise<void> {
    const nameBuf = Buffer.from(name.split('\\').join('/'), 'utf8')
    const [time, date] = dosTime(this.now)
    const offset = this.offset
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0808, 6) // data descriptor + UTF-8 names
    header.writeUInt16LE(8, 8) // deflate
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt16LE(nameBuf.length, 26)
    await this.write(header)
    await this.write(nameBuf)
    let crc = 0
    let uncompressed = 0
    let compressed = 0
    const deflate = createDeflateRaw()
    // A client disconnect surfaces in the pump first; it must fail this call (and wake the producer) rather than
    // becoming an unhandled rejection while the producer still waits on `drain`.
    const failure: { error: Error | null } = { error: null }
    const pump = (async (): Promise<void> => {
      try {
        for await (const chunk of deflate) { const buf = chunk as Buffer; compressed += buf.length; await this.write(buf) }
      } catch (error) {
        failure.error = error as Error
        deflate.destroy(error as Error)
        throw error
      }
    })()
    pump.catch(() => undefined)
    try {
      for await (const chunk of data) {
        if (failure.error) throw failure.error
        const buf = chunk as Buffer
        crc = crc32(buf, crc)
        uncompressed += buf.length
        if (!deflate.write(buf)) await new Promise<void>((resolve) => { const done = (): void => { deflate.off('drain', done); deflate.off('close', done); deflate.off('error', done); resolve() }; deflate.once('drain', done); deflate.once('close', done); deflate.once('error', done) })
      }
      if (failure.error) throw failure.error
      deflate.end()
      await pump
    } catch (error) {
      deflate.destroy()
      if (typeof (data as { destroy?: unknown }).destroy === 'function') (data as { destroy: () => void }).destroy()
      throw error
    }
    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(crc, 4)
    descriptor.writeUInt32LE(compressed, 8)
    descriptor.writeUInt32LE(uncompressed, 12)
    await this.write(descriptor)
    this.entries.push({ name: nameBuf, crc, compressed, uncompressed, offset, time, date })
  }

  async finish(): Promise<void> {
    const start = this.offset
    let size = 0
    for (const e of this.entries) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014b50, 0)
      h.writeUInt16LE(20, 4)
      h.writeUInt16LE(20, 6)
      h.writeUInt16LE(0x0808, 8)
      h.writeUInt16LE(8, 10)
      h.writeUInt16LE(e.time, 12)
      h.writeUInt16LE(e.date, 14)
      h.writeUInt32LE(e.crc, 16)
      h.writeUInt32LE(e.compressed, 20)
      h.writeUInt32LE(e.uncompressed, 24)
      h.writeUInt16LE(e.name.length, 28)
      h.writeUInt16LE(0, 30)
      h.writeUInt16LE(0, 32)
      h.writeUInt16LE(0, 34)
      h.writeUInt16LE(0, 36)
      h.writeUInt32LE(0, 38)
      h.writeUInt32LE(e.offset, 42)
      await this.write(h)
      await this.write(e.name)
      size += h.length + e.name.length
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(this.entries.length, 8)
    end.writeUInt16LE(this.entries.length, 10)
    end.writeUInt32LE(size, 12)
    end.writeUInt32LE(start, 16)
    end.writeUInt16LE(0, 20)
    await this.write(end)
  }
}
