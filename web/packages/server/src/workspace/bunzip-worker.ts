/**
 * TAL-1699: decodes one bzip2 stream for `extract.ts` off the server's event loop. `seek-bzip` is pure JS and emits a
 * byte at a time, so a large archive is seconds of CPU; the decode stops once the output would pass `limit`.
 */
import { parentPort, workerData } from 'node:worker_threads'
import Bunzip from 'seek-bzip'

export interface BunzipJob { bytes: Uint8Array; limit: number }
export type BunzipReply = { ok: true; data: Uint8Array } | { ok: false; reason: 'too_large' | 'corrupt' }

class TooLarge extends Error {}

const { bytes, limit } = workerData as BunzipJob
let out = Buffer.allocUnsafeSlow(Math.min(64 * 1024, limit))
let pos = 0
const sink = {
  writeByte(byte: number): void {
    if (pos >= limit) throw new TooLarge()
    if (pos === out.length) {
      const grown = Buffer.allocUnsafeSlow(Math.min(out.length * 2, limit))
      out.copy(grown)
      out = grown
    }
    out[pos++] = byte
  },
}
let reply: BunzipReply
try {
  Bunzip.decode(bytes, sink, true)
  reply = { ok: true, data: out.subarray(0, pos) }
} catch (error) {
  reply = { ok: false, reason: error instanceof TooLarge ? 'too_large' : 'corrupt' }
}
parentPort?.postMessage(reply, reply.ok ? [out.buffer] : [])
