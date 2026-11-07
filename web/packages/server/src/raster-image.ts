import { crc32 } from 'node:zlib'

/**
 * Python `_is_native_raster_data_uri`: whether a value is one complete, canonical raster image data URI. Image bytes are
 * opaque, so text redaction would only corrupt them; but this is a credential boundary, so a header or magic prefix is
 * not enough. The whole canonical base64 payload is decoded and the image format must account for every byte, a JPEG's
 * through its declared MPF pictures and one Samsung SEF trailer; any malformed, ambiguous, or trailing content falls
 * through to normal redaction.
 *
 * The verdict depends only on the string, so each session read reuses it instead of paying for the decode again.
 */
export function isRasterDataUri(value: unknown): boolean {
  if (typeof value !== 'string') return false
  // Scheme and MIME type are case-insensitive; only the short header is lowered, never the payload.
  const match = RASTER_PREFIXES.find(([prefix]) => value.slice(0, prefix.length).toLowerCase() === prefix)
  if (!match) return false
  const payload = value.slice(match[0].length)
  if (!payload) return false
  const memoized = verdicts.get(value)
  if (memoized !== undefined) {
    verdicts.delete(value)
    verdicts.set(value, memoized)
    return memoized
  }
  const raw = Buffer.from(payload, 'base64')
  // `Buffer.from` skips foreign characters and tolerates missing padding; the round trip accepts only canonical base64.
  const verdict = raw.toString('base64') === payload && match[1](raw)
  rememberVerdict(value, verdict)
  return verdict
}

/** Least recently used first. The keys are whole images, so the entry cap alone could pin gigabytes of evicted sessions. */
const verdicts = new Map<string, boolean>()
const VERDICTS_MAX = 256
const VERDICTS_MAX_CHARS = 256 * 1024 * 1024
let verdictChars = 0

function rememberVerdict(value: string, verdict: boolean): void {
  if (value.length > VERDICTS_MAX_CHARS) return
  while (verdicts.size >= VERDICTS_MAX || verdictChars + value.length > VERDICTS_MAX_CHARS) {
    const oldest = verdicts.keys().next()
    if (oldest.done) break
    verdictChars -= oldest.value.length
    verdicts.delete(oldest.value)
  }
  verdicts.set(value, verdict)
  verdictChars += value.length
}

function isCompletePng(raw: Buffer): boolean {
  if (raw.length < 8 || !raw.subarray(0, 8).equals(PNG_SIGNATURE)) return false
  let pos = 8
  let index = 0
  let sawIdat = false
  while (pos < raw.length) {
    if (pos + 12 > raw.length) return false
    const length = raw.readUInt32BE(pos)
    const type = raw.subarray(pos + 4, pos + 8)
    const dataStart = pos + 8
    const dataEnd = dataStart + length
    const chunkEnd = dataEnd + 4
    if (chunkEnd > raw.length) return false
    if (!type.every((b) => (b >= 65 && b <= 90) || (b >= 97 && b <= 122))) return false
    // The PNG reserved bit must be zero.
    if (type[2]! < 65 || type[2]! > 90) return false
    if (crc32(raw.subarray(pos + 4, dataEnd)) !== raw.readUInt32BE(dataEnd)) return false
    const name = type.toString('latin1')
    if (index === 0) {
      if (name !== 'IHDR' || length !== 13) return false
      const depth = raw[dataStart + 8]!
      const depths = PNG_DEPTHS[raw[dataStart + 9]!]
      if (!raw.readUInt32BE(dataStart) || !raw.readUInt32BE(dataStart + 4) || !depths?.includes(depth) || raw[dataStart + 10] !== 0 || raw[dataStart + 11] !== 0 || raw[dataStart + 12]! > 1) return false
    } else if (name === 'IHDR') return false
    if (name === 'IDAT') sawIdat = true
    if (name === 'IEND') return length === 0 && sawIdat && chunkEnd === raw.length
    pos = chunkEnd
    index += 1
  }
  return false
}

/** The picture extents an MP Index TIFF declares, its offsets relative to `base`; undefined when it is malformed. */
function mpfImageRanges(tiff: Buffer, base: number): [start: number, end: number][] | undefined {
  if (tiff.length < 8) return undefined
  const signature = tiff.readUInt32BE(0)
  if (signature !== 0x49492a00 && signature !== 0x4d4d002a) return undefined
  const u16 = (pos: number): number => (signature === 0x49492a00 ? tiff.readUInt16LE(pos) : tiff.readUInt16BE(pos))
  const u32 = (pos: number): number => (signature === 0x49492a00 ? tiff.readUInt32LE(pos) : tiff.readUInt32BE(pos))
  const ifd = u32(4)
  if (ifd < 8 || ifd + 2 > tiff.length) return undefined
  const tableEnd = ifd + 2 + 12 * u16(ifd)
  if (tableEnd + 4 > tiff.length) return undefined
  const tags = new Map<number, { type: number; count: number; value: number }>()
  for (let pos = ifd + 2; pos < tableEnd; pos += 12) {
    if (tags.has(u16(pos))) return undefined
    tags.set(u16(pos), { type: u16(pos + 2), count: u32(pos + 4), value: u32(pos + 8) })
  }
  const imageCount = tags.get(0xb001)
  const directory = tags.get(0xb002)
  if (imageCount?.type !== 4 || imageCount.count !== 1 || imageCount.value < 2) return undefined
  const images = imageCount.value
  if (directory?.type !== 7 || directory.count !== 16 * images) return undefined
  if (directory.value < tableEnd + 4 || directory.value + 16 * images > tiff.length) return undefined
  const ranges: [number, number][] = []
  for (let index = 0; index < images; index += 1) {
    const pos = directory.value + index * 16
    const size = u32(pos + 4)
    const relative = u32(pos + 8)
    if (u32(pos) & 0x07000000 || size < 4 || (index === 0 && relative !== 0)) return undefined
    const start = index === 0 ? 0 : base + relative
    ranges.push([start, start + size])
  }
  return ranges
}

/**
 * Whether `data` is exactly one Samsung Extended Format trailer: data blocks, an `SEFH` directory, then the directory's
 * length and `SEFT`. A directory entry is `u16 0, u16 kind, u32 offset back from SEFH, u32 size`; a block starts
 * `u16 0, u16 kind, u32 name length, name`. The blocks must tile everything before `SEFH`.
 *
 * Session reads run this every time, so the tiling is proven from the directory before any block is read: entries that
 * all point at one huge block are rejected without scanning it, and no block byte is read twice.
 */
function isSamsungSefTrailer(data: Buffer): boolean {
  if (data.length < 20 || data.readUInt32LE(data.length - 4) !== SEFT) return false
  const directoryLength = data.readUInt32LE(data.length - 8)
  const directory = data.length - 8 - directoryLength
  if (directoryLength < 24 || directory <= 0 || data.readUInt32LE(directory) !== SEFH) return false
  const count = data.readUInt32LE(directory + 8)
  if (count < 1 || count > SEF_MAX_ENTRIES || directoryLength !== 12 + 12 * count) return false
  const blocks: { start: number; size: number; kind: number }[] = []
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 12 + 12 * index
    const offset = data.readUInt32LE(entry + 4)
    const size = data.readUInt32LE(entry + 8)
    const start = directory - offset
    if (data.readUInt16LE(entry) !== 0 || offset > directory || size < 8 || start + size > directory) return false
    blocks.push({ start, size, kind: data.readUInt16LE(entry + 2) })
  }
  let end = 0
  for (const { start, size } of [...blocks].sort((a, b) => a.start - b.start)) {
    if (start !== end) return false
    end = start + size
  }
  if (end !== directory) return false
  return blocks.every(({ start, size, kind }) => {
    if (data.readUInt16LE(start) !== 0 || data.readUInt16LE(start + 2) !== kind) return false
    const nameEnd = start + 8 + data.readUInt32LE(start + 4)
    return nameEnd <= start + size && SEF_BLOCK_NAME.test(data.toString('latin1', start + 8, nameEnd))
  })
}

function isCompleteJpeg(raw: Buffer, isSubPicture = false): boolean {
  if (raw.length < 4 || raw[0] !== 0xff || raw[1] !== 0xd8) return false
  let pos = 2
  let sawSof = false
  let sawScan = false
  let mpfRanges: [start: number, end: number][] | undefined
  while (pos < raw.length) {
    if (raw[pos] !== 0xff) return false
    while (pos < raw.length && raw[pos] === 0xff) pos += 1
    if (pos >= raw.length) return false
    const marker = raw[pos]!
    pos += 1
    if (marker === 0xd9) {
      if (!sawSof || !sawScan) return false
      if (!mpfRanges) return pos === raw.length || (!isSubPicture && isSamsungSefTrailer(raw.subarray(pos)))
      if (mpfRanges[0]![1] !== pos) return false
      // Only the declared extents are trusted: no gaps, overlaps, undeclared pictures or other post-EOI payloads.
      for (const [start, end] of mpfRanges.slice(1)) {
        if (start !== pos || end > raw.length || !isCompleteJpeg(raw.subarray(start, end), true)) return false
        pos = end
      }
      return pos === raw.length || isSamsungSefTrailer(raw.subarray(pos))
    }
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return false
    if (pos + 2 > raw.length) return false
    const segmentLength = raw.readUInt16BE(pos)
    if (segmentLength < 2) return false
    const segmentEnd = pos + segmentLength
    if (segmentEnd > raw.length) return false
    if (!isSubPicture && marker === 0xe2 && segmentLength >= 6 && raw.readUInt32BE(pos + 2) === MPF_SIGNATURE) {
      if (mpfRanges) return false
      mpfRanges = mpfImageRanges(raw.subarray(pos + 6, segmentEnd), pos + 6)
      if (!mpfRanges) return false
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) return false
      sawSof = true
    }
    pos = segmentEnd
    if (marker !== 0xda) continue
    // Entropy-coded scan data: skip to the next marker that is neither a stuffed zero nor a restart marker.
    sawScan = true
    let next = -1
    while (pos < raw.length) {
      if (raw[pos] !== 0xff) { pos += 1; continue }
      const markerStart = pos
      while (pos < raw.length && raw[pos] === 0xff) pos += 1
      if (pos >= raw.length) return false
      const scanMarker = raw[pos]!
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) { pos += 1; continue }
      next = markerStart
      break
    }
    if (next < 0) return false
    pos = next
  }
  return false
}

/** The offset after a GIF data sub-block chain's terminator, or -1 when it runs past the end. */
function gifSubblocksEnd(raw: Buffer, start: number): number {
  let pos = start
  while (pos < raw.length) {
    const size = raw[pos]!
    pos += 1
    if (size === 0) return pos
    if (pos + size > raw.length) return -1
    pos += size
  }
  return -1
}

function isCompleteGif(raw: Buffer): boolean {
  if (raw.length < 14 || !['GIF87a', 'GIF89a'].includes(raw.toString('latin1', 0, 6))) return false
  if (!raw.readUInt16LE(6) || !raw.readUInt16LE(8)) return false
  const packed = raw[10]!
  let pos = 13
  if (packed & 0x80) pos += 3 * (1 << ((packed & 0x07) + 1))
  if (pos > raw.length) return false
  let sawImage = false
  while (pos < raw.length) {
    const introducer = raw[pos]!
    pos += 1
    if (introducer === 0x3b) return sawImage && pos === raw.length
    if (introducer === 0x21) {
      if (pos >= raw.length) return false
      pos = gifSubblocksEnd(raw, pos + 1)
      if (pos < 0) return false
      continue
    }
    if (introducer !== 0x2c || pos + 9 > raw.length) return false
    if (!raw.readUInt16LE(pos + 4) || !raw.readUInt16LE(pos + 6)) return false
    const imagePacked = raw[pos + 8]!
    pos += 9
    if (imagePacked & 0x80) pos += 3 * (1 << ((imagePacked & 0x07) + 1))
    if (pos >= raw.length) return false
    const lzwMinimumCodeSize = raw[pos]!
    if (lzwMinimumCodeSize < 2 || lzwMinimumCodeSize > 11) return false
    pos = gifSubblocksEnd(raw, pos + 1)
    if (pos < 0) return false
    sawImage = true
  }
  return false
}

function isWebpImageChunk(type: string, data: Buffer): boolean {
  if (type === 'VP8 ') return data.length >= 10 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a && Boolean(data.readUInt16LE(6) & 0x3fff) && Boolean(data.readUInt16LE(8) & 0x3fff)
  // The three high bits of the fifth byte are the version number; the lossless bitstream defines only version zero.
  if (type === 'VP8L') return data.length >= 5 && data[0] === 0x2f && !(data[4]! & 0xe0)
  return false
}

/**
 * Walk RIFF chunks from `start` to the end of `data`, requiring exactly one image. `chunk` checks every other chunk:
 * true accepts it, `'image'` counts it as the image, false rejects the file.
 */
function webpChunksComplete(data: Buffer, start: number, chunk: (type: string, body: Buffer) => boolean | 'image'): boolean {
  let pos = start
  let sawImage = false
  while (pos < data.length) {
    if (pos + 8 > data.length) return false
    const type = data.toString('latin1', pos, pos + 4)
    const size = data.readUInt32LE(pos + 4)
    const dataStart = pos + 8
    const dataEnd = dataStart + size
    const chunkEnd = dataEnd + (size & 1)
    if (chunkEnd > data.length) return false
    const body = data.subarray(dataStart, dataEnd)
    if (type === 'VP8 ' || type === 'VP8L') {
      if (sawImage || !isWebpImageChunk(type, body)) return false
      sawImage = true
    } else {
      const verdict = chunk(type, body)
      if (!verdict) return false
      if (verdict === 'image') sawImage = true
    }
    pos = chunkEnd
  }
  return sawImage && pos === data.length
}

function isCompleteWebp(raw: Buffer): boolean {
  if (raw.length < 20 || raw.toString('latin1', 0, 4) !== 'RIFF' || raw.toString('latin1', 8, 12) !== 'WEBP' || raw.readUInt32LE(4) + 8 !== raw.length) return false
  return webpChunksComplete(raw, 12, (type, body) => {
    if (type === 'VP8X') return body.length === 10 && !(body[0]! & 0x81) && !body[1] && !body[2] && !body[3]
    // One extended-WebP animation frame: its nested chunks are an optional alpha plane and exactly one image.
    if (type === 'ANMF') return body.length >= 16 && !(body[15]! & 0xfc) && webpChunksComplete(body, 16, (inner) => inner === 'ALPH') ? 'image' : false
    return true
  })
}

function isCompleteBmp(raw: Buffer): boolean {
  if (raw.length < 26 || raw.toString('latin1', 0, 2) !== 'BM' || raw.readUInt32LE(2) !== raw.length) return false
  const pixelOffset = raw.readUInt32LE(10)
  const dibSize = raw.readUInt32LE(14)
  let width: number, height: number, planes: number, bitsPerPixel: number
  if (dibSize === 12) [width, height, planes, bitsPerPixel] = [raw.readUInt16LE(18), raw.readUInt16LE(20), raw.readUInt16LE(22), raw.readUInt16LE(24)]
  else if (dibSize >= 40 && 14 + dibSize <= raw.length) [width, height, planes, bitsPerPixel] = [raw.readInt32LE(18), raw.readInt32LE(22), raw.readUInt16LE(26), raw.readUInt16LE(28)]
  else return false
  return Boolean(width) && Boolean(height) && planes === 1 && [1, 2, 4, 8, 16, 24, 32].includes(bitsPerPixel) && 14 + dibSize <= pixelOffset && pixelOffset < raw.length
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
const MPF_SIGNATURE = 0x4d504600 // `MPF\0`
const SEFH = 0x48464553 // `SEFH`, little-endian
const SEFT = 0x54464553 // `SEFT`, little-endian
const SEF_MAX_ENTRIES = 64
const SEF_BLOCK_NAME = /^[\x21-\x7e]+$/
const RASTER_PREFIXES: [string, (raw: Buffer) => boolean][] = [
  ['data:image/png;base64,', isCompletePng],
  ['data:image/jpeg;base64,', isCompleteJpeg],
  ['data:image/jpg;base64,', isCompleteJpeg],
  ['data:image/gif;base64,', isCompleteGif],
  ['data:image/webp;base64,', isCompleteWebp],
  ['data:image/bmp;base64,', isCompleteBmp],
]
