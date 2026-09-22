/** The streaming ZIP writer: a client that disconnects mid-entry fails the entry cleanly instead of crashing or hanging. */
import { Readable, Writable } from 'node:stream'
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
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

  it('writes ZIP64 records for an entry declared over 4 GiB and for more than 65 535 entries, readable by Python zipfile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talaria-zip64-'))
    try {
      // Entry declared with a 4 GiB stat size (the writer trusts the stat like `zipfile.write`), but streamed short.
      const wide = join(dir, 'wide.zip')
      const wideOut = createWriteStream(wide)
      const zip = new ZipWriter(wideOut)
      await zip.addFile('wide.bin', Readable.from([Buffer.from('payload')]), 0x1_0000_0000)
      // Python `zipfile.write` picks ZIP64 from `st_size * 1.05`: a stat just under 4 GiB still gets ZIP64 records so
      // an incompressible body cannot outgrow a ZIP32 header mid-stream.
      await zip.addFile('near.bin', Readable.from([Buffer.from('payload')]), 0xffff_ffff - 1024)
      await zip.addFile('small.txt', Readable.from([Buffer.from('hello')]), 5)
      await zip.finish()
      await new Promise<void>((resolve, reject) => { wideOut.end(); wideOut.on('finish', resolve); wideOut.on('error', reject) })
      // 65 536 empty entries force the ZIP64 end-of-central-directory record.
      const many = join(dir, 'many.zip')
      const manyOut = createWriteStream(many)
      const zip2 = new ZipWriter(manyOut)
      for (let i = 0; i < 65_536; i += 1) await zip2.addFile(`e${String(i)}`, Readable.from([]), 0)
      await zip2.finish()
      await new Promise<void>((resolve, reject) => { manyOut.end(); manyOut.on('finish', resolve); manyOut.on('error', reject) })
      const check = spawnSync('python3', ['-c', `
import sys, zipfile
w = zipfile.ZipFile(sys.argv[1]); assert w.testzip() is None; assert w.read('wide.bin') == b'payload' and w.read('small.txt') == b'hello'
assert w.getinfo('wide.bin').extract_version >= 45, w.getinfo('wide.bin').extract_version; assert w.getinfo('near.bin').extract_version >= 45 and w.read('near.bin') == b'payload'; assert w.getinfo('small.txt').extract_version < 45
m = zipfile.ZipFile(sys.argv[2]); assert len(m.namelist()) == 65536, len(m.namelist()); assert m.testzip() is None
print('ok')`, wide, many], { encoding: 'utf8' })
      expect(check.stdout.trim()).toBe('ok')
      expect(check.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
