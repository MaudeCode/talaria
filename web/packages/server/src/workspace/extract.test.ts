/** TAL-1699: archive extraction yields the event loop between members and decodes bzip2 off the loop, with unchanged output. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { loopTurnsDuring } from '../test/sync-fs.js'
import { CorruptArchive, extractArchive } from './extract.js'
import { ZipWriter } from './zip.js'

const CAP = 200 * 1024 * 1024

async function zipOf(members: [string, Buffer][]): Promise<Buffer> {
  const chunks: Buffer[] = []
  const zip = new ZipWriter(new Writable({ write(chunk: Buffer, _enc, cb) { chunks.push(chunk); cb() } }))
  for (const [name, data] of members) await zip.addFile(name, Readable.from([data]), data.length)
  await zip.finish()
  return Buffer.concat(chunks)
}

function tarOf(members: [string, Buffer][]): Buffer {
  const parts: Buffer[] = []
  for (const [name, data] of members) {
    const h = Buffer.alloc(512)
    h.write(name, 0, 100, 'utf8')
    h.write('0000644\0', 100)
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    h.write('        ', 148)
    h.write('0', 156)
    h.write('ustar\0', 257)
    let sum = 0
    for (const byte of h) sum += byte
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

describe('extractArchive off the event loop', () => {
  const dirs: string[] = []
  const tmp = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-extract-'))); dirs.push(dir); return dir }
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('yields between the members of a 2,000-member zip and writes every member byte-for-byte', async () => {
    const members = Array.from({ length: 2000 }, (_, i): [string, Buffer] => [`d${String(i % 20)}/f${String(i)}.txt`, Buffer.from(`member ${String(i)}\n`.repeat(i % 7))])
    const bytes = await zipOf(members)
    const root = tmp()
    const { value, turns } = await loopTurnsDuring(() => extractArchive(bytes, 'many.zip', root, root, CAP))
    expect(turns).toBeGreaterThan(100)
    expect(value.extracted).toBe(2000)
    expect(value.files).toEqual(members.map(([name]) => join('many', name)))
    for (const [name, data] of members) expect(readFileSync(join(root, 'many', name))).toEqual(data)
  })

  it('decodes a bzip2 tarball off the loop with identical output, and a malformed bzip2 stream stays a CorruptArchive', async () => {
    const members: [string, Buffer][] = [['docs/readme.txt', Buffer.from('hello from bzip2')], ['data.bin', Buffer.alloc(256 * 1024, 7)]]
    const out = spawnSync('bzip2', ['-c'], { input: tarOf(members) })
    expect(out.status, out.stderr.toString()).toBe(0)
    const root = tmp()
    const { value, turns } = await loopTurnsDuring(() => extractArchive(out.stdout, 'bundle.tar.bz2', root, root, CAP))
    expect(turns).toBeGreaterThan(0)
    expect(value.files).toEqual(['bundle.tar/docs/readme.txt', 'bundle.tar/data.bin'])
    for (const [name, data] of members) expect(readFileSync(join(root, 'bundle.tar', name))).toEqual(data)
    await expect(extractArchive(Buffer.concat([Buffer.from('BZh9'), Buffer.alloc(64, 0x55)]), 'bad.tar.bz2', root, root, CAP)).rejects.toThrow(CorruptArchive)
  })
})
