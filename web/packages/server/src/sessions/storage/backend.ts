import type { JournalEvent, RunSummary, PruneOptions, PruneResult } from '../journal.js'
import type { RecoveryAuditItem } from '@maudecode/talaria-web-contracts'
import type { Message } from '../session.js'

export type SessionDocument = Record<string, unknown>
export type SessionIndexEntry = Record<string, unknown>
export interface StoredSession {
  doc: SessionDocument
  messageCount: number | null
  revision: string | null
  /** Older documents without a reliable count need a full load. */
  metadataOnly: boolean
}
export interface SessionChange {
  doc: SessionDocument
  messages:
    | { kind: 'unchanged' }
    | { kind: 'append'; rows: Message[] }
    | { kind: 'splice'; from: number; deleteCount: number; rows: Message[] }
    | { kind: 'replace'; rows: Message[] }
  /** The complete message list after the change, when the writer holds it; a backend may use it instead of re-reading its base. */
  all?: Message[]
}
export interface MessageMatch { idx: number; text: string }
export type StorageIssue = RecoveryAuditItem & { profile?: string; revision?: string | null; backupRevision?: string | null }

export class RevisionConflict extends Error {
  constructor(readonly sid: string) {
    super(`Session ${sid} changed since it was read`)
    this.name = 'RevisionConflict'
  }
}

export interface SessionBackend {
  exists(sid: string): Promise<boolean>
  revision(sid: string): Promise<string | null>
  readDocument(sid: string, opts?: { metadataOnly?: boolean }): Promise<StoredSession | null>
  readMessages(sid: string, range: { start: number; end: number }): Promise<Message[]>
  searchMessages(sids: readonly string[], terms: readonly string[], depth: number): Promise<Map<string, MessageMatch>>
  write(sid: string, change: SessionChange, expected: string | null): Promise<string>
  delete(sid: string, opts: { tombstone: boolean }): Promise<boolean>
  /** `strict` rethrows a directory read failure instead of answering with no sessions. */
  ids(opts?: { strict?: boolean }): Promise<Set<string>>
  index(): Promise<{ entries: SessionIndexEntry[]; revision: string }>
  writeIndex(entries: SessionIndexEntry[]): Promise<void>
  hasIndex(): Promise<boolean>
  tombstones: {
    has(sid: string): Promise<boolean>
    add(sid: string): Promise<void>
    remove(sid: string): Promise<void>
    all(): Promise<Set<string>>
  }
  shrinkBackup: { discard(sid: string): Promise<void>; restore(sid: string): Promise<boolean> }
  diagnose(): Promise<StorageIssue[]>
  repair(issue: StorageIssue): Promise<boolean>
}

export interface StorageBackend {
  readonly kind: string
  readonly sessions: SessionBackend
  readonly documents: DocumentBackend
  readonly journals: JournalBackend
  close(): Promise<void>
}


export interface StoredDocument { value: unknown; revision: string }
export interface DocumentBackend {
  get(namespace: string, key: string, opts?: { maxBytes?: number }): Promise<StoredDocument | null>
  put(namespace: string, key: string, value: unknown, expected: string | null): Promise<string>
  delete(namespace: string, key: string, expected?: string | null): Promise<boolean>
  list(namespace: string): Promise<{ key: string; revision: string }[]>
}

/** A malformed document still has an identity, so permissive stores can explicitly replace it with CAS. */
export class InvalidDocument extends Error {
  constructor(readonly revision: string, cause: unknown, readonly reason: 'invalid' | 'too-large' = 'invalid') { super(reason === 'too-large' ? 'Stored document exceeds byte limit' : 'Invalid stored document', { cause }) }
}

export interface JournalInput { event: string; payload: unknown; redacted?: boolean; created_at?: number }
export interface JournalEventMeta { redacted?: boolean; createdAt?: number }
export interface JournalWriter {
  readonly sessionId: string
  readonly runId: string
  append(row: JournalInput, opts: { terminal: boolean }): Promise<JournalEvent>
  appendSseEvent(event: string, payload: unknown, meta?: JournalEventMeta): Promise<JournalEvent>
  close(): Promise<void>
}
export interface SessionJournalReplay { status: string; events: JournalEvent[]; cursor_run_id: string | null; cursor_seq: number | null }
export interface JournalBackend {
  open(sid: string, streamId: string, opts: { durability: 'eager' | 'terminal-only' }): Promise<JournalWriter>
  read(sid: string, streamId: string, fromSeq: number): AsyncIterable<JournalEvent>
  streams(sid: string): Promise<string[]>
  sessionIds(): Promise<string[]>
  recoveryEvents(): Promise<Map<string, Record<string, unknown>[]>>
  prune(olderThan: number): Promise<number>
  pruneSettled(opts?: PruneOptions): Promise<PruneResult>
  summary(sid: string, streamId: string): Promise<RunSummary | null>
  deleteSession(sid: string): Promise<boolean>
  writer(sid: string, streamId: string): Promise<JournalWriter>
  readRunEvents(sid: string, streamId: string, opts?: { afterSeq?: number | null; maxSeq?: number | null }): Promise<JournalEvent[]>
  iterRunEvents(sid: string, streamId: string, opts?: { afterSeq?: number | null; maxSeq?: number | null }): AsyncGenerator<JournalEvent>
  readRunEventTail(sid: string, streamId: string, maxBytes?: number, maxRows?: number): Promise<{ events: JournalEvent[]; truncated: boolean }>
  latestRunSummary(sid: string, streamId: string): Promise<RunSummary>
  findRunSummary(streamId: string): Promise<RunSummary | null>
  sessionJournalFingerprint(sid: string): Promise<string>
  readSessionRunEvents(sid: string, cursor: string | null | undefined): Promise<SessionJournalReplay>
  staleInterruptedEvent(sid: string, streamId: string, afterSeq?: number | null, now?: number): Promise<JournalEvent | null>
  close(): Promise<void>
}
