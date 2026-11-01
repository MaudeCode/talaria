import { createHash } from 'node:crypto'
import type { JournalEvent, RunSummary } from '../journal.js'
import { InvalidDocument, type StorageBackend } from './backend.js'
import { DOCUMENT_NAMESPACES } from './json-documents.js'

/** What one `talaria-web storage copy` pass wrote or removed, what already matched, and what could not be copied. */
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

/** Every item a store holds that the copy covers. */
async function inventory(storage: StorageBackend) {
  const sessions = [...await storage.sessions.ids({ strict: true })].sort()
  const documents: [string, string][] = []
  for (const namespace of DOCUMENT_NAMESPACES) for (const { key } of await storage.documents.list(namespace)) documents.push([namespace, key])
  const runs: [string, string][] = []
  for (const sid of await storage.journals.sessionIds()) for (const streamId of await storage.journals.streams(sid)) runs.push([sid, streamId])
  return { sessions, documents, runs, tombstones: [...await storage.sessions.tombstones.all()].sort() }
}
type Inventory = Awaited<ReturnType<typeof inventory>>

/** What the destination holds that the source does not; a copy removes it, so the destination mirrors the source. */
async function extras(source: Inventory, destination: StorageBackend) {
  const held = await inventory(destination)
  const pair = (items: [string, string][]): Set<string> => new Set(items.map((item) => item.join('/')))
  const sourceDocuments = pair(source.documents)
  const sourceRuns = pair(source.runs)
  return {
    sessions: held.sessions.filter((sid) => !source.sessions.includes(sid)),
    tombstones: held.tombstones.filter((sid) => !source.tombstones.includes(sid)),
    documents: held.documents.filter((item) => !sourceDocuments.has(item.join('/'))),
    runs: held.runs.filter((item) => !sourceRuns.has(item.join('/'))),
  }
}

/**
 * Source state no destination can hold: a backup whose session is gone (`orphan_backup`). Recovery can still restore
 * it, so the copy refuses to approve the move until it is resolved.
 */
async function unresolved(source: StorageBackend): Promise<string[]> {
  return (await source.sessions.diagnose()).filter((issue) => issue.kind === 'orphan_backup' || issue.kind === 'malformed_orphan_backup')
    .map((issue) => `backup ${issue.session_id}: its session is missing; restore it with session recovery or remove the backup before copying`)
}

/**
 * Copies every session (document and messages), shrink backup, tombstone, the session index, every document and every
 * journal stream and summary from `source` to `destination`, and removes what only the destination holds, so the
 * destination mirrors the source. Items whose fingerprint already matches are skipped, so a re-run changes only what is
 * missing or different. The source is only read.
 */
export async function copyStorage(source: StorageBackend, destination: StorageBackend): Promise<CopyReport> {
  const report: CopyReport = { copied: 0, unchanged: 0, failures: await unresolved(source) }
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
  const stale = await extras(items, destination)
  const remove = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try { await run(); report.copied += 1 } catch (error) { report.failures.push(`${label}: ${(error as Error).message}`) }
  }
  // Deleted here rather than restored from a tombstone: a session the source dropped must not come back.
  for (const sid of stale.sessions) await remove(`session ${sid}`, () => destination.sessions.delete(sid, { tombstone: false }))
  for (const sid of stale.tombstones) await remove(`tombstone ${sid}`, () => destination.sessions.tombstones.remove(sid))
  for (const [namespace, key] of stale.documents) await remove(`document ${namespace}/${key}`, () => destination.documents.delete(namespace, key))
  for (const [sid, streamId] of stale.runs) await remove(`journal ${sid}/${streamId}`, () => destination.journals.importRun(sid, streamId, { rows: [], summary: null }))
  return report
}

/** Re-reads every source item from both stores; each entry names an item whose destination copy differs, or one only the destination holds. */
export async function verifyStorage(source: StorageBackend, destination: StorageBackend): Promise<string[]> {
  const mismatches = await unresolved(source)
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
  const stale = await extras(items, destination)
  mismatches.push(...stale.sessions.map((sid) => `extra session ${sid}`), ...stale.tombstones.map((sid) => `extra tombstone ${sid}`),
    ...stale.documents.map((item) => `extra document ${item.join('/')}`), ...stale.runs.map((item) => `extra journal ${item.join('/')}`))
  return mismatches
}
