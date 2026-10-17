import { InvalidDocument, RevisionConflict, type DocumentBackend, type StoredDocument } from './backend.js'

/** Shared read/modify/write transaction; retry the edit once against the winning revision. */
const documentOperations = new WeakMap<DocumentBackend, Map<string, Promise<void>>>()

export function updateDocument<T>(backend: DocumentBackend, namespace: string, key: string, edit: (value: unknown) => { value: unknown; result: T; skip?: boolean } | Promise<{ value: unknown; result: T; skip?: boolean }>, opts: { replaceInvalid?: boolean } = {}): Promise<T> {
  let operations = documentOperations.get(backend)
  if (!operations) { operations = new Map(); documentOperations.set(backend, operations) }
  const id = JSON.stringify([namespace, key])
  const result = (operations.get(id) ?? Promise.resolve()).then(async () => {
    for (let attempt = 0; ; attempt += 1) {
      const current = await readDocument(backend, namespace, key, opts)
      const before = current && JSON.stringify(current.value)
      const next = await edit(current?.value)
      if (next.skip || (current && before === JSON.stringify(next.value))) return next.result
      try {
        await backend.put(namespace, key, next.value, current?.revision ?? null)
        return next.result
      } catch (error) { if (!(error instanceof RevisionConflict) || attempt >= 1) throw error }
    }
  })
  const settled = result.then(() => { /* release for the next edit */ }, () => { /* a failed edit does not poison the queue */ })
  operations.set(id, settled)
  void settled.then(() => { if (operations.get(id) === settled) operations.delete(id) })
  return result
}

export async function readDocument(backend: DocumentBackend, namespace: string, key: string, opts: { replaceInvalid?: boolean; maxBytes?: number } = {}): Promise<StoredDocument | null> {
  try { return await (opts.maxBytes === undefined ? backend.get(namespace, key) : backend.get(namespace, key, { maxBytes: opts.maxBytes })) } catch (error) {
    if (opts.replaceInvalid && error instanceof InvalidDocument && error.reason === 'invalid') return { value: null, revision: error.revision }
    throw error
  }
}
