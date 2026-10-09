/** Minimal zip reader (central directory; stored and deflate members) for gallery extension installs. */
import { crc32, inflateRawSync } from 'node:zlib'

export interface ZipEntry { name: string; size: number; isDir: boolean; read: () => Buffer }

export class BadZipError extends Error {}

export function readZip(buf: Buffer): ZipEntry[] {
  const EOCD = 0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i -= 1) if (buf.readUInt32LE(i) === EOCD) { eocd = i; break }
  if (eocd < 0) throw new BadZipError('end of central directory not found')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) throw new BadZipError('central directory corrupt')
    const method = buf.readUInt16LE(offset + 10)
    const crc = buf.readUInt32LE(offset + 16)
    const compressed = buf.readUInt32LE(offset + 20)
    const size = buf.readUInt32LE(offset + 24)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    offset += 46 + nameLen + extraLen + commentLen
    entries.push({
      name, size, isDir: name.endsWith('/'),
      read: () => {
        if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new BadZipError('local header corrupt')
        const lnameLen = buf.readUInt16LE(localOffset + 26)
        const lextraLen = buf.readUInt16LE(localOffset + 28)
        const start = localOffset + 30 + lnameLen + lextraLen
        const raw = buf.subarray(start, start + compressed)
        let out: Buffer
        if (method === 0) out = Buffer.from(raw)
        else if (method === 8) {
          // The declared size is the output cap: a crafted member cannot inflate past what the caller already budgeted.
          try { out = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }) } catch (error) { throw new BadZipError(`member ${name} inflates past its declared size: ${(error as Error).message}`) }
        } else throw new BadZipError(`unsupported compression method ${String(method)}`)
        if (out.length !== size) throw new BadZipError(`member ${name} is ${String(out.length)} bytes but declares ${String(size)}`)
        if (crc32(out) !== crc) throw new BadZipError(`Bad CRC-32 for file ${name}`)
        return out
      },
    })
  }
  return entries
}
