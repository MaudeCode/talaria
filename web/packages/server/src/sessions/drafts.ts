/**
 * Composer draft sidecars (Python `api/session_drafts.py`): tiny atomic files
 * under `sessions/_drafts/<sid>.json` with a monotonic decimal revision.
 */
import { RevisionConflict, type DocumentBackend } from './storage/backend.js'
import { readDocument } from './storage/document.js'
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
  constructor(private readonly documents: DocumentBackend) {}

  validate(sid: string): void { if (!isSafeSessionId(sid)) throw new Error('Invalid session_id') }

  async exists(sid: string): Promise<boolean> { this.validate(sid); return await readDocument(this.documents, 'drafts', sid, { replaceInvalid: true }) !== null }

  private recordState(value: unknown): [Draft, string | null] {
    const record = value as Record<string, unknown> | null | undefined
    return [normalizeDraft(value), normalizeDraftVersion(record?.[DRAFT_VERSION_KEY])]
  }

  async readState(sid: string, fallback?: unknown): Promise<[Draft, string | null]> {
    try {
      this.validate(sid)
      const record = await this.documents.get('drafts', sid)
      if (!record) return [normalizeDraft(fallback), null]
      return this.recordState(record.value)
    } catch { return [normalizeDraft(fallback), null] }
  }

  async read(sid: string, fallback?: unknown): Promise<Draft> { return (await this.readState(sid, fallback))[0] }

  /** Persist a versioned draft; equal-version retries with identical payloads are accepted. */
  async write(sid: string, draft: unknown, version?: unknown): Promise<Draft> {
    const normalized = normalizeDraft(draft)
    const normalizedVersion = normalizeDraftVersion(version)
    this.validate(sid)
    const current = await readDocument(this.documents, 'drafts', sid, { replaceInvalid: true })
    let state: [Draft, string | null]
    try { state = this.recordState(current?.value) } catch { state = [normalizeDraft(null), null] }
    const [currentDraft, currentVersion] = state
    if (currentVersion !== null) {
      if (normalizedVersion === null || cmp(normalizedVersion, currentVersion) < 0) throw new DraftVersionConflict(currentDraft, currentVersion)
      if (cmp(normalizedVersion, currentVersion) === 0) {
        if (!sameDraft(normalized, currentDraft)) throw new DraftVersionConflict(currentDraft, currentVersion)
        return currentDraft
      }
    }
    const record: Record<string, unknown> = { ...normalized }
    if (normalizedVersion !== null) record[DRAFT_VERSION_KEY] = normalizedVersion
    try { await this.documents.put('drafts', sid, record, current?.revision ?? null) }
    catch (error) {
      if (!(error instanceof RevisionConflict)) throw error
      const winner = await this.documents.get('drafts', sid)
      const [latest, latestVersion] = this.recordState(winner?.value)
      throw new DraftVersionConflict(latest, latestVersion)
    }
    return normalized
  }

  /** Session IDs that have a stored draft. */
  async ids(): Promise<string[]> { return (await this.documents.list('drafts')).map((row) => row.key) }

  async delete(sid: string): Promise<void> {
    try { this.validate(sid) } catch { return }
    await this.documents.delete('drafts', sid)
  }
}
