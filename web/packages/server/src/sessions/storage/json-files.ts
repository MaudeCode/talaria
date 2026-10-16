import { closeSync, fstatSync, fsyncSync, openSync, renameSync, unlinkSync } from 'node:fs'
import { writeFully } from '../../fs/atomic.js'
let tmpCounter = 0

function tmpName(path: string): string {
  return `${path}.tmp.${process.pid}.${++tmpCounter}`
}

export function writeAtomic(path: string, text: string): void {
  const tmp = tmpName(path)
  const fd = openSync(tmp, 'w')
  try {
    writeFully(fd, text)
    fsyncSync(fd)
    closeSync(fd)
    renameSync(tmp, path)
  } catch (error) {
    try { closeSync(fd) } catch { /* closed */ }
    try { unlinkSync(tmp) } catch { /* gone */ }
    throw error
  }
}

export { statSignature } from '../../fs/stat.js'
/**
 * The metadata prefix together with the signature of the inode it was read from (fstat of the open descriptor), so a
 * file atomically replaced during the read is never cached under the replacement's identity.
 */
export function readMetadataJsonPrefixWithSignature(path: string, maxBytes = 1024 * 1024): { prefix: string | null; signature: string } {
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd, { bigint: true })
    const signature = `${path}:${st.mtimeNs}:${st.size}:${st.ctimeNs}`
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
