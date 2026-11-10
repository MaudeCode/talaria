/**
 * TAL-1969: `request_secret`. The agent asks for a credential by its `.env` name and purpose; the session shows an
 * `agent_secret` vault prompt; the server owner's answer goes straight to the profile `.env` through the same write the
 * plugin settings secrets use (TAL-806), and the agent learns only the outcome. The value never reaches the sidecar's
 * waiting tool, the transcript or a stream, and the redactor masks it from the moment it is saved.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SidecarServerParams, SidecarServerResultInput } from '@maudecode/talaria-web-contracts'
import type { AppDeps } from '../http/context.js'
import type { DocumentBackend } from './storage/backend.js'
import { updateDocument } from './storage/document.js'
import { HttpFailure } from './service.js'
import { AGENT_PROMPT_DEFAULT_TIMEOUT_SECONDS } from './pending.js'
import { EnvWriteError, loadEnvFile } from '../providers/env-file.js'
import { writeRuntimeCredential } from '../providers/runtime-env.js'
import { addKnownSecret } from '../redact.js'
import { credentialEnvName } from '../cli/dotenv.js'
import { str } from '../util.js'

export const AGENT_SECRET_ENV_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/
export const AGENT_SECRET_PURPOSE_MAX = 500

/**
 * An agent asks only for a credential's name (`credentialEnvName`, the launcher's rule): anything else in the profile `.env`
 * can load code or steer the shell, the terminal or a launch. Talaria's, the Agent's and the terminal's own credentials
 * and the gateway API server's key stay the owner's to set.
 */
const RESERVED_PREFIXES = ['HERMES_', 'TALARIA_', 'TERMINAL_', 'API_SERVER_']

export const requestableEnvName = (name: string): boolean => credentialEnvName(name) && !RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))

/** The session `request_secret` acts for: the caller's own. */
export interface SecretCaller { session_id: string; profile?: string | null }
type Result = SidecarServerResultInput<'server.secret_request'>
type Params = Omit<SidecarServerParams<'server.secret_request'>, 'caller_session_id'>

interface Waiter {
  sid: string
  profile: string
  envName: string
  existedBefore: boolean
  /** Settle the agent's call: an outcome, or the refusal it receives as an error. */
  settle: (outcome: Result['outcome'] | HttpFailure) => void
}

const refuse = (status: number, condition: string, message: string): HttpFailure => new HttpFailure(status, message, { code: condition })
/** Names saved per profile, so a restarted server masks their values again. */
const NAMESPACE = 'agent-secrets'

export class SecretRequests {
  private readonly waiting = new Map<string, Waiter>()

  constructor(private readonly documents: DocumentBackend, private readonly deps: () => AppDeps, private readonly now: () => number) {}

  private home(profile: string): string {
    return this.deps().profileHome(profile)
  }

  /** Mask every saved name's current value again (server start). */
  async load(): Promise<void> {
    for (const { key } of await this.documents.list(NAMESPACE)) {
      const names = (await this.documents.get(NAMESPACE, key))?.value
      if (!Array.isArray(names)) continue
      const values = loadEnvFile(join(this.home(key), '.env'))
      for (const name of names) if (typeof name === 'string' && values[name]) addKnownSecret(values[name])
    }
  }

  /** The `agent_secret` prompt this server answers itself, if `clarifyId` is one. */
  owns(clarifyId: string): boolean {
    return this.waiting.has(clarifyId)
  }

  /** `request_secret`: refuse a bad name before any prompt, then wait for the owner's answer, a decline or the timeout. */
  request(caller: SecretCaller, params: Params): Promise<Result> {
    const envName = params.env_name.trim()
    if (!AGENT_SECRET_ENV_NAME_RE.test(envName)) return Promise.reject(refuse(400, 'env_name_invalid', `env_name must be 3 to 64 capital letters, digits or underscores, starting with a letter; got ${JSON.stringify(envName.slice(0, 80))}`))
    if (!requestableEnvName(envName)) return Promise.reject(refuse(400, 'env_name_reserved', `${envName} is not a credential name you may ask for: use the service's own name ending in _KEY, _TOKEN or _SECRET, outside HERMES_, TALARIA_, TERMINAL_ and API_SERVER_`))
    const purpose = params.purpose.trim()
    if (!purpose) return Promise.reject(refuse(400, 'purpose_required', 'purpose is required: say what the secret is for'))
    if (purpose.length > AGENT_SECRET_PURPOSE_MAX) return Promise.reject(refuse(400, 'purpose_too_long', `purpose is longer than ${AGENT_SECRET_PURPOSE_MAX} characters`))
    const deps = this.deps()
    const sid = caller.session_id
    const profile = caller.profile || 'default'
    const existedBefore = Object.hasOwn(loadEnvFile(join(this.home(profile), '.env')), envName)
    const timeout = params.timeout_seconds ?? AGENT_PROMPT_DEFAULT_TIMEOUT_SECONDS
    const clarifyId = randomUUID().replace(/-/g, '')
    return new Promise<Result>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const settle = (outcome: Result['outcome'] | HttpFailure): void => {
        if (!this.waiting.delete(clarifyId)) return
        clearTimeout(timer)
        if (outcome instanceof HttpFailure) reject(outcome)
        else resolve({ env_name: envName, outcome, existed_before: existedBefore })
      }
      this.waiting.set(clarifyId, { sid, profile, envName, existedBefore, settle })
      // Cleared with its turn (a Stop, the session closing) or dropped: the agent hears it went unanswered.
      deps.pending.onClarifyRemoved(clarifyId, () => { settle('declined') })
      deps.pending.submitClarify(sid, { kind: 'agent_secret', clarify_id: clarifyId, session_id: sid, requested_at: this.now(), timeout_seconds: timeout, env_name: envName, purpose, optional: params.optional === true, existed_before: existedBefore })
      void this.announce(sid)
      if (timeout > 0) timer = setTimeout(() => { settle('timed_out'); void this.close(sid, clarifyId) }, timeout * 1000)
    })
  }

  /**
   * The owner's answer to `clarifyId` (null or blank declines). A save writes the profile `.env`; a refused write leaves it
   * as it was and the agent receives the reason. Either way the prompt is answered.
   */
  async answer(sid: string, clarifyId: string, value: string | null): Promise<void> {
    const waiter = this.waiting.get(clarifyId)
    if (waiter?.sid !== sid) throw new HttpFailure(409, 'Clarification prompt expired or not found. The agent may have already proceeded.', { ok: false, stale: true })
    if (!value?.trim()) {
      waiter.settle('declined')
      await this.close(waiter.sid, clarifyId)
      return
    }
    // Answered once: a second click while the write runs is stale.
    this.waiting.delete(clarifyId)
    let failure: HttpFailure | null = null
    try {
      await this.write(waiter, value)
    } catch (error) {
      failure = error instanceof HttpFailure ? error : error instanceof EnvWriteError ? refuse(error.status, error.condition, `The secret was not saved: ${error.message}`) : refuse(503, 'env_write_failed', `The secret was not saved: ${str((error as Error).message)}`)
    }
    this.waiting.set(clarifyId, waiter)
    waiter.settle(failure ?? 'saved')
    await this.close(waiter.sid, clarifyId)
    if (failure) throw failure
  }

  private async write(waiter: Waiter, value: string): Promise<void> {
    const deps = this.deps()
    const home = this.home(waiter.profile)
    // The card said whether it replaces a value; a value set since then is not replaced unannounced. Checked inside the
    // serialized credential edit, so an overlapping save of the same name cannot slip in between.
    const unchanged = (): void => {
      if (!waiter.existedBefore && Object.hasOwn(loadEnvFile(join(home, '.env')), waiter.envName)) {
        throw refuse(409, 'env_name_changed', `${waiter.envName} was set after the prompt said it was new, so it was not replaced; ask again`)
      }
    }
    await writeRuntimeCredential({ env: deps.config.env, sidecar: deps.sidecar, log: deps.log }, deps.isRootProfile(waiter.profile), home, waiter.envName, value, unchanged)
    addKnownSecret(value)
    await updateDocument(this.documents, NAMESPACE, waiter.profile, (stored) => {
      const names = Array.isArray(stored) ? stored.filter((name): name is string => typeof name === 'string') : []
      return names.includes(waiter.envName) ? { value: names, result: undefined, skip: true } : { value: [...names, waiter.envName], result: undefined }
    }).catch((error: unknown) => { deps.log(`[secrets] could not record ${waiter.envName} for redaction after a restart: ${str((error as Error).message)}`) })
  }

  private async close(sid: string, clarifyId: string): Promise<void> {
    this.deps().pending.resolveClarify(sid, clarifyId)
    await this.announce(sid)
  }

  private async announce(sid: string): Promise<void> {
    await this.deps().turns.announceClarifyHead(sid).catch(() => undefined)
  }
}
