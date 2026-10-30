/**
 * Persisted browser state. Only validated JSON (or plain enumerated strings)
 * crosses this boundary; nothing is restored as HTML. Storage failures
 * (private mode, quota) degrade to in-memory defaults.
 */
import type { ZodType } from 'zod'

const memory = new Map<string, string>()
/** Keys whose last write did not reach storage: their in-memory copy is newer than what storage holds. */
const unsaved = new Set<string>()

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readPersisted(key: string): string | null {
  const s = storage()
  if (!s || unsaved.has(key)) return memory.get(key) ?? null
  try {
    return s.getItem(key)
  } catch {
    return memory.get(key) ?? null
  }
}

export function writePersisted(key: string, value: string): void {
  memory.set(key, value)
  const s = storage()
  if (!s) return
  try {
    s.setItem(key, value)
    unsaved.delete(key)
  } catch {
    /* quota or disabled storage: keep the in-memory copy, which reads now prefer */
    unsaved.add(key)
  }
}

export function removePersisted(key: string): void {
  memory.delete(key)
  unsaved.delete(key)
  const s = storage()
  if (!s) return
  try {
    s.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** Read and validate JSON. Invalid or malformed values are discarded (fail closed) and removed. */
export function readPersistedJson<T>(key: string, schema: ZodType<T>): T | null {
  const raw = readPersisted(key)
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    removePersisted(key)
    return null
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    removePersisted(key)
    return null
  }
  return result.data
}

export function writePersistedJson(key: string, value: unknown): void {
  writePersisted(key, JSON.stringify(value))
}

/** Remove every key with the given prefix (used on logout to drop per-identity state). */
export function removePersistedByPrefix(prefix: string): void {
  for (const k of [...memory.keys()]) if (k.startsWith(prefix)) { memory.delete(k); unsaved.delete(k) }
  const s = storage()
  if (!s) return
  try {
    const keys: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k?.startsWith(prefix)) keys.push(k)
    }
    for (const k of keys) s.removeItem(k)
  } catch {
    /* ignore */
  }
}
