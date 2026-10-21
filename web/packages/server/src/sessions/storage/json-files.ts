import { chmodSync, closeSync, fstatSync, fsyncSync, openSync, renameSync, unlinkSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { writeFully } from '../../fs/atomic.js'
import { signatureOf } from '../../fs/stat.js'
let tmpCounter = 0

function tmpName(path: string): string {
  return `${path}.tmp.${process.pid}.${++tmpCounter}`
}

export function writeAtomic(path: string, text: string | Uint8Array, mode?: number): void {
  const tmp = tmpName(path)
  const fd = openSync(tmp, 'w', mode)
  try {
    writeFully(fd, text)
    fsyncSync(fd)
    closeSync(fd)
    if (mode !== undefined) chmodSync(tmp, mode)
    renameSync(tmp, path)
  } catch (error) {
    try { closeSync(fd) } catch { /* closed */ }
    try { unlinkSync(tmp) } catch { /* gone */ }
    throw error
  }
}

export { statSignature, statSignatureAsync } from '../../fs/stat.js'
/**
 * The metadata prefix together with the signature of the inode it was read from (fstat of the open descriptor), so a
 * file atomically replaced during the read is never cached under the replacement's identity.
 */
export function readMetadataJsonPrefixWithSignature(path: string, maxBytes = 1024 * 1024): { prefix: string | null; signature: string } {
  const fd = openSync(path, 'r')
  try {
    const signature = signatureOf(path, fstatSync(fd, { bigint: true }))
    return { prefix: readPrefixFromFd(fd, maxBytes, Math.min(64 * 1024, maxBytes)), signature }
  } finally {
    closeSync(fd)
  }
}

function readPrefixFromFd(fd: number, maxBytes: number, initialStage: number): string | null {
  let stage = initialStage
  {
    let raw = Buffer.alloc(0)
    let text = ''
    let stopPos: number | null = null
    while (raw.length < maxBytes) {
      const chunk = Buffer.alloc(Math.min(stage, maxBytes - raw.length))
      const n = readSyncFully(fd, chunk)
      if (n === 0) return null
      raw = Buffer.concat([raw, chunk.subarray(0, n)])
      text = raw.toString('utf8')
      const messagesPos = findTopLevelJsonKey(text, 'messages')
      const scenesPos = findTopLevelJsonKey(text, 'anchor_activity_scenes')
      stopPos = messagesPos
      if (scenesPos !== null && (stopPos === null || scenesPos < stopPos)) stopPos = scenesPos
      if (stopPos !== null) break
      stage *= 2
    }
    if (stopPos === null) return null
    let prefix = text.slice(0, stopPos).trimEnd()
    if (prefix.endsWith(',')) prefix = prefix.slice(0, -1).trimEnd()
    return `${prefix}\n}`
  }
}

/**
 * TAL-1212: the first `limit` rows of a session document's top-level `messages` array and the signature of the inode they
 * were read from. Reads the descriptor incrementally and parses only those rows; a document the scan cannot follow (no
 * `messages` array, a non-object row, a truncated file) falls back to one full parse of the same descriptor.
 */
export async function readJsonMessagePrefix(path: string, limit: number, chunkBytes = 64 * 1024): Promise<{ rows: unknown[]; signature: string }> {
  const handle = await open(path, 'r')
  try {
    const signature = signatureOf(path, await handle.stat({ bigint: true }))
    const decoder = new StringDecoder('utf8')
    let chunk = Buffer.alloc(chunkBytes)
    const scan = messagePrefixScanner(limit)
    let text = ''
    let rows: unknown[] | null | undefined
    let eof = false
    while (!eof) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      eof = bytesRead === 0
      text += eof ? decoder.end() : decoder.write(chunk.subarray(0, bytesRead))
      if (rows === undefined) rows = scan(text)
      if (rows) return { rows, signature }
      // Doubling keeps re-flattening the growing text linear in the bytes read.
      if (!eof && chunk.length < 16 * 1024 * 1024) chunk = Buffer.alloc(chunk.length * 2)
    }
    const doc = JSON.parse(text) as { messages?: unknown } | null
    return { rows: Array.isArray(doc?.messages) ? doc.messages.slice(0, limit) : [], signature }
  } finally {
    await handle.close()
  }
}

/**
 * Feed the growing document text; returns the parsed rows once `limit` rows or the array's end are scanned, null when
 * the document needs a full parse, and undefined while more text is needed.
 */
function messagePrefixScanner(limit: number): (text: string) => unknown[] | null | undefined {
  const rows: unknown[] = []
  let phase: 'key' | 'value' | 'array' = 'key'
  let i = 0
  let depth = 0
  let inString = false
  let escape = false
  let stringStart = 0
  let key: string | null = null
  let rowStart: number | null = null
  return (text) => {
    for (; i < text.length; i += 1) {
      const ch = text[i]!
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') {
          inString = false
          if (phase === 'key' && depth === 1) key = text.slice(stringStart + 1, i)
        }
        continue
      }
      const space = ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t'
      if (phase === 'value') {
        if (space) continue
        if (ch !== '[') return null
        phase = 'array'
        depth = 2
        continue
      }
      if (phase === 'array' && rowStart === null) {
        if (space || ch === ',') continue
        if (ch === ']') return rows
        if (ch !== '{') return null
        rowStart = i
      }
      if (ch === '"') { inString = true; stringStart = i; continue }
      if (ch === '{' || ch === '[') depth += 1
      else if (ch === '}' || ch === ']') {
        depth -= 1
        if (phase === 'array' && depth === 2) {
          rows.push(JSON.parse(text.slice(rowStart!, i + 1)))
          rowStart = null
          if (rows.length >= limit) return rows
        }
        continue
      }
      if (phase === 'key' && depth === 1 && !space) {
        if (ch === ':' && key === 'messages') phase = 'value'
        else key = null
      }
    }
    return undefined
  }
}

import { readSync } from 'node:fs'
function readSyncFully(fd: number, buf: Buffer): number {
  let total = 0
  while (total < buf.length) {
    const n = readSync(fd, buf, total, buf.length - total, null)
    if (n === 0) break
    total += n
  }
  return total
}

/** Offset of `"key":` at JSON nesting depth 1, or null. */
export function findTopLevelJsonKey(text: string, key: string): number | null {
  let depth = 0
  let inString = false
  let escape = false
  let stringStart = -1
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') {
        inString = false
        if (depth === 1 && text.slice(stringStart + 1, i) === key) {
          let j = i + 1
          while (j < text.length && /\s/.test(text[j] ?? '')) j += 1
          if (text[j] === ':') return stringStart
        }
      }
      continue
    }
    if (ch === '"') { inString = true; stringStart = i; continue }
    if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') depth -= 1
  }
  return null
}
