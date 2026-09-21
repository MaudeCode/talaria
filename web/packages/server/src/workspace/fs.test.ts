/** Anchored file helpers: descriptor-relative walks refuse symlinked components at every depth (Python `openat`). */
import { closeSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileExistsError, makeAnchoredDir, NotFoundError, openAnchoredCreateFd, openAnchoredFd, openAnchoredWriteFd, PathTraversalError, renameAnchored, rmtreeAnchored, unlinkAnchored } from './fs.js'

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
  afterEach(() => { vi.restoreAllMocks() })

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

  it('renames within and across directories through the walk and refuses an occupied destination', () => {
    mkdirSync(join(root, 'ren', 'sub'), { recursive: true })
    writeFileSync(join(root, 'ren', 'one.txt'), '1')
    writeFileSync(join(root, 'ren', 'taken.txt'), 't')
    renameAnchored(root, join(root, 'ren', 'one.txt'), join(root, 'ren', 'two.txt'))
    expect(readFileSync(join(root, 'ren', 'two.txt'), 'utf8')).toBe('1')
    renameAnchored(root, join(root, 'ren', 'two.txt'), join(root, 'ren', 'sub', 'two.txt'))
    expect(readFileSync(join(root, 'ren', 'sub', 'two.txt'), 'utf8')).toBe('1')
    expect(() => { renameAnchored(root, join(root, 'ren', 'sub', 'two.txt'), join(root, 'ren', 'taken.txt')) }).toThrow(FileExistsError)
    expect(readFileSync(join(root, 'ren', 'taken.txt'), 'utf8')).toBe('t')
    expect(() => { renameAnchored(root, join(root, 'ren', 'sub', 'two.txt'), join(outside, 'two.txt')) }).toThrow(PathTraversalError)
  })

  it('restores the working directory after a leaf operation succeeds or fails', () => {
    const before = process.cwd()
    closeSync(openAnchoredWriteFd(root, join(root, 'a', 'b', 'f.txt')))
    expect(process.cwd()).toBe(before)
    expect(() => openAnchoredWriteFd(root, join(root, 'a', 'b', 'missing.txt'))).toThrow(NotFoundError)
    expect(process.cwd()).toBe(before)
    writeFileSync(join(root, 'a', 'b', 'f.txt'), 'inside')
  })

  // The descriptor platform never resolves a pathname for the leaf; this exercises the cwd anchor used elsewhere.
  it.runIf(process.platform !== 'linux')('a parent swapped for a symlink after the descriptor was opened cannot redirect the leaf write', () => {
    mkdirSync(join(root, 'late'), { recursive: true })
    writeFileSync(join(root, 'late', 'v.txt'), 'victim-inside')
    writeFileSync(join(outside, 'v.txt'), 'victim-outside')
    const realChdir = process.chdir.bind(process)
    let swapped = false
    vi.spyOn(process, 'chdir').mockImplementation((dir: string) => {
      realChdir(dir)
      if (!swapped && dir === join(root, 'late')) {
        // The walk has finished and the leaf op is about to run: replace the pathname it would have used.
        swapped = true
        renameSync(join(root, 'late'), join(root, 'late-real'))
        symlinkSync(outside, join(root, 'late'))
      }
    })
    const fd = openAnchoredWriteFd(root, join(root, 'late', 'v.txt'))
    closeSync(fd)
    expect(swapped).toBe(true)
    expect(readFileSync(join(outside, 'v.txt'), 'utf8')).toBe('victim-outside')
    expect(readFileSync(join(root, 'late-real', 'v.txt'), 'utf8')).toBe('')
  })
})
