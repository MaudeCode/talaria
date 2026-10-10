import { crc32 } from 'node:zlib'

/**
 * Python `_is_native_raster_data_uri`: whether a value is one complete, canonical raster image data URI. Image bytes are
 * opaque, so text redaction would only corrupt them; but this is a credential boundary, so a header or magic prefix is
 * not enough. The whole canonical base64 payload is decoded and the image format must end exactly at its last byte; any
 * malformed, ambiguous, or trailing content falls through to normal redaction.
 */
export function isRasterDataUri(value: unknown): boolean {
  if (typeof value !== 'string') return false
  // Scheme and MIME type are case-insensitive; only the short header is lowered, never the payload.
  const match = RASTER_PREFIXES.find(([prefix]) => value.slice(0, prefix.length).toLowerCase() === prefix)
  if (!match) return false
  const payload = value.slice(match[0].length)
  if (!payload) return false
  const raw = Buffer.from(payload, 'base64')
  // `Buffer.from` skips foreign characters and tolerates missing padding; the round trip accepts only canonical base64.
  if (raw.toString('base64') !== payload) return false
  return match[1](raw)
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

function isCompleteJpeg(raw: Buffer): boolean {
  if (raw.length < 4 || raw[0] !== 0xff || raw[1] !== 0xd8) return false
  let pos = 2
  let sawSof = false
  let sawScan = false
  while (pos < raw.length) {
    if (raw[pos] !== 0xff) return false
    while (pos < raw.length && raw[pos] === 0xff) pos += 1
    if (pos >= raw.length) return false
    const marker = raw[pos]!
    pos += 1
    if (marker === 0xd9) return sawSof && sawScan && pos === raw.length
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return false
    if (pos + 2 > raw.length) return false
    const segmentLength = raw.readUInt16BE(pos)
    if (segmentLength < 2) return false
    const segmentEnd = pos + segmentLength
    if (segmentEnd > raw.length) return false
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
const RASTER_PREFIXES: [string, (raw: Buffer) => boolean][] = [
  ['data:image/png;base64,', isCompletePng],
  ['data:image/jpeg;base64,', isCompleteJpeg],
  ['data:image/jpg;base64,', isCompleteJpeg],
  ['data:image/gif;base64,', isCompleteGif],
  ['data:image/webp;base64,', isCompleteWebp],
  ['data:image/bmp;base64,', isCompleteBmp],
]
