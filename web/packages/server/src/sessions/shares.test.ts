/** Public share snapshots embed only images read through the anchored walk from an allowed root. */
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { embedShareMedia } from './shares.js'

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
})
