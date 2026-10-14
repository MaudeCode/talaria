/**
 * Keeps the default profile's `.env` edits in step with the running process and
 * the Agent sidecar. `loadStartupEnv` copied that file into the process
 * environment (and the sidecar inherited it), so a key written or removed
 * through the UI must reach both — first the sidecar (which has to confirm),
 * then, once the file is written, the process. Values supplied explicitly by
 * the process environment are never touched.
 */
import { homeDotenvKeys, setHomeDotenvKeys } from '../cli/dotenv.js'
import { writeProfileEnv } from './env-file.js'
import type { SidecarLike } from '../sidecar/client.js'
import { str } from '../util.js'

export class RuntimeCredentialError extends Error {}

export interface RuntimeCredentialEdit { commit: () => void; rollback: () => Promise<void> }
const NO_EDIT: RuntimeCredentialEdit = { commit: () => undefined, rollback: () => Promise.resolve() }

export interface RuntimeEnvDeps { env: Record<string, string | undefined>; sidecar: () => SidecarLike | null; log: (line: string) => void }

/**
 * Prepare a root-profile credential edit: the sidecar applies it now (throws `RuntimeCredentialError` when it does not
 * confirm); `commit` records it in the process environment after the file write; `rollback` restores the sidecar's
 * previous value if the write fails, recycling the child when even that cannot be confirmed.
 */
/** A root-profile credential the process environment supplied explicitly: it keeps precedence over the file, as at startup. */
export function credentialShadowed(env: Record<string, string | undefined>, rootProfile: boolean, envVar: string): boolean {
  return rootProfile && !homeDotenvKeys(env).has(envVar) && env[envVar] !== undefined
}

export async function prepareRuntimeCredentialEdit(deps: RuntimeEnvDeps, rootProfile: boolean, envVar: string, apiKey: string | null): Promise<RuntimeCredentialEdit> {
  if (!rootProfile) return NO_EDIT
  const { env } = deps
  if (credentialShadowed(env, rootProfile, envVar)) return NO_EDIT
  const previous = env[envVar]
  const sidecar = deps.sidecar()
  if (sidecar) {
    try {
      await sidecar.call('runtime.env', apiKey ? { set: { [envVar]: apiKey } } : { unset: [envVar] })
    } catch (error) {
      throw new RuntimeCredentialError(`The Agent sidecar did not apply the credential change (${str((error as Error).message)}); retry in a moment`)
    }
  }
  return {
    commit: () => {
      // Merge into the ownership set as it is now: an overlapping edit of another key may have committed meanwhile.
      const current = homeDotenvKeys(env)
      if (apiKey) { env[envVar] = apiKey; current.add(envVar) } else { Reflect.deleteProperty(env, envVar); current.delete(envVar) }
      setHomeDotenvKeys(env, current)
    },
    rollback: async () => {
      if (!sidecar) return
      try {
        await sidecar.call('runtime.env', previous === undefined ? { unset: [envVar] } : { set: { [envVar]: previous } })
      } catch (error) {
        // The live child holds an unpersisted credential it can no longer be talked out of: recycle it so the
        // replacement starts from the unchanged server environment instead of serving with the divergent one.
        sidecar.recycle(`sidecar environment for ${envVar} could not be restored after a failed .env write (${str((error as Error).message)})`)
      }
    },
  }
}

// Overlapping edits must not interleave: the sidecar may reply out of apply order, and every caller rewrites the
// same `.env`. One process-wide chain keeps sidecar apply → file write → process commit a single transaction.
// ponytail: global chain; per-credential locks only if credential edits ever contend for throughput.
let credentialEdits: Promise<unknown> = Promise.resolve()

/** Write one credential to `<profileHome>/.env`; a root-profile edit keeps the sidecar and process in step. */
export function writeRuntimeCredential(deps: RuntimeEnvDeps, rootProfile: boolean, profileHome: string, envVar: string, apiKey: string | null): Promise<void> {
  const run = credentialEdits.then(async () => {
    const edit = await prepareRuntimeCredentialEdit(deps, rootProfile, envVar, apiKey)
    try {
      await writeProfileEnv(deps.sidecar(), profileHome, { [envVar]: apiKey })
    } catch (error) {
      await edit.rollback()
      throw error
    }
    edit.commit()
  })
  credentialEdits = run.catch(() => undefined)
  return run
}
