/**
 * TAL-1967: proposals. An agent asks the owner for a change it may not make itself (a catalog plugin, an MCP server, a
 * setting or a scheduled task); the owner approves or rejects it once, and an approved proposal is applied through the
 * route that owns its kind. One document per proposal in the `proposals` namespace holds the validated payload and what
 * the owner reviewed. The server decides the summary, diff, field list, risk notes, actions, status and outcome.
 */
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  PROPOSAL_KINDS, ProposalIdSchema,
  type DiffLineSchema, type Proposal, type ProposalKind, type SidecarServerParams, type SidecarServerResultInput,
} from '@maudecode/talaria-web-contracts'
import type { z } from 'zod'
import type { AppDeps } from '../http/context.js'
import type { DocumentBackend } from './storage/backend.js'
import { updateDocument } from './storage/document.js'
import { HttpFailure } from './service.js'
import { sendSessionMessage } from './admission.js'
import { agentApprovals, compressionPrepareAhead, maxTokensStatus } from '../config/agent-config.js'
import { loadEnvFile } from '../providers/env-file.js'
import { MASK } from '../tools/mcp.js'

const NAMESPACE = 'proposals'
const LIMITS = { name: 64, text: 2000, title: 200, prompt: 20_000, list: 50, sources: 20 } as const
/** The settings route's keys a proposal may not set: credentials, auth state and values the route itself ignores. */
const SETTING_DENIED = new Set(['password_hash', 'default_model', 'simplified_tool_calling', 'auth_disabled_acknowledged'])
/** `config.yaml` settings the settings route writes, with how the server reads each one's current value. */
const CONFIG_SETTINGS: Record<string, (deps: AppDeps, home: string) => Promise<unknown>> = {
  compression_prepare_ahead: (deps, home) => compressionPrepareAhead(deps.agentConfig, home),
  agent_approvals: (deps, home) => agentApprovals(deps.agentConfig, home),
  max_tokens: async (deps, home) => maxTokensStatus(await deps.agentConfig.read(home)).max_tokens,
}

type DiffLine = z.infer<typeof DiffLineSchema>
type Payload<K extends ProposalKind> = Extract<Proposal, { kind: K }>['payload']
type StoredStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed'
/** A proposal as stored; `review` is what the owner reviewed beyond the payload (a plugin's preview findings). */
export type StoredProposal = Proposal extends infer P ? P extends Proposal ? Omit<P, 'actions' | 'status'> & { status: StoredStatus; review: string } : never : never
/** The session a call acts for: the caller's own (agent tools). */
export interface ProposalCaller { session_id: string; profile?: string | null }
/** Applies an approved proposal through its kind's route and answers the route's result text; a refusal throws. */
export type ProposalApply = (proposal: StoredProposal) => Promise<string>

const refuse = (status: number, condition: string, message: string): HttpFailure => new HttpFailure(status, message, { code: condition })
const notFound = (id: string) => refuse(404, 'proposal_unknown', `no proposal ${id}`)
const invalid = (message: string) => refuse(400, 'payload_invalid', message)
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

function text(value: unknown, field: string, limit: number = LIMITS.text, required = true): string {
  if (value !== undefined && value !== null && typeof value !== 'string') throw invalid(`${field} must be a string`)
  const trimmed = (value ?? '').trim()
  if (required && !trimmed) throw invalid(`${field} is required`)
  if (trimmed.length > limit) throw invalid(`${field} is longer than ${limit} characters`)
  return trimmed
}

function list(value: unknown, field: string, check: (item: string, at: string) => string, limit: number = LIMITS.list): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid(`${field} must be a list of strings`)
  if (value.length > limit) throw invalid(`${field} has more than ${limit} entries`)
  return value.map((item, index) => check(text(item, `${field}[${index}]`), `${field}[${index}]`))
}

const matches = (pattern: RegExp, what: string) => (item: string, at: string): string => {
  if (!pattern.test(item)) throw invalid(`${at} is not ${what}`)
  return item
}
const MCP_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const JOB_ID = /^[A-Za-z0-9_.-]{1,128}$/

const show = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value) ?? 'null')

/** `key: value` lines of the current (removed) and proposed (added) values; unchanged keys are context. */
export function diffLines(current: Record<string, unknown> | null, proposed: Record<string, unknown>): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  for (const key of [...new Set([...Object.keys(proposed), ...Object.keys(current ?? {})])]) {
    const before = current && key in current ? `${key}: ${show(current[key])}` : null
    const after = key in proposed ? `${key}: ${show(proposed[key])}` : null
    if (before !== null && before === after) { oldLine += 1; newLine += 1; lines.push({ kind: 'context', old_line: oldLine, new_line: newLine, text: ` ${before}` }); continue }
    if (before !== null) { oldLine += 1; lines.push({ kind: 'deletion', old_line: oldLine, new_line: null, text: `-${before}` }) }
    if (after !== null) { newLine += 1; lines.push({ kind: 'addition', old_line: null, new_line: newLine, text: `+${after}` }) }
  }
  return lines
}

/** A stable hash of the payload and what the owner reviewed with it; an approval names it, so it approves only that. */
export const payloadHash = (kind: ProposalKind, payload: unknown, review: string): string =>
  createHash('sha256').update(JSON.stringify([kind, payload, review])).digest('hex').slice(0, 16)

/** What the server shows for a validated payload: summary, diff or field list, risk notes, and the reviewed preview. */
interface Presentation { summary: string; diff: DiffLine[]; fields: Proposal['fields']; risk_notes: string[]; review: string }

const envRefs = (names: string[]): Record<string, string> => Object.fromEntries(names.map((name) => [name, `\${${name}}`]))

/**
 * The MCP action route's body for this payload. A url server replaces the address and clears its headers, so no
 * credential follows the server to a new host; a command server replaces its command, args and env, an empty list
 * clearing the stored one. Env values stay in `.env`.
 */
export function mcpUpdateBody(payload: Payload<'mcp_server'>): Record<string, unknown> {
  if (payload.url) return { url: payload.url, headers: null }
  return { command: payload.command, args: payload.args.length ? payload.args : null, env: payload.env_names.length ? envRefs(payload.env_names) : null }
}

/** The transport fields the server has after the route applies `mcpUpdateBody` to `current`: what the card diffs. */
function mcpTransport(current: Record<string, unknown> | null, payload: Payload<'mcp_server'>): Record<string, unknown> {
  if (payload.url) return { url: payload.url }
  return {
    command: payload.command, ...(payload.args.length ? { args: payload.args } : {}), ...(payload.env_names.length ? { env: envRefs(payload.env_names) } : {}),
    ...(current && 'cwd' in current ? { cwd: current.cwd } : {}),
  }
}

/**
 * A stored server's transport fields with every header and env value masked: the agent reads the proposal before the
 * owner decides, so no stored value reaches it, whatever its name. `${NAME}` references stay readable.
 */
function maskedTransport(current: Record<string, unknown>): Record<string, unknown> {
  const shown = pick(current, MCP_TRANSPORT_KEYS)
  for (const key of ['headers', 'env']) {
    const value = shown[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    shown[key] = Object.fromEntries(Object.entries(value).map(([name, raw]) => [name, typeof raw === 'string' && /^\$\{[^}]+\}$/.test(raw) ? raw : MASK]))
  }
  return shown
}

/** The one-line message an approve or reject sends the owning session; the detail stays in the proposal. */
export function decisionMessage(proposal: Pick<StoredProposal, 'proposal_id' | 'summary' | 'status' | 'outcome'>): string {
  const head = `Proposal ${proposal.proposal_id} (${oneLine(proposal.summary)})`
  const result = proposal.status === 'applied' ? `was approved and applied: ${oneLine(proposal.outcome.text ?? '')}`
    : proposal.status === 'failed' ? `was approved but failed: ${oneLine(proposal.outcome.error ?? '')}`
      : 'was rejected'
  // The route's text usually ends its own sentence.
  return `${head} ${result}${/[.!?]$/.test(result) ? '' : '.'} Call proposal_read with proposal_id ${proposal.proposal_id} for details.`
}

export class Proposals {
  constructor(private readonly documents: DocumentBackend, private readonly deps: () => AppDeps, private readonly now: () => number) {}

  private profileName(profile: string | null | undefined): string {
    const name = profile || 'default'
    return this.deps().isRootProfile(name) ? 'default' : name
  }

  private async load(id: string): Promise<StoredProposal | null> {
    if (!ProposalIdSchema.safeParse(id).success) return null
    try { return ((await this.documents.get(NAMESPACE, id))?.value as StoredProposal | undefined) ?? null } catch { return null }
  }

  /** A proposal the current request may see: the request's profile, and a session its person may see. */
  private async visible(proposal: StoredProposal | null): Promise<boolean> {
    const deps = this.deps()
    return !!proposal && deps.profilesMatch(proposal.profile, deps.activeProfile()) && await deps.sessions.personMaySeeSessionId(proposal.session_id)
  }

  private expired(proposal: StoredProposal): boolean {
    return proposal.status === 'pending' && proposal.expires_at !== null && this.now() >= proposal.expires_at
  }

  /** The proposal as a requester sees it; only the server owner gets actions. */
  view(proposal: StoredProposal, owner: boolean): Proposal {
    const { review: _review, ...shown } = proposal
    const expired = this.expired(proposal)
    const reason = !owner ? 'not_owner' : expired ? 'expired' : proposal.status !== 'pending' ? 'closed' : null
    return { ...shown, status: expired ? 'expired' : proposal.status, actions: { can_approve: reason === null, can_reject: reason === null, reason } }
  }

  /** Change one proposal under its document lock; `edit` throws to refuse and write nothing. Every change emits `proposal`. */
  private async edit(id: string, edit: (proposal: StoredProposal) => void): Promise<StoredProposal> {
    const proposal = await updateDocument(this.documents, NAMESPACE, id, (raw) => {
      const stored = structuredClone(raw) as StoredProposal | null
      if (!stored) throw notFound(id)
      edit(stored)
      stored.updated_at = this.now()
      return { value: stored, result: stored }
    })
    this.changed(proposal)
    return proposal
  }

  private changed(proposal: StoredProposal): void {
    this.deps().channels.emit(proposal.session_id, 'proposal', { session_id: proposal.session_id, proposal_id: proposal.proposal_id, status: proposal.status }, proposal.profile)
  }

  /** A deleted session takes its proposals with it. */
  async deleteForSession(sid: string): Promise<void> {
    for (const { key } of await this.documents.list(NAMESPACE)) {
      if ((await this.load(key))?.session_id === sid) await this.documents.delete(NAMESPACE, key)
    }
  }

  // ── agent tools ─────────────────────────────────────────────────────────

  /** `propose`: validate the payload for its kind, preview it where the route has a preview, and store it pending. */
  async put(caller: ProposalCaller, params: Omit<SidecarServerParams<'server.proposal_put'>, 'caller_session_id'>): Promise<SidecarServerResultInput<'server.proposal_put'>> {
    if (!(PROPOSAL_KINDS as readonly string[]).includes(params.kind)) throw refuse(400, 'kind_unknown', `kind must be one of ${PROPOSAL_KINDS.join(', ')}`)
    const kind = params.kind as ProposalKind
    const profile = this.profileName(caller.profile)
    const home = this.deps().profileHome(profile)
    const { payload, presentation } = await this.present(kind, params.payload, home)
    const newId = (): string => `pr_${randomBytes(4).toString('hex')}`
    let id = newId()
    while (await this.documents.get(NAMESPACE, id)) id = newId()
    const at = this.now()
    const timeout = params.timeout_seconds ?? 3600
    const proposal = {
      proposal_id: id, session_id: caller.session_id, profile, kind, payload, ...presentation,
      payload_hash: payloadHash(kind, payload, presentation.review), status: 'pending', outcome: { text: null, error: null },
      created_at: at, updated_at: at, expires_at: timeout > 0 ? at + timeout : null, decided_at: null,
    } as StoredProposal
    await this.documents.put(NAMESPACE, id, proposal, null)
    this.changed(proposal)
    return { proposal_id: id, status: 'pending', url: `/session/${encodeURIComponent(caller.session_id)}`, kind, summary: proposal.summary }
  }

  /** `proposal_read`: the caller's own proposal with its status and outcome. */
  async read(caller: ProposalCaller, id: string): Promise<Proposal> {
    const proposal = await this.load(id)
    if (!proposal || proposal.session_id !== caller.session_id || proposal.profile !== this.profileName(caller.profile)) throw notFound(id)
    return this.view(proposal, false)
  }

  private async present(kind: ProposalKind, raw: Record<string, unknown>, home: string): Promise<{ payload: Proposal['payload']; presentation: Presentation }> {
    switch (kind) {
      case 'plugin_install': return this.presentPlugin(raw, home)
      case 'mcp_server': return this.presentMcp(raw, home)
      case 'setting': return this.presentSetting(raw, home)
      case 'cron_job': return this.presentCron(raw)
    }
  }

  /** The catalog entry at `pin`, previewed through the install route's sidecar call: nothing installs without a consent token. */
  private async presentPlugin(raw: Record<string, unknown>, home: string): Promise<{ payload: Payload<'plugin_install'>; presentation: Presentation }> {
    const payload = { catalog_id: text(raw.catalog_id, 'catalog_id', LIMITS.name), pin: text(raw.pin, 'pin', 64) }
    if (!/^[a-z0-9_-]{1,64}$/.test(payload.catalog_id)) throw invalid('catalog_id is not a catalog name')
    const sidecar = this.deps().sidecar()
    if (!sidecar) throw refuse(503, 'sidecar_unavailable', 'the Agent sidecar is not running')
    const catalog = await sidecar.call('plugins.catalog', { profile_home: home, query: payload.catalog_id, offset: 0, limit: 50 })
    const entry = catalog.entries.find((candidate) => candidate.name === payload.catalog_id)
    if (!catalog.supported || !entry) throw refuse(404, 'plugin_unknown', `the plugin catalog has no ${payload.catalog_id}`)
    if (entry.installed_key) throw refuse(409, 'plugin_installed', `${payload.catalog_id} is already installed as ${entry.installed_key}`)
    if (payload.pin.length < 7 || !entry.sha.startsWith(payload.pin)) throw refuse(409, 'pin_mismatch', `the catalog pins ${payload.catalog_id} at ${entry.sha}, not ${payload.pin}`)
    payload.pin = entry.sha
    const preview = await sidecar.call('plugins.install', { profile_home: home, name: payload.catalog_id }, { timeoutMs: 0 })
    if (preview.status !== 'needs_consent') throw refuse(409, 'plugin_blocked', preview.status === 'blocked' ? preview.findings : `${payload.catalog_id} did not stop for review`)
    return {
      payload,
      presentation: {
        summary: `Install plugin ${entry.title || entry.name}`, diff: [],
        fields: [{ label: 'Plugin', value: `${entry.title} (${entry.name})` }, { label: 'Description', value: entry.description }, { label: 'Repository', value: entry.repo }, { label: 'Pin', value: entry.sha }, { label: 'Tier', value: entry.tier }],
        risk_notes: preview.findings.split('\n').map((line) => line.trim()).filter(Boolean),
        review: preview.findings,
      },
    }
  }

  private async presentMcp(raw: Record<string, unknown>, home: string): Promise<{ payload: Payload<'mcp_server'>; presentation: Presentation }> {
    const name = text(raw.name, 'name', LIMITS.name)
    if (!MCP_NAME.test(name)) throw invalid('name may use letters, digits, `_`, `.` and `-` only')
    const url = text(raw.url, 'url', LIMITS.text, false) || null
    const command = text(raw.command, 'command', LIMITS.text, false) || null
    if (!url === !command) throw invalid('give exactly one of url or command')
    if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw invalid('url must be an http or https address')
    if ('env' in raw) throw invalid('env values never go in a proposal; name the .env variables in env_names')
    const payload = { name, url, command, args: url ? [] : list(raw.args, 'args', (item) => item), env_names: url ? [] : list(raw.env_names, 'env_names', matches(ENV_NAME, 'an environment variable name')) }
    if (url && (raw.args !== undefined || raw.env_names !== undefined)) throw invalid('args and env_names belong to a command server')
    const existing = (await this.deps().agentConfig.read(home)).mcp_servers
    const current = existing && typeof existing === 'object' && name in existing ? (existing as Record<string, Record<string, unknown>>)[name] ?? null : null
    const env = payload.env_names.length ? loadEnvFile(join(home, '.env')) : {}
    const missing = payload.env_names.filter((envName) => !(envName in env))
    return {
      payload,
      presentation: {
        summary: `${current ? 'Change' : 'Add'} MCP server ${name}`,
        diff: diffLines(current && maskedTransport(current), mcpTransport(current, payload)), fields: [],
        risk_notes: [
          url ? `Connects to ${new URL(url).host} and gives the agent its tools.` : `Runs ${[command, ...payload.args].join(' ')} on this machine and gives the agent its tools.`,
          ...(payload.env_names.length ? [`Passes ${payload.env_names.join(', ')} from the profile's .env to it.`] : []),
          ...(missing.length ? [`Not in the profile's .env yet: ${missing.join(', ')}.`] : []),
          ...(current ? [`Replaces the existing server's ${url ? 'address' : 'command'}.`] : []),
        ],
        review: '',
      },
    }
  }

  private async presentSetting(raw: Record<string, unknown>, home: string): Promise<{ payload: Payload<'setting'>; presentation: Presentation }> {
    const key = text(raw.key, 'key', LIMITS.name)
    if (!('value' in raw)) throw invalid('value is required')
    const value = raw.value
    const deps = this.deps()
    const defaults = deps.settings.defaults()
    let current: unknown
    if (key in CONFIG_SETTINGS) current = await CONFIG_SETTINGS[key]!(deps, home)
    else if (key in defaults && !SETTING_DENIED.has(key) && !key.startsWith('_') && isScalar(defaults[key])) {
      const fallback = defaults[key]
      if (fallback !== null && typeof value !== typeof fallback) throw invalid(`${key} takes a ${typeof fallback}`)
      current = (await deps.settings.load())[key]
    } else throw refuse(400, 'setting_unknown', `${key} is not a setting a proposal can change`)
    if (!isScalar(value)) throw invalid(`${key} takes a single value`)
    return { payload: { key, value }, presentation: { summary: `Change setting ${key}`, diff: diffLines({ [key]: current ?? null }, { [key]: value }), fields: [], risk_notes: [], review: '' } }
  }

  private presentCron(raw: Record<string, unknown>): { payload: Payload<'cron_job'>; presentation: Presentation } {
    const payload = {
      title: text(raw.title, 'title', LIMITS.title), schedule: text(raw.schedule, 'schedule', LIMITS.title), prompt: text(raw.prompt, 'prompt', LIMITS.prompt),
      context_sources: list(raw.context_sources, 'context_sources', matches(JOB_ID, 'a task id'), LIMITS.sources),
    }
    return {
      payload,
      presentation: {
        summary: `Schedule task ${payload.title}`, diff: [],
        fields: [{ label: 'Title', value: payload.title }, { label: 'Schedule', value: payload.schedule }, { label: 'Prompt', value: payload.prompt }, ...(payload.context_sources.length ? [{ label: 'Reads output of', value: payload.context_sources.join(', ') }] : [])],
        risk_notes: ['Runs the prompt unattended on this schedule with the profile\'s tools.'],
        review: '',
      },
    }
  }

  // ── routes ──────────────────────────────────────────────────────────────

  async get(id: string, owner: boolean): Promise<Proposal> {
    const proposal = await this.load(id)
    if (!proposal || !(await this.visible(proposal))) throw notFound(id)
    return this.view(proposal, owner)
  }

  /** The visible proposal, or 404; then 403 for anyone but the owner. */
  private async decidable(id: string, owner: boolean): Promise<void> {
    if (!(await this.visible(await this.load(id)))) throw notFound(id)
    if (!owner) throw refuse(403, 'not_owner', 'Only the server owner can approve or reject a proposal.')
  }

  /** Close a pending, unexpired proposal under its lock, so a second decision is refused. */
  private claim(stored: StoredProposal, status: 'approved' | 'rejected'): void {
    if (this.expired(stored)) throw refuse(409, 'proposal_expired', `proposal ${stored.proposal_id} expired`)
    if (stored.status !== 'pending') throw refuse(409, 'proposal_closed', `proposal ${stored.proposal_id} is ${stored.status}`)
    stored.status = status
    stored.decided_at = this.now()
  }

  /** Tell the owning session; the decision stands when the session cannot take the message. */
  private async tell(proposal: StoredProposal): Promise<void> {
    try { await sendSessionMessage(this.deps(), proposal.session_id, decisionMessage(proposal)) } catch (error) {
      this.deps().log(`[webui] could not tell ${proposal.session_id} about proposal ${proposal.proposal_id}: ${(error as Error).message}`)
    }
  }

  /** `POST …/approve`: single use and bound to `payload_hash`; the kind's route applies it and its answer is the outcome. */
  async approve(id: string, hash: string, owner: boolean, apply: ProposalApply): Promise<Proposal> {
    await this.decidable(id, owner)
    const approved = await this.edit(id, (stored) => {
      if (stored.status === 'pending' && !this.expired(stored) && stored.payload_hash !== hash) throw refuse(409, 'payload_changed', 'This proposal is not the version that was reviewed.')
      this.claim(stored, 'approved')
    })
    let outcome: StoredProposal['outcome']
    try { outcome = { text: await apply(approved), error: null } } catch (error) { outcome = { text: null, error: (error as Error).message || 'The change was refused.' } }
    const done = await this.edit(id, (stored) => { stored.status = outcome.error === null ? 'applied' : 'failed'; stored.outcome = outcome })
    await this.tell(done)
    return this.view(done, owner)
  }

  async reject(id: string, owner: boolean): Promise<Proposal> {
    await this.decidable(id, owner)
    const rejected = await this.edit(id, (stored) => { this.claim(stored, 'rejected') })
    await this.tell(rejected)
    return this.view(rejected, owner)
  }
}

const isScalar = (value: unknown): boolean => value === null || ['string', 'number', 'boolean'].includes(typeof value)
const MCP_TRANSPORT_KEYS = ['url', 'headers', 'command', 'args', 'env', 'cwd']
const pick = (value: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]))
