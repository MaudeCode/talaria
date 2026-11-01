import { existsSync, readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlobExists, type BlobStore } from './blobs.js'

export interface BlobStoreFixture {
  store: BlobStore
  /** Downloads the store has made so far; a store without a remote never downloads. */
  downloads: () => number
  /** A second store over the same storage whose local cache holds at most `maxBytes`. */
  capped: (maxBytes: number) => Promise<BlobStore>
  /** Whether `localPath` files are a bounded cache that eviction removes. */
  evicts: boolean
  cleanup: () => void | Promise<void>
}

const bytes = (text: string): Buffer => Buffer.from(text)
async function read(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
async function keys(store: BlobStore, prefix: string): Promise<string[]> {
  const found: string[] = []
  for await (const item of store.list(prefix)) found.push(item.key)
  return found.sort()
}

/** Every blob adapter runs these assertions against disposable storage (TAL-1069). */
export function runBlobStoreConformance(name: string, make: () => Promise<BlobStoreFixture>): void {
  describe(`${name} blob store conformance`, () => {
    let f: BlobStoreFixture
    beforeEach(async () => { f = await make() })
    afterEach(async () => { await f.store.close(); await f.cleanup() })

    it('puts, gets, stats, replaces and deletes an object', async () => {
      const key = 'attachments/s1/note.txt'
      expect(await f.store.stat(key)).toBeNull()
      expect(await f.store.get(key)).toBeNull()
      const put = await f.store.put(key, bytes('first'), { contentType: 'text/plain', exclusive: true })
      expect(put.size).toBe(5)
      expect(put.etag).not.toBe('')
      expect(await f.store.stat(key)).toMatchObject({ size: 5, etag: put.etag })
      const got = await f.store.get(key)
      expect(got?.stat).toMatchObject({ size: 5, etag: put.etag })
      expect((await read(got!.body)).toString()).toBe('first')
      await expect(f.store.put(key, bytes('raced'), { exclusive: true })).rejects.toBeInstanceOf(BlobExists)
      expect((await read((await f.store.get(key))!.body)).toString()).toBe('first')
      const replaced = await f.store.put(key, Readable.from([bytes('sec'), bytes('ond!')]))
      expect(replaced.size).toBe(7)
      expect((await f.store.stat(key))?.etag).toBe(replaced.etag)
      expect(replaced.etag).not.toBe(put.etag)
      await f.store.delete(key)
      expect(await f.store.stat(key)).toBeNull()
      expect(await f.store.get(key)).toBeNull()
      await f.store.delete(key)
    })

    it('reads an inclusive byte range and reports the whole object size', async () => {
      const key = 'attachments/s1/range.bin'
      await f.store.put(key, bytes('0123456789'))
      const got = await f.store.get(key, { start: 2, end: 5 })
      expect((await read(got!.body)).toString()).toBe('2345')
      expect(got?.stat.size).toBe(10)
      expect((await read((await f.store.get(key, { start: 9, end: 9 }))!.body)).toString()).toBe('9')
    })

    it('lists and deletes by prefix, leaving other sessions alone', async () => {
      await f.store.put('attachments/s1/a.txt', bytes('a'))
      await f.store.put('attachments/s1/tree/b.txt', bytes('bb'))
      await f.store.put('attachments/s10/c.txt', bytes('c'))
      await f.store.put('attachments/s2/d.txt', bytes('d'))
      expect(await keys(f.store, 'attachments/s1/')).toEqual(['attachments/s1/a.txt', 'attachments/s1/tree/b.txt'])
      expect(await keys(f.store, 'attachments/s1/tree/')).toEqual(['attachments/s1/tree/b.txt'])
      expect(await keys(f.store, 'attachments/')).toEqual(['attachments/s1/a.txt', 'attachments/s1/tree/b.txt', 'attachments/s10/c.txt', 'attachments/s2/d.txt'])
      for await (const item of f.store.list('attachments/s1/tree/')) expect(item).toMatchObject({ size: 2, etag: (await f.store.stat(item.key))?.etag })
      expect(await f.store.deletePrefix('attachments/s1/tree/')).toBe(1)
      expect(await keys(f.store, 'attachments/s1/')).toEqual(['attachments/s1/a.txt'])
      expect(await f.store.deletePrefix('attachments/s1/')).toBe(1)
      expect(await keys(f.store, 'attachments/s1/')).toEqual([])
      expect(await f.store.deletePrefix('attachments/s1/')).toBe(0)
      expect(await keys(f.store, 'attachments/')).toEqual(['attachments/s10/c.txt', 'attachments/s2/d.txt'])
    })

    it('gives a readable local file with identical bytes, and no file for a missing object', async () => {
      // Over the multipart threshold, streamed so nothing is written through to a cache.
      const big = Buffer.alloc(9 * 1024 * 1024 + 17, 7)
      big.write('head', 0)
      big.write('tail', big.length - 4)
      await f.store.put('attachments/s1/big.bin', Readable.from([big.subarray(0, 3_000_000), big.subarray(3_000_000)]))
      const path = await f.store.localPath('attachments/s1/big.bin')
      expect(path.startsWith(f.store.attachmentRoot())).toBe(true)
      expect(readFileSync(path).equals(big)).toBe(true)
      const missing = await f.store.localPath('attachments/s1/missing.txt')
      expect(existsSync(missing)).toBe(false)
    })

    it('shares one download between concurrent localPath calls', async () => {
      await f.store.put('attachments/s1/shared.txt', Readable.from([bytes('shared bytes')]))
      const before = f.downloads()
      const paths = await Promise.all(Array.from({ length: 6 }, () => f.store.localPath('attachments/s1/shared.txt')))
      expect(new Set(paths).size).toBe(1)
      expect(readFileSync(paths[0]!, 'utf8')).toBe('shared bytes')
      expect(f.downloads() - before).toBeLessThanOrEqual(1)
      await f.store.localPath('attachments/s1/shared.txt')
      expect(f.downloads() - before).toBeLessThanOrEqual(1)
    })

    it('keeps its local cache under the cap, newest first', async () => {
      const capped = await f.capped(1000)
      try {
        const names = ['one', 'two', 'three']
        for (const n of names) await capped.put(`attachments/s1/${n}.bin`, Readable.from([Buffer.alloc(400, n.charCodeAt(0))]))
        const paths: string[] = []
        for (const n of names) paths.push(await capped.localPath(`attachments/s1/${n}.bin`))
        expect(readFileSync(paths[2]!).equals(Buffer.alloc(400, 't'.charCodeAt(0)))).toBe(true)
        expect(existsSync(paths[1]!)).toBe(true)
        // Three 400-byte files exceed 1000 bytes: a cache drops the least recently used; a directory keeps everything.
        expect(existsSync(paths[0]!)).toBe(!f.evicts)
        // An evicted object comes back on its next use.
        expect(readFileSync(await capped.localPath('attachments/s1/one.bin')).equals(Buffer.alloc(400, 'o'.charCodeAt(0)))).toBe(true)
      } finally { await capped.close() }
    })

    it('stores, lists and materializes unicode names', async () => {
      const key = 'attachments/s1/résumé 日本語/Ünïcødé файл.txt'
      await f.store.put(key, bytes('unicode'), { exclusive: true })
      expect(await keys(f.store, 'attachments/s1/')).toEqual([key])
      expect((await f.store.stat(key))?.size).toBe(7)
      expect(readFileSync(await f.store.localPath(key), 'utf8')).toBe('unicode')
      expect(await f.store.deletePrefix('attachments/s1/')).toBe(1)
    })

    it('refuses keys that could leave the attachment namespace', async () => {
      for (const key of ['attachments/../x', 'other/s1/x', 'attachments/s1/../../x', 'attachments/s1//x', 'attachments/s1']) {
        await expect(f.store.put(key, bytes('x'))).rejects.toThrow(/Invalid blob key/)
      }
      await expect(f.store.deletePrefix('attachments/')).rejects.toThrow(/session prefix/)
    })
  })
}
