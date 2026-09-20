/**
 * Crash-safe text writes: sibling temp file, fsync, rename (Python
 * `api/config._atomic_write_settings_text`). The existing mode is carried
 * onto the replacement so an operator-hardened 0600 file is never loosened,
 * and a symlinked target is written through to its referent. New files get
 * 0644 (Node has no race-free umask read).
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
    try {
      mode = statSync(writePath).mode & 0o777
    } catch {
      mode = 0o644
    }
  }
  const tmp = join(dirname(writePath), `.${basename(writePath)}.${process.pid}.${++counter}.tmp`)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
    closeSync(fd)
    chmodSync(tmp, mode)
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
