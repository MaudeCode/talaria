/** TAL-1245: the Logs tail reads backward in bounded chunks, matches the whole-window split it replaced, and always closes its descriptor. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpFailure } from '../sessions/service.js'
import { readLogTail } from './health.js'

/** Bytes read and descriptors opened/closed by `readLogTail`, with an optional gate that holds the next read. */
const io = vi.hoisted(() => ({ bytes: 0, opened: 0, closed: 0, hold: null as Promise<void> | null, held: null as (() => void) | null, fail: null as Error | null, cap: Infinity }))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const readSync = (...args: Parameters<typeof fs.readSync>): number => { const n = fs.readSync(...args); io.bytes += n; return n }
  return { ...fs, readSync }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const fsp = await importOriginal<typeof import('node:fs/promises')>()
  const open = async (...args: Parameters<typeof fsp.open>): Promise<FileHandle> => {
    const handle = await fsp.open(...args)
    io.opened += 1
    const read = handle.read.bind(handle) as (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>
    const close = handle.close.bind(handle)
    const counted = async (buffer: Buffer, offset: number, length: number, position: number) => {
      const hold = io.hold
      if (hold) { io.hold = null; io.held?.(); await hold }
      if (io.fail) throw io.fail
      const result = await read(buffer, offset, Math.min(length, io.cap), position)
      io.bytes += result.bytesRead
      return result
    }
    Object.assign(handle, { read: counted, close: async () => { io.closed += 1; await close() } })
    return handle
  }
  return { ...fsp, open }
})

/** The replaced whole-window read: the last 4 MiB split in full, then sliced. */
function reference(content: Buffer, tail: number): string[] {
  const lines = content.subarray(Math.max(0, content.length - 4 * 1024 * 1024)).toString('utf8').split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-tail)
}

/** Arms a gate on the next read; resolves `entered` once that read is waiting. */
function holdNextRead(): { entered: Promise<void>; release: () => void } {
  let release!: () => void
  io.hold = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { io.held = resolve })
  return { entered, release }
}

describe('readLogTail', () => {
  let home = ''
  let log = ''
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'talaria-logs-'))
    mkdirSync(join(home, 'logs'))
    log = join(home, 'logs', 'agent.log')
    Object.assign(io, { bytes: 0, opened: 0, closed: 0, hold: null, held: null, fail: null, cap: Infinity })
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  const tailOf = async (tail: number, file = 'agent') => (await readLogTail(home, file, String(tail))) as { lines: string[]; truncated: boolean; total_bytes: number; mtime: number | null; hint: string; tail: number; file: string }
  const check = async (content: Buffer, tail: number) => {
    writeFileSync(log, content)
    expect((await tailOf(tail)).lines).toEqual(reference(content, tail))
  }

  it('reads one bounded chunk for 100 short lines of a 4 MiB log', async () => {
    const line = 'short line\n'
    const content = Buffer.from(line.repeat(Math.ceil((4 * 1024 * 1024) / line.length)))
    writeFileSync(log, content)
    const body = await tailOf(100)
    expect(io.bytes).toBeLessThanOrEqual(64 * 1024)
    expect(body.lines).toEqual(reference(content, 100))
    expect(body).toMatchObject({ file: 'agent', tail: 100, truncated: true, total_bytes: content.length, hint: '' })
    expect(io.closed).toBe(io.opened)
  })

  it('matches the whole-window split for UTF-8 across chunks, CRLF, trailing newlines, empty and long lines', async () => {
    const multibyte = Array.from({ length: 3000 }, (_, i) => `${String(i)} é€😀 ${'ü'.repeat(i % 37)}`).join('\n')
    await check(Buffer.from(multibyte), 1000)
    await check(Buffer.from(`${multibyte}\n`), 1000)
    await check(Buffer.from(Array.from({ length: 900 }, (_, i) => `crlf ${String(i)}`).join('\r\n') + '\r\n'), 500)
    await check(Buffer.from('a\n\n\nb\n\n'), 100)
    await check(Buffer.from('only line, no newline'), 100)
    await check(Buffer.from('x'.repeat(300 * 1024) + '\nlast\n'), 100)
    await check(Buffer.from('€'.repeat(2 * 1024 * 1024)), 100)
    await check(Buffer.from('\n'), 100)
    await check(Buffer.from('\r\n'), 100)
    // Lines sized so separators land on, just before, and just after 64 KiB chunk starts.
    for (const width of [1023, 1024, 1025, 65535, 65536]) for (const tail of [100, 200]) await check(Buffer.from(`${'y'.repeat(width - 1)}\n`.repeat(tail + 2)), tail)
    let seed = 1245
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
    for (let round = 0; round < 20; round += 1) {
      const lines = Array.from({ length: 50 + random(1500) }, () => ['', 'a', 'é', '😀\r', 'z'.repeat(random(400))][random(5)]!)
      await check(Buffer.from(lines.join(random(2) ? '\n' : '\r\n') + ['', '\n', '\r\n'][random(3)]!), [100, 200, 500, 1000][random(4)]!)
    }
    writeFileSync(log, '')
    expect(await tailOf(100)).toMatchObject({ lines: [], truncated: false, total_bytes: 0, hint: '' })
    expect(typeof (await tailOf(100)).mtime).toBe('number')
  })

  it('keeps the size it opened when the log grows and rereads when it shrinks mid-read', async () => {
    const content = Buffer.from('first\nsecond\n')
    writeFileSync(log, content)
    let gate = holdNextRead()
    let pending = tailOf(100)
    await gate.entered
    appendFileSync(log, 'late\n')
    gate.release()
    expect(await pending).toMatchObject({ lines: ['first', 'second'], total_bytes: content.length })

    writeFileSync(log, 'x\n'.repeat(100_000))
    gate = holdNextRead()
    pending = tailOf(100)
    await gate.entered
    writeFileSync(log, 'fresh\n')
    gate.release()
    expect(await pending).toMatchObject({ lines: ['fresh'], total_bytes: 6, truncated: false })
    expect(io.closed).toBe(io.opened)
  })

  it('fills each chunk across partial reads of a stable log', async () => {
    io.cap = 1000
    await check(Buffer.from(Array.from({ length: 3000 }, (_, i) => `partial ${String(i)} é€😀`).join('\n')), 1000)
    expect(io.closed).toBe(io.opened)
  })

  it('refuses a symlink and treats a FIFO as missing', async () => {
    writeFileSync(join(home, 'secret.txt'), 'secret\n')
    symlinkSync(join(home, 'secret.txt'), log)
    await expect(tailOf(100)).rejects.toMatchObject({ status: 400, message: 'Invalid log file' })
    await expect(tailOf(100)).rejects.toBeInstanceOf(HttpFailure)
    rmSync(log)
    execFileSync('mkfifo', [log])
    expect(await tailOf(100)).toMatchObject({ lines: [], total_bytes: 0, hint: 'Log file for agent not found yet.' })
    expect(io.closed).toBe(io.opened)
  })

  it('lets the event loop run while a read is held and closes on failure and cancellation', async () => {
    writeFileSync(log, 'one\ntwo\n')
    const gate = holdNextRead()
    let settled = false
    const pending = tailOf(100).finally(() => { settled = true })
    await gate.entered
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(settled).toBe(false)
    gate.release()
    expect((await pending).lines).toEqual(['one', 'two'])

    io.fail = new Error('EIO')
    await expect(tailOf(100)).rejects.toThrow('EIO')
    io.fail = null

    const controller = new AbortController()
    const cancel = holdNextRead()
    const cancelled = readLogTail(home, 'agent', '100', controller.signal)
    await cancel.entered
    controller.abort()
    cancel.release()
    await expect(cancelled).rejects.toThrow()
    expect(io.closed).toBe(io.opened)
    expect(readFileSync(log, 'utf8')).toBe('one\ntwo\n')
  })
})
