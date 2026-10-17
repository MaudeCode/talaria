import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const CHANNEL_SWITCH_BACKUPS = 5
/** Web's persisted stores (`settings.json`, the project store, the workspace store) as seen from the state dir. */
const PERSISTED_STORES = ['settings.json', 'projects.json', 'workspaces.json', 'last_workspace.txt']

/** Copy the persisted stores to `<stateDir>/backups/channel-switch-<UTC timestamp>/`, keeping the newest few; throws on failure. */
export function backupPersistedStores(stateDir: string, now: Date = new Date(), keep = CHANNEL_SWITCH_BACKUPS): string {
  const root = join(stateDir, 'backups')
  mkdirSync(root, { recursive: true })
  const name = `channel-switch-${now.toISOString().replace(/[:.]/g, '-')}`
  const target = join(root, name)
  if (existsSync(target)) throw new Error(`${name} already exists`)
  // Only a complete copy is published under the name that counts toward the retained backups.
  const partial = mkdtempSync(join(root, `.${name}-`))
  try {
    for (const store of PERSISTED_STORES) if (existsSync(join(stateDir, store))) copyFileSync(join(stateDir, store), join(partial, store))
    renameSync(partial, target)
  } catch (error) {
    rmSync(partial, { recursive: true, force: true })
    throw error
  }
  const backups = readdirSync(root).filter((name) => name.startsWith('channel-switch-')).sort()
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) rmSync(join(root, old), { recursive: true, force: true })
  return target
}
