/**
 * Composer draft sidecars (Python `api/session_drafts.py`): tiny atomic files
 * under `sessions/_drafts/<sid>.json` with a monotonic decimal revision.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteText } from '../fs/atomic.js'
import { isSafeSessionId } from './session.js'

export interface Draft { text: string; files: unknown[]; [key: string]: unknown }
const DRAFT_VERSION_KEY = '_draft_version'

export class DraftVersionConflict extends Error {
  constructor(readonly currentDraft: Draft, readonly currentVersion: string | null) {
    super('Composer draft changed in another request')
    this.name = 'DraftVersionConflict'
  }
}

export function normalizeDraft(value: unknown): Draft {
  const draft = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return { text: typeof draft.text === 'string' ? draft.text : '', files: Array.isArray(draft.files) ? draft.files : [] }
}

/** Canonical decimal revision (ms wall time x 1000); throws on anything else. */
export function normalizeDraftVersion(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') throw new Error('Invalid draft_version')
  const raw: unknown = typeof value === 'number' ? String(value) : value
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw) || raw.length < 1 || raw.length > 20) throw new Error('Invalid draft_version')
  const text = raw.replace(/^0+(?=\d)/, '')
  if (text === '0') throw new Error('Invalid draft_version')
  return text
}

const cmp = (a: string, b: string): number => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0)
const sameDraft = (a: Draft, b: Draft): boolean => JSON.stringify(a) === JSON.stringify(b)

export class DraftStore {
  constructor(readonly sessionDir: string) {}

  dir(): string {
    return join(this.sessionDir, '_drafts')
  }

  path(sid: string): string {
    if (!isSafeSessionId(sid)) throw new Error('Invalid session_id')
    return join(this.dir(), `${sid}.json`)
  }

  exists(sid: string): boolean {
    return existsSync(this.path(sid))
  }

  private readRecord(path: string, fallback?: unknown): [Draft, string | null] {
    if (!existsSync(path)) return [normalizeDraft(fallback), null]
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    let version: string | null = null
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>)[DRAFT_VERSION_KEY] != null) {
      version = normalizeDraftVersion((value as Record<string, unknown>)[DRAFT_VERSION_KEY])
    }
    return [normalizeDraft(value), version]
  }

  readState(sid: string, fallback?: unknown): [Draft, string | null] {
    try {
      return this.readRecord(this.path(sid), fallback)
    } catch {
      return [normalizeDraft(fallback), null]
    }
  }

  read(sid: string, fallback?: unknown): Draft {
    return this.readState(sid, fallback)[0]
  }

  /** Persist a versioned draft; equal-version retries with identical payloads are accepted. */
  write(sid: string, draft: unknown, version?: unknown): Draft {
    const normalized = normalizeDraft(draft)
    const normalizedVersion = normalizeDraftVersion(version)
    const path = this.path(sid)
    mkdirSync(this.dir(), { recursive: true })
    let current: [Draft, string | null]
    try {
      current = this.readRecord(path)
    } catch {
      current = [normalizeDraft(null), null]
    }
    const [currentDraft, currentVersion] = current
    if (currentVersion !== null) {
      if (normalizedVersion === null || cmp(normalizedVersion, currentVersion) < 0) throw new DraftVersionConflict(currentDraft, currentVersion)
      if (cmp(normalizedVersion, currentVersion) === 0) {
        if (!sameDraft(normalized, currentDraft)) throw new DraftVersionConflict(currentDraft, currentVersion)
        return currentDraft
      }
    }
    const record: Record<string, unknown> = { ...normalized }
    if (normalizedVersion !== null) record[DRAFT_VERSION_KEY] = normalizedVersion
    atomicWriteText(path, JSON.stringify(record))
    return normalized
  }

  delete(sid: string): void {
    let path: string
    try {
      path = this.path(sid)
    } catch {
      return
    }
    rmSync(path, { force: true })
  }
}
