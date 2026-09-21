/**
 * Crash-safe text writes: sibling temp file, fsync, rename (Python
 * `api/config._atomic_write_settings_text`). The existing mode is carried
 * onto the replacement so an operator-hardened 0600 file is never loosened,
 * and a symlinked target is written through to its referent. New files are
 * created with 0o666 so the kernel applies the process umask.
 */
import { chmodSync, closeSync, fsyncSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, lstatSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

let counter = 0

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
  const tmp = join(dirname(writePath), `.${basename(writePath)}.${process.pid}.${++counter}.tmp`)
  // Existing or explicit mode: write privately then carry the mode over. New file: create with 0o666 so the kernel
  // applies the process umask exactly as an ordinary create would (0o600 under umask 077); no umask read needed.
  const fd = openSync(tmp, 'w', mode === undefined ? 0o666 : 0o600)
  try {
    writeSync(fd, text)
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

/** Atomic JSON write with a fixed 0600 mode (session and login-attempt stores). */
export function atomicWriteSecretJson(path: string, value: unknown): void {
  atomicWriteText(path, JSON.stringify(value), { mode: 0o600 })
}
