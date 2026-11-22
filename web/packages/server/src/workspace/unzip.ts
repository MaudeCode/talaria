/**
 * Minimal zip reader (central directory; stored and deflate members) for gallery extension installs, archive extraction
 * and Office previews. `read` inflates on the zlib threadpool; `readSync` serves the synchronous Office preview, whose
 * XML parse is synchronous anyway. ZIP64 archives are refused.
 */
import { promisify } from 'node:util'
import { crc32, inflateRaw, inflateRawSync } from 'node:zlib'

const inflateRawAsync = promisify(inflateRaw)

/** `offset` is the member's local header position; two entries with one offset name the same bytes. */
export interface ZipEntry { name: string; size: number; compressedSize: number; offset: number; isDir: boolean; read: () => Promise<Buffer>; readSync: () => Buffer }

export class BadZipError extends Error {}

const ZIP64_COUNT = 0xffff
const ZIP64_32 = 0xffffffff

export function readZip(buf: Buffer): ZipEntry[] {
  const EOCD = 0x06054b50
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i -= 1) if (buf.readUInt32LE(i) === EOCD) { eocd = i; break }
  if (eocd < 0) throw new BadZipError('end of central directory not found')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  if (count === ZIP64_COUNT || offset === ZIP64_32) throw new BadZipError('ZIP64 archives are not supported')
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
    if (compressed === ZIP64_32 || size === ZIP64_32 || localOffset === ZIP64_32) throw new BadZipError('ZIP64 archives are not supported')
    offset += 46 + nameLen + extraLen + commentLen
    const raw = (): Buffer => {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new BadZipError('local header corrupt')
      const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
      if (method !== 0 && method !== 8) throw new BadZipError(`unsupported compression method ${String(method)}`)
      return buf.subarray(start, start + compressed)
    }
    const checked = (out: Buffer): Buffer => {
      if (out.length !== size) throw new BadZipError(`member ${name} is ${String(out.length)} bytes but declares ${String(size)}`)
      if (crc32(out) !== crc) throw new BadZipError(`Bad CRC-32 for file ${name}`)
      return out
    }
    // The declared size is the output cap: a crafted member cannot inflate past what the caller already budgeted.
    const inflateFailed = (error: unknown) => new BadZipError(`member ${name} inflates past its declared size: ${(error as Error).message}`)
    entries.push({
      name, size, compressedSize: compressed, offset: localOffset, isDir: name.endsWith('/'),
      read: async () => {
        const data = raw()
        if (method === 0) return checked(Buffer.from(data))
        try { return checked(await inflateRawAsync(data, { maxOutputLength: Math.max(1, size) })) } catch (error) { throw error instanceof BadZipError ? error : inflateFailed(error) }
      },
      readSync: () => {
        const data = raw()
        if (method === 0) return checked(Buffer.from(data))
        try { return checked(inflateRawSync(data, { maxOutputLength: Math.max(1, size) })) } catch (error) { throw error instanceof BadZipError ? error : inflateFailed(error) }
      },
    })
  }
  return entries
}
