/**
 * Crash-safe text writes: sibling temp file, fsync, rename (Python
 * `api/config._atomic_write_settings_text`). The existing mode is carried
 * onto the replacement so an operator-hardened 0600 file is never loosened,
 * and a symlinked target is written through to its referent. New files are
 * created with 0o666 so the kernel applies the process umask.
 */
import { chmodSync, closeSync, fsyncSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, lstatSync } from 'node:fs'
import { chmod, lstat, open, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

let counter = 0

const toBuffer = (data: string | Uint8Array): Buffer => typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
const tempPath = (writePath: string): string => join(dirname(writePath), `.${basename(writePath)}.${process.pid}.${++counter}.tmp`)

/** Write every byte: `writeSync` may return a short count (disk pressure, signals), and a rename must never publish a prefix. */
export function writeFully(fd: number, data: string | Uint8Array, write: (fd: number, buffer: Buffer, offset: number, length: number) => number = writeSync): void {
  const buffer = toBuffer(data)
  let offset = 0
  while (offset < buffer.length) {
    const written = write(fd, buffer, offset, buffer.length - offset)
    if (written <= 0) throw new Error(`short write: ${String(offset)} of ${String(buffer.length)} bytes`)
    offset += written
  }
}

export function atomicWriteText(path: string, text: string, opts: { mode?: number } = {}): void {
  let writePath = path
  try {
    if (lstatSync(path).isSymbolicLink()) writePath = realpathSync(path)
  } catch {
    /* new file */
  }
  let mode = opts.mode
  if (mode === undefined) {
    try { mode = statSync(writePath).mode & 0o777 } catch { mode = undefined }
  }
  const tmp = tempPath(writePath)
  // Existing or explicit mode: write privately then carry the mode over. New file: create with 0o666 so the kernel
  // applies the process umask exactly as an ordinary create would (0o600 under umask 077); no umask read needed.
  const fd = openSync(tmp, 'w', mode === undefined ? 0o666 : 0o600)
  try {
    writeFully(fd, text)
    fsyncSync(fd)
    closeSync(fd)
    if (mode !== undefined) chmodSync(tmp, mode)
    renameSync(tmp, writePath)
  } catch (error) {
    try { closeSync(fd) } catch { /* already closed */ }
    try { unlinkSync(tmp) } catch { /* nothing to clean */ }
    throw error
  }
}

/** `writeFully` for a promise `FileHandle`, off the event loop. */
export async function writeFullyAsync(handle: FileHandle, data: string | Uint8Array, write: (handle: FileHandle, buffer: Buffer, offset: number, length: number) => Promise<number> = async (h, b, o, l) => (await h.write(b, o, l)).bytesWritten): Promise<void> {
  const buffer = toBuffer(data)
  let offset = 0
  while (offset < buffer.length) {
    const written = await write(handle, buffer, offset, buffer.length - offset)
    if (written <= 0) throw new Error(`short write: ${String(offset)} of ${String(buffer.length)} bytes`)
    offset += written
  }
}

/** `atomicWriteText` on `node:fs/promises`, so a slow fsync never stalls the event loop. */
export async function atomicWriteTextAsync(path: string, text: string, opts: { mode?: number } = {}): Promise<void> {
  let writePath = path
  try {
    if ((await lstat(path)).isSymbolicLink()) writePath = await realpath(path)
  } catch {
    /* new file */
  }
  let mode = opts.mode
  if (mode === undefined) {
    try { mode = (await stat(writePath)).mode & 0o777 } catch { mode = undefined }
  }
  const tmp = tempPath(writePath)
  const handle = await open(tmp, 'w', mode === undefined ? 0o666 : 0o600)
  try {
    await writeFullyAsync(handle, text)
    await handle.sync()
    await handle.close()
    if (mode !== undefined) await chmod(tmp, mode)
    await rename(tmp, writePath)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

/** Atomic JSON write with a fixed 0600 mode. */
export function atomicWriteSecretJson(path: string, value: unknown): void {
  atomicWriteText(path, JSON.stringify(value), { mode: 0o600 })
}
