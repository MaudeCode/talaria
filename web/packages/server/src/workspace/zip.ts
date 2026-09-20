/** Minimal ZIP writer (deflate, zip64-free) for `/api/folder/download`; entries are streamed one file at a time. */
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface Entry { name: Buffer; crc: number; compressed: number; uncompressed: number; offset: number; time: number; date: number }

function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return [time, date]
}

export class ZipWriter {
  private readonly entries: Entry[] = []
  private offset = 0

  constructor(private readonly write: (chunk: Buffer) => void, private readonly now = new Date()) {}

  addFile(name: string, data: Buffer): void {
    const nameBuf = Buffer.from(name.split('\\').join('/'), 'utf8')
    const compressed = deflateRawSync(data)
    const [time, date] = dosTime(this.now)
    const crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6) // UTF-8 names
    header.writeUInt16LE(8, 8) // deflate
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28)
    this.entries.push({ name: nameBuf, crc, compressed: compressed.length, uncompressed: data.length, offset: this.offset, time, date })
    for (const chunk of [header, nameBuf, compressed]) {
      this.write(chunk)
      this.offset += chunk.length
    }
  }

  finish(): void {
    const start = this.offset
    let size = 0
    for (const e of this.entries) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014b50, 0)
      h.writeUInt16LE(20, 4)
      h.writeUInt16LE(20, 6)
      h.writeUInt16LE(0x0800, 8)
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
      this.write(h)
      this.write(e.name)
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
    this.write(end)
  }
}
