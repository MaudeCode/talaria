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
  ids(): Promise<Set<string>>
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
  close(): Promise<void>
}
