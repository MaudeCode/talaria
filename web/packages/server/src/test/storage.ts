import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { JsonStorage } from '../sessions/storage/json.js'
import type { SessionStore } from '../sessions/store.js'

/**
 * For a test file that reads or writes JSON storage files directly: its servers use the JSON backend even when the run
 * selects another with `TALARIA_STORAGE` (TAL-1066).
 */
export function useJsonStorage(): void {
  let previous: string | undefined
  beforeAll(() => { previous = process.env.TALARIA_STORAGE; process.env.TALARIA_STORAGE = 'json' })
  afterAll(() => { if (previous === undefined) delete process.env.TALARIA_STORAGE; else process.env.TALARIA_STORAGE = previous })
}

/** Direct file access is limited to tests of JSON compatibility and external edits. */
export function sessionDirectory(store: SessionStore): string {
  if (!(store.deps.storage instanceof JsonStorage)) throw new Error('This fixture requires JSON storage')
  return store.deps.storage.directory
}
export const sessionPath = (store: SessionStore, sid: string): string => join(sessionDirectory(store), `${sid}.json`)
export const sessionIndexPath = (store: SessionStore): string => join(sessionDirectory(store), '_index.json')

import { JsonDocuments } from '../sessions/storage/json-documents.js'
export { JsonDocuments }

export async function initializeStore<T extends { initialize(): Promise<void> }>(store: T): Promise<T> {
  await store.initialize()
  return store
}

import { JsonJournal } from '../sessions/storage/json-journal.js'
import type { JournalBackend } from '../sessions/storage/backend.js'
export function jsonJournal(journal: JournalBackend): JsonJournal {
  if (!(journal instanceof JsonJournal)) throw new Error('This fixture requires JSON journals')
  return journal
}

import { profileIdentity } from '../sessions/relay.js'
export async function testProfileIdentity(home: string): Promise<string> { return (await profileIdentity({ documents: new JsonDocuments(join(home, 'webui'), () => home), profileHome: () => home }, 'default')) }

export function testSessionDocuments(directory: string): JsonDocuments { return new JsonDocuments(directory, undefined, directory) }
