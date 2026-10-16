import { join } from 'node:path'
import { JsonStorage } from '../sessions/storage/json.js'
import type { SessionStore } from '../sessions/store.js'

/** Direct file access is limited to tests of JSON compatibility and external edits. */
export function sessionDirectory(store: SessionStore): string {
  if (!(store.deps.storage instanceof JsonStorage)) throw new Error('This fixture requires JSON storage')
  return store.deps.storage.directory
}
export const sessionPath = (store: SessionStore, sid: string): string => join(sessionDirectory(store), `${sid}.json`)
export const sessionIndexPath = (store: SessionStore): string => join(sessionDirectory(store), '_index.json')
