/** Public share snapshots embed only images read through the anchored walk from an allowed root. */
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Session } from './session.js'
import { buildShareSnapshot, embedShareMedia } from './shares.js'

/** One-shot hook: right after `fstatSync` samples the armed file's inode, append `bytes` to that same file. */
const grow = vi.hoisted(() => ({ path: '', ino: 0, bytes: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
    const st = fs.fstatSync(...args)
    if (grow.path && st?.ino === grow.ino) {
      fs.appendFileSync(grow.path, Buffer.alloc(grow.bytes, 0))
      grow.path = ''
    }
    return st
  }) as typeof fs.fstatSync
  return { ...fs, fstatSync }
})

const SHARE_EMBED_MAX_BYTES = 512 * 1024

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)])

describe('embedShareMedia', () => {
  let root = ''
  let outside = ''
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'share-root-')))
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'share-outside-')))
    writeFileSync(join(root, 'inside.png'), png)
    writeFileSync(join(outside, 'private.png'), png)
    symlinkSync(join(outside, 'private.png'), join(root, 'leaf-link.png'))
    mkdirSync(join(root, 'sub'))
    symlinkSync(outside, join(root, 'dir-link'))
    writeFileSync(join(root, 'sub', 'not-an-image.png'), 'text')
    linkSync(join(outside, 'private.png'), join(root, 'hard-link.png'))
  })
  afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })

  it('embeds a real image under the root and omits symlinked leaves, symlinked parents, hard links, absolute outside paths, and fakes', () => {
    const embed = (ref: string): string => embedShareMedia(`see MEDIA:${ref} here`, [root], root)
    expect(embed('inside.png')).toMatch(/<img src="data:image\/png;base64,/)
    expect(embed(join(root, 'inside.png'))).toMatch(/<img src="data:image\/png;base64,/)
    for (const ref of ['leaf-link.png', 'dir-link/private.png', 'hard-link.png', join(outside, 'private.png'), 'sub/not-an-image.png', '../private.png']) {
      expect(embed(ref), ref).toContain('Local attachment omitted')
      expect(embed(ref), ref).not.toContain('base64')
    }
  })

  it('omits an image that grows past the cap after its size is sampled, and still embeds one exactly at the cap', () => {
    writeFileSync(join(root, 'grows.png'), png)
    Object.assign(grow, { path: join(root, 'grows.png'), ino: statSync(join(root, 'grows.png')).ino, bytes: SHARE_EMBED_MAX_BYTES + 1 })
    const session = new Session({ title: 'Grown', messages: [] }, { workspace: root, model: null })
    const snapshot = buildShareSnapshot(session, [{ role: 'assistant', content: 'see MEDIA:grows.png here' }], { hermesHome: join(root, '.hermes'), attachmentRoot: root, home: root })
    expect(grow.path, 'the hook fired').toBe('')
    expect(statSync(join(root, 'grows.png')).size).toBeGreaterThan(SHARE_EMBED_MAX_BYTES)
    const text = JSON.stringify(snapshot)
    expect(text).toContain('Local attachment omitted')
    expect(text).not.toContain('base64')

    writeFileSync(join(root, 'at-cap.png'), Buffer.concat([png, Buffer.alloc(SHARE_EMBED_MAX_BYTES - png.length, 1)]))
    const atCap = embedShareMedia('MEDIA:at-cap.png', [root], root)
    expect(atCap).toMatch(/<img src="data:image\/png;base64,/)
    expect(Buffer.from(/base64,([^"]+)"/.exec(atCap)![1]!, 'base64').length).toBe(SHARE_EMBED_MAX_BYTES)
  })
})
