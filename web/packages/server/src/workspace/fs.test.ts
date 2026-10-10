/** Anchored file helpers: descriptor-relative walks refuse symlinked components at every depth (Python `openat`). */
import { spawnSync } from 'node:child_process'
import { closeSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Lets a test act between the walk's lstat of an entry and its descent into it.
const afterLstat = vi.hoisted(() => ({ hook: null as ((path: string) => void) | null }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const lstatSync = ((path: string, opts?: unknown) => {
    const result = fs.lstatSync(path, opts as undefined)
    afterLstat.hook?.(path)
    return result
  }) as typeof fs.lstatSync
  return { ...fs, default: { ...fs, lstatSync }, lstatSync }
})

import { dirSignature, FileExistsError, listDir, makeAnchoredDir, NotFoundError, openAnchoredCreateFd, openAnchoredFd, openAnchoredWriteFd, PathTraversalError, renameAnchored, rmtreeAnchored, serializeEntriesForBrowser, unlinkAnchored } from './fs.js'

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
  afterEach(() => { vi.restoreAllMocks(); afterLstat.hook = null })

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

  it.runIf(process.platform !== 'linux')('a destination parent swapped for a symlink mid-move never receives the entry, and the source is restored', () => {
    mkdirSync(join(root, 'mv', 'src'), { recursive: true })
    mkdirSync(join(root, 'mv', 'dst'), { recursive: true })
    mkdirSync(join(root, 'mv', 'src', 'folder'), { recursive: true })
    writeFileSync(join(root, 'mv', 'src', 'folder', 'k.txt'), 'keep')
    writeFileSync(join(root, 'mv', 'src', 'm.txt'), 'moved')
    const realChdir = process.chdir.bind(process)
    let swapped = false
    vi.spyOn(process, 'chdir').mockImplementation((dir: string) => {
      realChdir(dir)
      if (!swapped && dir === join(root, 'mv', 'dst')) {
        swapped = true
        renameSync(join(root, 'mv', 'dst'), join(root, 'mv', 'dst-real'))
        symlinkSync(outside, join(root, 'mv', 'dst'))
      }
    })
    expect(() => { renameAnchored(root, join(root, 'mv', 'src', 'm.txt'), join(root, 'mv', 'dst', 'm.txt')) }).toThrow(NotFoundError)
    expect(swapped).toBe(true)
    expect(readFileSync(join(root, 'mv', 'src', 'm.txt'), 'utf8')).toBe('moved')
    expect(readdirSync(outside)).not.toContain('m.txt')
    expect(readdirSync(root).filter((n) => n.startsWith('.talaria-move-'))).toEqual([])
    vi.restoreAllMocks()
    // A directory moves across parents through the hop as well.
    renameAnchored(root, join(root, 'mv', 'src', 'folder'), join(root, 'mv', 'dst-real', 'folder'))
    expect(readFileSync(join(root, 'mv', 'dst-real', 'folder', 'k.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(root).filter((n) => n.startsWith('.talaria-move-'))).toEqual([])
  })

  it('a subdirectory swapped for a symlink to an outside directory mid-delete leaves the outside directory intact', () => {
    mkdirSync(join(root, 'rt', 'sub', 'deep'), { recursive: true })
    writeFileSync(join(root, 'rt', 'sub', 'deep', 'd.txt'), 'd')
    writeFileSync(join(root, 'rt', 'top.txt'), 't')
    mkdirSync(join(outside, 'victim'), { recursive: true })
    writeFileSync(join(outside, 'victim', 'keep.txt'), 'keep')
    // A link already inside the tree is removed as a link, never followed.
    symlinkSync(join(outside, 'victim'), join(root, 'rt', 'sub', 'deep', 'link-out'))
    let swapped = false
    afterLstat.hook = (path) => {
      if (swapped || basename(path) !== 'sub') return
      // The walk has seen `sub` as a directory; a concurrent writer now replaces it with a link out.
      swapped = true
      renameSync(join(root, 'rt', 'sub'), join(root, 'rt-sub-moved'))
      symlinkSync(join(outside, 'victim'), join(root, 'rt', 'sub'))
    }
    rmtreeAnchored(root, join(root, 'rt'))
    expect(swapped).toBe(true)
    expect(readFileSync(join(outside, 'victim', 'keep.txt'), 'utf8')).toBe('keep')
    expect(readdirSync(root)).not.toContain('rt')
  })

  it('a subdirectory swapped for another real directory mid-delete fails closed and leaves that directory intact', () => {
    mkdirSync(join(root, 'rt2', 'sub'), { recursive: true })
    writeFileSync(join(root, 'rt2', 'sub', 'd.txt'), 'd')
    mkdirSync(join(root, 'precious'), { recursive: true })
    writeFileSync(join(root, 'precious', 'keep.txt'), 'keep')
    let swapped = false
    afterLstat.hook = (path) => {
      if (swapped || basename(path) !== 'sub') return
      // A sibling directory is renamed into the listed name before the walk opens it.
      swapped = true
      renameSync(join(root, 'rt2', 'sub'), join(root, 'rt2-sub-moved'))
      renameSync(join(root, 'precious'), join(root, 'rt2', 'sub'))
    }
    expect(() => { rmtreeAnchored(root, join(root, 'rt2')) }).toThrow(NotFoundError)
    expect(swapped).toBe(true)
    expect(readFileSync(join(root, 'rt2', 'sub', 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('lists a directory through the walk and refuses a symlinked one', () => {
    mkdirSync(join(root, 'ls'), { recursive: true })
    writeFileSync(join(root, 'ls', 'a.txt'), 'aaa')
    mkdirSync(join(root, 'ls', 'sub'))
    const names = listDir(root, 'ls').map((e) => [e.name, e.type, e.size ?? null])
    expect(names).toEqual([['sub', 'dir', null], ['a.txt', 'file', 3]])
    expect(() => listDir(root, 'link-dir')).toThrow(PathTraversalError)
  })

  it.runIf(process.platform !== 'linux')('a directory swapped for a symlink after its descriptor was opened is still listed from the descriptor', () => {
    mkdirSync(join(root, 'late-ls'), { recursive: true })
    writeFileSync(join(root, 'late-ls', 'inside.txt'), 'in')
    writeFileSync(join(outside, 'outside.txt'), 'out')
    const realChdir = process.chdir.bind(process)
    let swapped = false
    vi.spyOn(process, 'chdir').mockImplementation((dir: string) => {
      realChdir(dir)
      if (!swapped && dir === join(root, 'late-ls')) {
        swapped = true
        renameSync(join(root, 'late-ls'), join(root, 'late-ls-real'))
        symlinkSync(outside, join(root, 'late-ls'))
      }
    })
    const names = listDir(root, 'late-ls').map((e) => e.name)
    expect(swapped).toBe(true)
    expect(names).toEqual(['inside.txt'])
  })

  it.runIf(process.platform !== 'win32')('a FIFO where a file is expected neither blocks the open nor is truncated', () => {
    const fifo = join(root, 'pipe.png')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    // Reads: the open returns (non-blocking) and the caller's fstat check sees a non-file.
    const fd = openAnchoredFd(root, fifo, { wantDir: false })
    try { expect(fstatSync(fd).isFile()).toBe(false) } finally { closeSync(fd) }
    // Writes: refused before any truncation.
    expect(() => openAnchoredWriteFd(root, fifo)).toThrow(NotFoundError)
  })
})

describe('dir_signature parity', () => {
  it('hashes a listing exactly as the Python `dir_signature` did (bare integer mtime_ns, sorted compact JSON)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'talaria-sig-'))
    try {
      writeFileSync(join(ws, 'é name.txt'), 'x')
      mkdirSync(join(ws, 'sub'))
      const entries = listDir(ws, '.')
      const ours = dirSignature(ws, '.', entries)
      const py = spawnSync('python3', ['-c', `
import json, sys, hashlib
entries = json.loads(sys.stdin.read())
payload = [{'name': e.get('name'), 'path': e.get('path'), 'type': e.get('type'), 'is_dir': e.get('is_dir'), 'size': e.get('size'), 'mtime_ns': e.get('mtime_ns'), 'target': e.get('target'), 'target_outside_workspace': e.get('target_outside_workspace')} for e in entries]
raw = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
print(hashlib.sha256(raw.encode('utf-8')).hexdigest())`], { encoding: 'utf8', input: JSON.stringify(entries.map((e) => ({ ...e, mtime_ns: e.mtime_ns === null || e.mtime_ns === undefined ? null : `\u0000${e.mtime_ns.toString()}\u0000`, birthtime_ns: undefined }))).replaceAll(/"\\u0000(\d+)\\u0000"/g, '$1') })
      expect(py.status).toBe(0)
      expect(ours).toBe(py.stdout.trim())
      // The browser payload carries the timestamps as decimal strings, as Python did.
      expect(typeof serializeEntriesForBrowser(entries)[0]?.mtime_ns).toBe('string')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})
