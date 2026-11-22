/**
 * TAL-2663: this install's stable identity. A random 128-bit ID minted on first start and kept in Web's own state
 * directory, so a client recognizes the server whatever address reaches it. Opaque: it names nothing about the host
 * and grants nothing.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteText } from './fs/atomic.js'

const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{22}$/

/** The ID stored at `<stateDir>/instance_id`, minting and writing it (mode 0600) when absent or unreadable. */
export function loadInstanceId(stateDir: string): string {
  const path = join(stateDir, 'instance_id')
  try {
    const stored = readFileSync(path, 'utf8').trim()
    if (INSTANCE_ID_RE.test(stored)) return stored
  } catch { /* first start */ }
  const id = randomBytes(16).toString('base64url')
  atomicWriteText(path, id, { mode: 0o600 })
  return id
}
