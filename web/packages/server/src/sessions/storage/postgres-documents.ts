import { InvalidDocument, RevisionConflict, type DocumentBackend, type StoredDocument } from './backend.js'
import { DOCUMENT_NAMESPACES, validateDocumentKey } from './json-documents.js'
import { NEXT_REVISION, type PgDb } from './postgres-db.js'

/**
 * Revisioned documents in the `documents` table, with the JSON adapter's namespace and key rules. Values are stored as
 * their JSON text, like the other adapters: `jsonb` would refuse a string holding `\u0000` and re-space the text that
 * byte limits measure.
 */
export class PostgresDocuments implements DocumentBackend {
  constructor(private readonly db: PgDb) {}
  async get(namespace: string, key: string, opts: { maxBytes?: number } = {}): Promise<StoredDocument | null> {
    validateDocumentKey(namespace, key)
    const row = await this.db.row<{ value: string; revision: string }>(`SELECT value, revision FROM ${this.db.s}documents WHERE ns = $1 AND key = $2`, namespace, key)
    if (!row) return null
    if (opts.maxBytes !== undefined && Buffer.byteLength(row.value) > opts.maxBytes) throw new InvalidDocument(row.revision, new Error('Document byte limit exceeded'), 'too-large')
    try { return { value: JSON.parse(row.value) as unknown, revision: row.revision } } catch (error) { throw new InvalidDocument(row.revision, error) }
  }
  /** One transaction holding a conditional insert or update: zero rows changed means `expected` is stale. */
  async put(namespace: string, key: string, value: unknown, expected: string | null): Promise<string> {
    validateDocumentKey(namespace, key)
    const text = JSON.stringify(value) as string | undefined
    if (text === undefined) throw new Error('Document must be serializable')
    return await this.db.transaction(async (tx) => {
      const row = expected === null
        ? await tx.row<{ revision: string }>(`INSERT INTO ${this.db.s}documents (ns, key, value, revision) VALUES ($1, $2, $3, ${NEXT_REVISION('0')}) ON CONFLICT (ns, key) DO NOTHING RETURNING revision`, namespace, key, text)
        : await tx.row<{ revision: string }>(`UPDATE ${this.db.s}documents SET value = $3, revision = ${NEXT_REVISION('revision')} WHERE ns = $1 AND key = $2 AND revision = $4 RETURNING revision`, namespace, key, text, expected)
      if (!row) throw new RevisionConflict(`${namespace}/${key}`)
      return row.revision
    })
  }
  async delete(namespace: string, key: string, expected?: string | null): Promise<boolean> {
    validateDocumentKey(namespace, key)
    return await this.db.transaction(async (tx) => {
      if (expected === undefined) return await tx.run(`DELETE FROM ${this.db.s}documents WHERE ns = $1 AND key = $2`, namespace, key) > 0
      if (expected !== null) {
        if (await tx.run(`DELETE FROM ${this.db.s}documents WHERE ns = $1 AND key = $2 AND revision = $3`, namespace, key, expected) > 0) return true
        throw new RevisionConflict(`${namespace}/${key}`)
      }
      // Deleting an absent document: a present one means the caller's view is stale.
      if (await tx.row(`SELECT 1 FROM ${this.db.s}documents WHERE ns = $1 AND key = $2`, namespace, key)) throw new RevisionConflict(`${namespace}/${key}`)
      return false
    })
  }
  async list(namespace: string): Promise<{ key: string; revision: string }[]> {
    this.db.check()
    if (!DOCUMENT_NAMESPACES.includes(namespace)) throw new Error(`Unknown document namespace ${namespace}`)
    return await this.db.rows<{ key: string; revision: string }>(`SELECT key, revision FROM ${this.db.s}documents WHERE ns = $1 ORDER BY key COLLATE "C"`, namespace)
  }
}
