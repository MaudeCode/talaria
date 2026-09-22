/** `~/.hermes/.env` reader and order-preserving writer (Python `api/providers.py` `_load_env_file` / `_write_env_file`). */
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { writeFully } from '../fs/atomic.js'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export function loadEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {}
  if (!existsSync(path)) return values
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const idx = line.indexOf('=')
    values[line.slice(0, idx).trim()] = stripQuotes(line.slice(idx + 1).trim())
  }
  return values
}

function stripQuotes(v: string): string {
  return v.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '')
}

/**
 * Upsert `updates` (a `null` value removes the key). Comments, blank lines and
 * key order survive; new keys land after a blank separator. 0600, atomic.
 */
export function writeEnvFile(path: string, updates: Record<string, string | null>): void {
  let existing: string[] = []
  if (existsSync(path)) {
    try { existing = readFileSync(path, 'utf8').split('\n') } catch { existing = [] }
    if (existing.length && existing[existing.length - 1] === '') existing.pop()
  }
  const index = new Map<string, number>()
  existing.forEach((raw, i) => {
    const s = raw.trim()
    if (s && !s.startsWith('#') && s.includes('=')) index.set(s.slice(0, s.indexOf('=')).trim(), i)
  })
  const out: (string | null)[] = [...existing]
  const fresh: string[] = []
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      const at = index.get(key)
      if (at !== undefined) out[at] = null
      continue
    }
    const clean = value.trim()
    if (!clean) continue
    if (clean.includes('\n') || clean.includes('\r')) throw new Error('API key must not contain newline characters.')
    const at = index.get(key)
    if (at !== undefined) out[at] = `${key}=${clean}`
    else fresh.push(`${key}=${clean}`)
  }
  const lines = out.filter((l): l is string => l !== null)
  if (fresh.length) {
    if (lines.length && lines[lines.length - 1]?.trim() !== '') lines.push('')
    lines.push(...fresh)
  }
  let content = lines.join('\n')
  if (content) content += '\n'
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.env_${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeFully(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (error) {
    try { closeSync(fd) } catch { /* closed */ }
    try { unlinkSync(tmp) } catch { /* gone */ }
    throw error
  }
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
}
