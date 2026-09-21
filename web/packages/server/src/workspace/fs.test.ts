/** Anchored file helpers: descriptor-relative walks refuse symlinked components at every depth (Python `openat`). */
import { closeSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeAnchoredDir, NotFoundError, openAnchoredCreateFd, openAnchoredFd, PathTraversalError, rmtreeAnchored, unlinkAnchored } from './fs.js'

describe('anchored walk', () => {
  let root = ''
  let outside = ''
  beforeAll(() => {
    // Callers pass resolved targets; the root here is already real so joined paths stay under it lexically.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'anchored-root-')))
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'anchored-outside-')))
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'f.txt'), 'inside')
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    symlinkSync(outside, join(root, 'link-dir'))
    symlinkSync(join(outside, 'secret.txt'), join(root, 'a', 'link-file'))
  })
  afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })

  it('reads a real file through the walk', () => {
    const fd = openAnchoredFd(root, join(root, 'a', 'b', 'f.txt'), { wantDir: false })
    try { expect(readFileSync(fd, 'utf8')).toBe('inside') } finally { closeSync(fd) }
  })

  it('refuses a symlinked leaf and a symlinked parent component', () => {
    expect(() => openAnchoredFd(root, join(root, 'a', 'link-file'), { wantDir: false })).toThrow(NotFoundError)
    expect(() => openAnchoredFd(root, join(root, 'link-dir', 'secret.txt'), { wantDir: false })).toThrow(NotFoundError)
    // The mutating helpers resolve the target first, so a link out of the root is refused as traversal before any walk.
    expect(() => { unlinkAnchored(root, join(root, 'link-dir', 'secret.txt')); }).toThrow(PathTraversalError)
    expect(() => { rmtreeAnchored(root, join(root, 'link-dir')); }).toThrow(PathTraversalError)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside')
  })

  it('refuses a parent swapped for a symlink after resolution', () => {
    mkdirSync(join(root, 'swap', 'inner'), { recursive: true })
    writeFileSync(join(root, 'swap', 'inner', 'g.txt'), 'g')
    const target = join(root, 'swap', 'inner', 'g.txt')
    // The path was valid when computed; the parent is then replaced by a link before the open.
    renameSync(join(root, 'swap'), join(root, 'swap-real'))
    symlinkSync(outside, join(root, 'swap'))
    writeFileSync(join(outside, 'inner-g.txt'), 'x')
    mkdirSync(join(outside, 'inner'), { recursive: true })
    writeFileSync(join(outside, 'inner', 'g.txt'), 'outside g')
    expect(() => openAnchoredFd(root, target, { wantDir: false })).toThrow(NotFoundError)
  })

  it('creates, makes directories, and rejects traversal outside the root', () => {
    const fd = openAnchoredCreateFd(root, join(root, 'new', 'deep', 'h.txt'))
    closeSync(fd)
    expect(readFileSync(join(root, 'new', 'deep', 'h.txt'), 'utf8')).toBe('')
    makeAnchoredDir(root, join(root, 'made', 'dir'))
    expect(() => openAnchoredFd(root, join(outside, 'secret.txt'), { wantDir: false })).toThrow(PathTraversalError)
    expect(() => openAnchoredCreateFd(root, join(root, 'link-dir', 'evil.txt'))).toThrow(NotFoundError)
  })
})
