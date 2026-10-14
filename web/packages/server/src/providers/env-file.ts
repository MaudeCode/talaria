/** `~/.hermes/.env` reader (Python `api/providers.py` `_load_env_file`) and the sidecar-backed writer. */
import { existsSync, readFileSync } from 'node:fs'
import { RPC_ERROR_CODES } from '@maudecode/talaria-web-contracts'
import { SidecarError, type SidecarLike } from '../sidecar/client.js'

export function loadEnvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {}
  if (!existsSync(path)) return values
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const idx = line.indexOf('=')
    values[line.slice(0, idx).trim()] = stripQuotes(line.slice(idx + 1).trim())
  }
  return values
}

function stripQuotes(v: string): string {
  return v.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '')
}

export class EnvWriteError extends Error {
  constructor(message: string, readonly status: number, readonly condition: string) {
    super(message)
  }
}

const ENV_WRITE_STATUS: Record<string, number> = { env_locked: 503, env_write_refused: 409, sidecar_unavailable: 503 }

/**
 * Upsert `updates` into `<profileHome>/.env` (a `null` value removes the key) through the Agent's own locked writer, so
 * a concurrent gateway, CLI or plugin write cannot drop the change (TAL-797). Comments, blank lines and key order
 * survive; an empty value is skipped, a value the Agent would strip or quote is refused, and the file ends 0600.
 */
export async function writeProfileEnv(sidecar: SidecarLike | null, profileHome: string, updates: Record<string, string | null>): Promise<void> {
  if (!sidecar) throw new EnvWriteError('The Agent sidecar is not running, so the .env change was not saved.', 503, 'sidecar_unavailable')
  try {
    await sidecar.call('config.env_write', { profile_home: profileHome, updates })
  } catch (error) {
    if (!(error instanceof SidecarError)) throw error
    throw new EnvWriteError(error.message, ENV_WRITE_STATUS[error.condition] ?? (error.code === RPC_ERROR_CODES.invalidParams ? 400 : 502), error.condition)
  }
}
