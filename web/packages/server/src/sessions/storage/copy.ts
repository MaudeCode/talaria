import { createHash } from 'node:crypto'
import type { JournalEvent, RunSummary } from '../journal.js'
import { InvalidDocument, type StorageBackend } from './backend.js'
import { DOCUMENT_NAMESPACES } from './json-documents.js'

/** What one `talaria-web storage copy` pass wrote, what already matched, and what could not be copied. */
export interface CopyReport { copied: number; unchanged: number; failures: string[] }

const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v)
const sha256 = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')

/**
 * One comparable fingerprint per item, read through the storage port only, so every backend copies and verifies the
 * same way. `null` means the item is absent.
 */
const fingerprints = {
  async session(storage: StorageBackend, sid: string) {
    const stored = await storage.sessions.readDocument(sid)
    return stored && { messages: stored.messages.length, sha256: sha256({ doc: stored.doc, messages: stored.messages }) }
  },
  async backup(storage: StorageBackend, sid: string) {
    const backup = await storage.sessions.shrinkBackup.read(sid)
    // File times keep whole milliseconds reliably; finer digits do not survive every filesystem.
    return backup && { messages: backup.messages.length, savedAt: Math.round(backup.savedAt * 1000), sha256: sha256({ doc: backup.doc, messages: backup.messages }) }
  },
  async document(storage: StorageBackend, namespace: string, key: string) {
    try { const stored = await storage.documents.get(namespace, key); return stored && { sha256: sha256(stored.value) } } catch (error) {
      if (error instanceof InvalidDocument) return { invalid: error.revision }
      throw error
    }
  },
  async run(storage: StorageBackend, sid: string, streamId: string) {
    const run = await readRun(storage, sid, streamId)
    return { rows: run.rows.length, sha256: sha256(run) }
  },
}

async function readRun(storage: StorageBackend, sid: string, streamId: string): Promise<{ rows: JournalEvent[]; summary: RunSummary | null }> {
  const rows = await storage.journals.readRunEvents(sid, streamId)
  const summary = rows.length ? null : await storage.journals.summary(sid, streamId)
  return { rows, summary: summary?.journal_pruned ? summary : null }
}

/** Every item the copy covers, listed from the source. */
async function inventory(source: StorageBackend) {
  const sessions = [...await source.sessions.ids({ strict: true })].sort()
  const documents: [string, string][] = []
  for (const namespace of DOCUMENT_NAMESPACES) for (const { key } of await source.documents.list(namespace)) documents.push([namespace, key])
  const runs: [string, string][] = []
  for (const sid of await source.journals.sessionIds()) for (const streamId of await source.journals.streams(sid)) runs.push([sid, streamId])
  return { sessions, documents, runs, tombstones: [...await source.sessions.tombstones.all()].sort() }
}

/**
 * Copies every session (document and messages), shrink backup, tombstone, the session index, every document and every
 * journal stream and summary from `source` to `destination`. Items whose fingerprint already matches are skipped, so a
 * re-run copies only what is missing or different. The source is only read.
 */
export async function copyStorage(source: StorageBackend, destination: StorageBackend): Promise<CopyReport> {
  const report: CopyReport = { copied: 0, unchanged: 0, failures: [] }
  const items = await inventory(source)
  const step = async (label: string, same: () => Promise<boolean>, copy: () => Promise<unknown>): Promise<void> => {
    try {
      if (await same()) { report.unchanged += 1; return }
      await copy()
      report.copied += 1
    } catch (error) { report.failures.push(`${label}: ${(error as Error).message}`) }
  }
  const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)
  for (const sid of items.sessions) {
    await step(`session ${sid}`, async () => equal(await fingerprints.session(source, sid), await fingerprints.session(destination, sid)), async () => {
      const stored = await source.sessions.readDocument(sid)
      if (!stored) return
      await destination.sessions.write(sid, { doc: stored.doc, messages: { kind: 'replace', rows: stored.messages } }, await destination.sessions.revision(sid))
    })
    // A replacing write may leave a destination backup the source does not have; the source's state wins.
    await step(`shrink backup ${sid}`, async () => equal(await fingerprints.backup(source, sid), await fingerprints.backup(destination, sid)), async () => {
      const backup = await source.sessions.shrinkBackup.read(sid)
      await (backup ? destination.sessions.shrinkBackup.write(sid, backup) : destination.sessions.shrinkBackup.discard(sid))
    })
  }
  for (const sid of items.tombstones) await step(`tombstone ${sid}`, () => destination.sessions.tombstones.has(sid), () => destination.sessions.tombstones.add(sid))
  if (await source.sessions.hasIndex()) {
    const entries = (await source.sessions.index()).entries
    await step('session index', async () => await destination.sessions.hasIndex() && equal(entries, (await destination.sessions.index()).entries), () => destination.sessions.writeIndex(entries))
  }
  for (const [namespace, key] of items.documents) {
    await step(`document ${namespace}/${key}`, async () => equal(await fingerprints.document(source, namespace, key), await fingerprints.document(destination, namespace, key)), async () => {
      const stored = await source.documents.get(namespace, key)
      if (!stored) return
      let current: string | null
      try { current = (await destination.documents.get(namespace, key))?.revision ?? null } catch (error) { if (!(error instanceof InvalidDocument)) throw error; current = error.revision }
      await destination.documents.put(namespace, key, stored.value, current)
    })
  }
  for (const [sid, streamId] of items.runs) {
    await step(`journal ${sid}/${streamId}`, async () => equal(await fingerprints.run(source, sid, streamId), await fingerprints.run(destination, sid, streamId)), async () => destination.journals.importRun(sid, streamId, await readRun(source, sid, streamId)))
  }
  return report
}

/** Re-reads every source item from both stores; each entry names an item whose destination copy differs. */
export async function verifyStorage(source: StorageBackend, destination: StorageBackend): Promise<string[]> {
  const mismatches: string[] = []
  const items = await inventory(source)
  const compare = async (label: string, read: (storage: StorageBackend) => Promise<unknown>): Promise<void> => {
    try { if (canonical(await read(source)) !== canonical(await read(destination))) mismatches.push(label) } catch (error) { mismatches.push(`${label}: ${(error as Error).message}`) }
  }
  for (const sid of items.sessions) {
    await compare(`session ${sid}`, (storage) => fingerprints.session(storage, sid))
    await compare(`shrink backup ${sid}`, (storage) => fingerprints.backup(storage, sid))
  }
  if (await source.sessions.hasIndex()) await compare('session index', async (storage) => await storage.sessions.hasIndex() ? (await storage.sessions.index()).entries : null)
  const tombstones = await destination.sessions.tombstones.all()
  for (const sid of items.tombstones) if (!tombstones.has(sid)) mismatches.push(`tombstone ${sid}`)
  for (const [namespace, key] of items.documents) await compare(`document ${namespace}/${key}`, (storage) => fingerprints.document(storage, namespace, key))
  for (const [sid, streamId] of items.runs) await compare(`journal ${sid}/${streamId}`, (storage) => fingerprints.run(storage, sid, streamId))
  return mismatches
}
