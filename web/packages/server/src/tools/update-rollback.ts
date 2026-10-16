/** Shared on-disk handoff between the updater and its known-good supervisor. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface UpdateRollback {
  version: string
  previousVersion: string
  failedVersion?: string
}

export function rollbackPaths(packageRoot: string, stateDir: string) {
  return {
    previous: join(dirname(packageRoot), '.talaria-web-previous'),
    failed: join(dirname(packageRoot), '.talaria-web-failed'),
    marker: join(stateDir, 'update-rollback.json'),
  }
}

export function readUpdateRollback(stateDir: string | undefined): UpdateRollback | null {
  if (!stateDir) return null
  try {
    const value: unknown = JSON.parse(readFileSync(join(stateDir, 'update-rollback.json'), 'utf8'))
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (typeof record.version !== 'string' || !record.version || typeof record.previousVersion !== 'string' || !record.previousVersion
      || (record.failedVersion !== undefined && typeof record.failedVersion !== 'string')) return null
    return { version: record.version, previousVersion: record.previousVersion, ...(typeof record.failedVersion === 'string' ? { failedVersion: record.failedVersion } : {}) }
  } catch { return null }
}
