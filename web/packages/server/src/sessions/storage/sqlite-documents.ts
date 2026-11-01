/* eslint-disable @typescript-eslint/require-await -- node:sqlite is synchronous; each transaction completes before its promise resolves. */
import { InvalidDocument, RevisionConflict, type DocumentBackend, type StoredDocument } from './backend.js'
import { DOCUMENT_NAMESPACES, validateDocumentKey } from './json-documents.js'
import { nextRevision, type SqliteDb } from './sqlite-db.js'

/** Revisioned documents in the `documents` table, with the JSON adapter's namespace and key rules. */
export class SqliteDocuments implements DocumentBackend {
  constructor(private readonly db: SqliteDb) {}
  private current(namespace: string, key: string): { value: string; revision: number } | undefined {
    this.db.check()
    validateDocumentKey(namespace, key)
    return this.db.get('SELECT value, revision FROM documents WHERE ns = ? AND key = ?', namespace, key)
  }
  async get(namespace: string, key: string, opts: { maxBytes?: number } = {}): Promise<StoredDocument | null> {
    const row = this.current(namespace, key)
    if (!row) return null
    const revision = String(row.revision)
    if (opts.maxBytes !== undefined && Buffer.byteLength(row.value) > opts.maxBytes) throw new InvalidDocument(revision, new Error('Document byte limit exceeded'), 'too-large')
    try { return { value: JSON.parse(row.value) as unknown, revision } } catch (error) { throw new InvalidDocument(revision, error) }
  }
  async put(namespace: string, key: string, value: unknown, expected: string | null): Promise<string> {
    validateDocumentKey(namespace, key)
    const text = JSON.stringify(value) as string | undefined
    if (text === undefined) throw new Error('Document must be serializable')
    return this.db.transaction(() => {
      const current = this.current(namespace, key)
      if ((current ? String(current.revision) : null) !== expected) throw new RevisionConflict(`${namespace}/${key}`)
      const revision = nextRevision(current?.revision ?? null)
      this.db.run('INSERT INTO documents (ns, key, value, revision) VALUES (?, ?, ?, ?) ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value, revision = excluded.revision', namespace, key, text, revision)
      return String(revision)
    })
  }
  async delete(namespace: string, key: string, expected?: string | null): Promise<boolean> {
    return this.db.transaction(() => {
      const current = this.current(namespace, key)
      if (expected !== undefined && (current ? String(current.revision) : null) !== expected) throw new RevisionConflict(`${namespace}/${key}`)
      if (!current) return false
      this.db.run('DELETE FROM documents WHERE ns = ? AND key = ?', namespace, key)
      return true
    })
  }
  async list(namespace: string): Promise<{ key: string; revision: string }[]> {
    this.db.check()
    if (!DOCUMENT_NAMESPACES.includes(namespace)) throw new Error(`Unknown document namespace ${namespace}`)
    return this.db.all<{ key: string; revision: number }>('SELECT key, revision FROM documents WHERE ns = ? ORDER BY key', namespace).map((r) => ({ key: r.key, revision: String(r.revision) }))
  }
}
