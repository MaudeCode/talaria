import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESCRIPTION_BYTES, listCronScripts } from './cron-scripts.js'

/** Descriptors still open, bytes read per open (descriptor numbers are reused), and a hook run after each async `realpath`. */
const io = vi.hoisted(() => ({ open: new Map<number, number>(), reads: [] as number[], afterRealpath: null as ((path: string) => void) | null }))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const openSync = (...args: Parameters<typeof fs.openSync>): number => { const fd = fs.openSync(...args); io.open.set(fd, io.reads.push(0) - 1); return fd }
  const closeSync = (fd: number): void => { io.open.delete(fd); fs.closeSync(fd) }
  const readSync = ((fd: number, ...rest: unknown[]) => { const n = (fs.readSync as (...a: unknown[]) => number)(fd, ...rest); const slot = io.open.get(fd); if (slot !== undefined) io.reads[slot]! += n; return n }) as typeof fs.readSync
  return { ...fs, openSync, closeSync, readSync, default: { ...fs, openSync, closeSync, readSync } }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const fsp = await importOriginal<typeof import('node:fs/promises')>()
  const realpath = async (...args: Parameters<typeof fsp.realpath>) => { const real = await fsp.realpath(...args); io.afterRealpath?.(String(args[0])); return real }
  return { ...fsp, realpath }
})

describe('listCronScripts', () => {
  let home = ''
  let scripts = ''
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-cron-scripts-')))
    scripts = join(home, 'scripts')
    io.open.clear()
    io.reads = []
    io.afterRealpath = null
  })
  afterEach(() => {
    chmodSync(home, 0o700)
    if (statSync(scripts, { throwIfNoEntry: false })) chmodSync(scripts, 0o700)
    rmSync(home, { recursive: true, force: true })
  })

  it('lists .py and .sh regular files one level deep with the name a job script takes, and nothing else', async () => {
    const outside = join(home, 'outside.py')
    writeFileSync(outside, '"""Outside the scripts dir."""\n')
    mkdirSync(join(scripts, 'feeds', 'deep'), { recursive: true })
    mkdirSync(join(scripts, 'dir.py'))
    writeFileSync(join(scripts, 'backup.sh'), '#!/bin/bash\n# shellcheck disable=SC2034\n\n# Back up the notes vault\nrsync -a ~/notes /mnt\n')
    writeFileSync(join(scripts, 'digest.py'), '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n"""Summarise the inbox."""\nprint(1)\n')
    writeFileSync(join(scripts, 'bare.py'), 'print(1)\n')
    writeFileSync(join(scripts, 'notes.txt'), '# not a script\n')
    writeFileSync(join(scripts, 'feeds', 'collect.py'), "'''\n  Collect RSS feeds.\n'''\n")
    writeFileSync(join(scripts, 'feeds', 'deep', 'too-deep.py'), '# two levels down\n')
    symlinkSync(outside, join(scripts, 'escape.py'))
    symlinkSync(join(scripts, 'digest.py'), join(scripts, 'alias.py'))
    execFileSync('mkfifo', [join(scripts, 'pipe.sh')])

    const listing = await listCronScripts(home)

    const row = (name: string, description: string | null) => {
      const st = statSync(join(scripts, name))
      return { name, size: st.size, mtime: st.mtimeMs / 1000, description }
    }
    expect(listing).toEqual({
      directory: scripts,
      unavailable_reason: null,
      scripts: [row('alias.py', 'Summarise the inbox.'), row('backup.sh', 'Back up the notes vault'), row('bare.py', null), row('digest.py', 'Summarise the inbox.'), row('feeds/collect.py', 'Collect RSS feeds.')],
    })
  })

  it('never reads a file through a subdirectory swapped for an outside link after its containment check', async () => {
    const outside = join(home, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'collect.py'), '"""Outside the scripts dir."""\n')
    mkdirSync(join(scripts, 'feeds'), { recursive: true })
    writeFileSync(join(scripts, 'feeds', 'collect.py'), '"""Inside."""\n')
    io.afterRealpath = (path) => {
      if (!path.endsWith(join('feeds', 'collect.py'))) return
      io.afterRealpath = null
      renameSync(join(scripts, 'feeds'), join(home, 'feeds-moved'))
      symlinkSync(outside, join(scripts, 'feeds'))
    }
    expect((await listCronScripts(home)).scripts).toEqual([])
  })

  it('answers an empty list with no reason when the profile has no scripts directory', async () => {
    expect(await listCronScripts(home)).toEqual({ directory: scripts, scripts: [], unavailable_reason: null })
  })

  it('reports why when the scripts directory cannot be read', async () => {
    mkdirSync(scripts)
    writeFileSync(join(scripts, 'hidden.py'), '# unreadable\n')
    chmodSync(scripts, 0o000)
    const listing = await listCronScripts(home)
    expect(listing.scripts).toEqual([])
    expect(listing.unavailable_reason).toBe('Permission denied')
  })

  it('reads at most 8 KiB of each script and closes every handle it opens', async () => {
    mkdirSync(scripts)
    writeFileSync(join(scripts, 'huge.sh'), '\n'.repeat(DESCRIPTION_BYTES) + '# past the bound\n' + 'x'.repeat(1024 * 1024))
    writeFileSync(join(scripts, 'small.py'), '# small\n')
    mkdirSync(join(scripts, 'dir.sh'))

    const listing = await listCronScripts(home)

    expect(listing.scripts.map((s) => [s.name, s.description])).toEqual([['huge.sh', null], ['small.py', 'small']])
    expect(Math.max(...io.reads)).toBe(DESCRIPTION_BYTES)
    expect([...io.open.keys()]).toEqual([])
  })
})
