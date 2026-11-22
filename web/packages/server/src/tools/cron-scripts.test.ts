import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESCRIPTION_BYTES, listCronScripts } from './cron-scripts.js'

/** Bytes read per opened handle, and how many of those handles were closed. */
const io = vi.hoisted(() => ({ reads: [] as number[], closed: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fsp = await importOriginal<typeof import('node:fs/promises')>()
  const open = async (...args: Parameters<typeof fsp.open>): Promise<FileHandle> => {
    const handle = await fsp.open(...args)
    const slot = io.reads.push(0) - 1
    const read = handle.read.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number | null) => Promise<{ bytesRead: number }>
    const close = handle.close.bind(handle)
    Object.assign(handle, {
      read: async (buffer: Buffer, offset: number, length: number, position: number | null) => { const result = await read(buffer, offset, length, position); io.reads[slot]! += result.bytesRead; return result },
      close: async () => { io.closed += 1; await close() },
    })
    return handle
  }
  return { ...fsp, open }
})

describe('listCronScripts', () => {
  let home = ''
  let scripts = ''
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'talaria-cron-scripts-')))
    scripts = join(home, 'scripts')
    io.reads = []
    io.closed = 0
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
    expect(io.reads.length).toBe(3)
    expect(Math.max(...io.reads)).toBe(DESCRIPTION_BYTES)
    expect(io.closed).toBe(io.reads.length)
  })
})
