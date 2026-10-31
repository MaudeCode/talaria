import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { arch, platform, homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { FEEDBACK_ATTACHMENT_LIMITS, FeedbackAttachmentResultSchema, FeedbackAttachmentTypeSchema, FeedbackSubmitSchema, type FeedbackAttachmentStagedSchema, type FeedbackOptionsSchema, type FeedbackResultSchema } from '@maudecode/talaria-web-contracts'
import type { AppDeps } from './http/context.js'
import type { ServerConfig } from './config.js'
import { redactSensitive } from './redact.js'
import { HttpFailure } from './sessions/service.js'
import { loadRelayConfig, RelayPairingError } from './sessions/relay.js'
import { checkImageMagic } from './sessions/shares.js'
import { updateDocument } from './sessions/storage/document.js'

const MAX_DIAGNOSTICS_BYTES = 16 * 1024
const documents = (deps: AppDeps) => deps.sessionStore.deps.storage.documents
const ServerStamp = z.object({ webVersion: z.string().max(64), agentVersion: z.string().max(64).optional() })
const Snapshot = z.object({ server: ServerStamp, diagnostics: z.string().max(MAX_DIAGNOSTICS_BYTES).optional() })
const MAX_RECEIPTS = 1024
const MAX_REPORTS_PER_OWNER_HOUR = 20
const QUOTA_WINDOW = 3600
const RECEIPT_RETENTION = 30 * 86400
const MAX_ATTACHMENTS = FEEDBACK_ATTACHMENT_LIMITS.maxAttachments
const ManifestEntry = z.object({ attachmentId: z.uuid(), contentType: FeedbackAttachmentTypeSchema, bytes: z.number().int().positive(), sha256: z.string().length(64) })
type ManifestEntry = z.infer<typeof ManifestEntry>
type AttachmentResult = z.infer<typeof FeedbackAttachmentResultSchema>
// `attachments` is the admitted manifest: a retry resends it unchanged, and it outlives settling so the fingerprint still
// covers the file hashes. `results` is the settled per-file outcome.
const Receipt = z.object({ requestId: z.uuid(), fingerprint: z.string().length(64), owner: z.string().length(64), createdAt: z.number(), expiresAt: z.number(), snapshot: Snapshot.optional(), reportId: z.string().min(1).max(256).optional(), attachments: z.array(ManifestEntry).max(MAX_ATTACHMENTS).optional(), results: z.array(FeedbackAttachmentResultSchema).max(MAX_ATTACHMENTS).optional() })
const FeedbackState = z.object({ installId: z.uuid(), entries: z.array(Receipt).max(MAX_RECEIPTS) })
const submissions = new WeakMap<AppDeps, Map<string, Promise<void>>>()

// Staged attachment files live under the state dir; their bounded index is the `feedback/attachments` document.
const STAGING_TTL = 3600
const MAX_STAGED_PER_OWNER = 15
const MAX_STAGED_BYTES_PER_OWNER = 100_000_000
// Server-wide caps bound the index document and disk use across all members.
const MAX_STAGED_TOTAL = 256
const MAX_STAGED_BYTES_TOTAL = 1_000_000_000
/** The multipart body cap for one staged file: the largest attachment plus framing. */
export const FEEDBACK_UPLOAD_MAX_BYTES = Math.max(...Object.values(FEEDBACK_ATTACHMENT_LIMITS.types).map((type) => type.maxBytes)) + 64 * 1024
const Staged = ManifestEntry.extend({ owner: z.string().length(64), createdAt: z.number(), expiresAt: z.number(), requestId: z.uuid().optional() })
type Staged = z.infer<typeof Staged>
const StagedState = z.object({ entries: z.array(Staged).max(MAX_STAGED_TOTAL) })
const stagingDir = (deps: AppDeps) => join(deps.config.stateDir, 'feedback-attachments')
const sha256Hex = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const ownerHash = (deps: AppDeps) => createHash('sha256').update(deps.requestScope.getStore()?.notificationOwner ?? 'local-owner').digest('hex')

/** Every edit of the staging index runs here: expired entries drop first, and files the edited index no longer names go after. */
function editStaged<T>(deps: AppDeps, edit: (state: z.infer<typeof StagedState>, now: number) => Promise<T> | T): Promise<T> {
  return updateDocument(documents(deps), 'feedback', 'attachments', async (raw) => {
    const now = Date.now() / 1000
    const state = raw === undefined ? { entries: [] } : StagedState.parse(raw)
    state.entries = state.entries.filter((row) => row.expiresAt > now)
    const result = await edit(state, now)
    const live = new Set(state.entries.map((row) => row.attachmentId))
    for (const name of await readdir(stagingDir(deps)).catch(() => [])) if (!live.has(name)) await rm(join(stagingDir(deps), name), { force: true })
    // Text-only feedback never creates the index.
    return { value: state, result, skip: raw === undefined && !state.entries.length }
  })
}

/** What this server's Relay tier may attach; an unregistered or unreadable registration is unverified (fail closed). */
export async function feedbackOptions(deps: AppDeps): Promise<z.infer<typeof FeedbackOptionsSchema>> {
  const tier = await loadRelayConfig(documents(deps)).then((config) => (config ? 'verified' : 'unverified'), () => 'unverified' as const)
  const kinds: readonly string[] = FEEDBACK_ATTACHMENT_LIMITS.tierKinds[tier]
  const types = Object.entries(FEEDBACK_ATTACHMENT_LIMITS.types)
  const maxBytes = (kind: string) => Math.max(...types.filter(([, type]) => type.kind === kind).map(([, type]) => type.maxBytes))
  return { attachments: {
    enabled: kinds.length > 0, videoAllowed: kinds.includes('video'), maxCount: MAX_ATTACHMENTS, maxVideoCount: kinds.includes('video') ? FEEDBACK_ATTACHMENT_LIMITS.maxVideosPerReport : 0,
    maxImageBytes: maxBytes('image'), maxVideoBytes: maxBytes('video'), maxVideoSeconds: FEEDBACK_ATTACHMENT_LIMITS.maxVideoSeconds,
    acceptedTypes: types.filter(([, type]) => kinds.includes(type.kind)).map(([name]) => FeedbackAttachmentTypeSchema.parse(name)),
  } }
}

/** Validate one file against the shared limits and stage it for this member for an hour. */
export async function stageFeedbackAttachment(deps: AppDeps, declaredType: string, data: Buffer): Promise<z.infer<typeof FeedbackAttachmentStagedSchema>> {
  const parsed = FeedbackAttachmentTypeSchema.safeParse(declaredType)
  if (!parsed.success) throw new HttpFailure(400, 'invalid')
  const contentType = parsed.data
  if (!data.length || data.length > FEEDBACK_ATTACHMENT_LIMITS.types[contentType].maxBytes || !checkImageMagic(data, contentType)) throw new HttpFailure(400, 'invalid')
  if (!(await feedbackOptions(deps)).attachments.acceptedTypes.includes(contentType)) throw new HttpFailure(403, 'attachments_unavailable')
  const owner = ownerHash(deps)
  const sha256 = sha256Hex(data)
  const staged = await editStaged(deps, async (state, now) => {
    const mine = state.entries.filter((row) => row.owner === owner)
    const total = (rows: Staged[]) => rows.reduce((sum, row) => sum + row.bytes, 0)
    const full = (rows: Staged[], count: number, bytes: number) => rows.length >= count || total(rows) + data.length > bytes
    for (const [rows, count, bytes] of [[mine, MAX_STAGED_PER_OWNER, MAX_STAGED_BYTES_PER_OWNER], [state.entries, MAX_STAGED_TOTAL, MAX_STAGED_BYTES_TOTAL]] as const) {
      // A file bound to an unsettled report may wait days; the earliest unbound expiry is the honest retry interval.
      if (full(rows, count, bytes)) return { retryAfterSeconds: Math.max(1, Math.ceil(Math.min(now + STAGING_TTL, ...rows.filter((row) => !row.requestId).map((row) => row.expiresAt)) - now)) }
    }
    const attachmentId = randomUUID()
    await mkdir(stagingDir(deps), { recursive: true, mode: 0o700 })
    await writeFile(join(stagingDir(deps), attachmentId), data, { flag: 'wx', mode: 0o600 })
    state.entries.push({ attachmentId, contentType, bytes: data.length, sha256, owner, createdAt: now, expiresAt: now + STAGING_TTL })
    return { attachmentId }
  })
  if ('retryAfterSeconds' in staged) throw new HttpFailure(429, 'rate_limited', staged)
  return { attachmentId: staged.attachmentId, contentType, bytes: data.length }
}

/**
 * Atomically check and claim the member's own, unexpired files for this request, in request order; a missing, expired,
 * foreign or otherwise claimed file is `invalid`. `claimed` names the files this call took, so a failed admission can
 * hand them back.
 */
async function claimAttachments(deps: AppDeps, ids: readonly string[], owner: string, requestId: string): Promise<{ manifest: ManifestEntry[]; claimed: string[] }> {
  if (!ids.length) return { manifest: [], claimed: [] }
  return editStaged(deps, (state) => {
    const rows = ids.map((id) => state.entries.find((row) => row.attachmentId === id && row.owner === owner && (row.requestId ?? requestId) === requestId))
    if (rows.some((row) => !row)) throw new HttpFailure(400, 'invalid')
    const manifest = rows.map((row) => ManifestEntry.parse(row))
    if (manifest.filter((row) => FEEDBACK_ATTACHMENT_LIMITS.types[row.contentType].kind === 'video').length > FEEDBACK_ATTACHMENT_LIMITS.maxVideosPerReport) throw new HttpFailure(400, 'invalid')
    const claimed = rows.filter((row) => !row!.requestId).map((row) => row!.attachmentId)
    for (const row of rows) row!.requestId = requestId
    return { manifest, claimed }
  })
}

/** Return files this call claimed when admission refused the report before it existed. */
async function unclaimAttachments(deps: AppDeps, claimed: string[], requestId: string): Promise<void> {
  if (!claimed.length) return
  await editStaged(deps, (state) => { for (const row of state.entries) if (claimed.includes(row.attachmentId) && row.requestId === requestId) delete row.requestId })
}

/** A request's files live exactly as long as its receipt, so any retry of that request can still upload them. */
async function retainAttachments(deps: AppDeps, requestId: string, expiresAt: number): Promise<void> {
  await editStaged(deps, (state) => { for (const row of state.entries) if (row.requestId === requestId) row.expiresAt = expiresAt })
}

/** A sent report no longer needs its files; the sweep in `editStaged` deletes them with their index rows. */
async function releaseAttachments(deps: AppDeps, requestId: string): Promise<void> {
  await editStaged(deps, (state) => { state.entries = state.entries.filter((row) => row.requestId !== requestId) })
}

/** The exact admitted bytes, or null when the file is gone or no longer matches its manifest entry. */
async function readAttachment(deps: AppDeps, entry: ManifestEntry): Promise<Buffer | null> {
  const data = await readFile(join(stagingDir(deps), entry.attachmentId)).catch(() => null)
  return data?.length === entry.bytes && sha256Hex(data) === entry.sha256 ? data : null
}

/**
 * Send the report, then PUT each accepted file. An unknown PUT outcome resubmits the identical report once, which
 * reuses the Relay report and reissues tokens only for files not yet stored, then retries; a second unknown outcome is
 * `relay_unreachable` so the client retries the same requestId.
 */
async function forwardFeedback(deps: AppDeps, body: string, manifest: ManifestEntry[]): Promise<{ reportId: string; attachments: AttachmentResult[] }> {
  const results: (AttachmentResult | undefined)[] = manifest.map(() => undefined)
  for (let round = 0; ; round++) {
    const { reportId, attachments } = await deps.relay.submitFeedback(body)
    let unknown = false
    for (const [index, entry] of manifest.entries()) {
      if (results[index]) continue
      const { attachmentId } = entry
      const admission = attachments.find((row) => row.index === index)
      if (!admission) { results[index] = { attachmentId, status: 'refused', reason: 'invalid' }; continue }
      if (admission.status === 'refused') { results[index] = { attachmentId, status: 'refused', reason: admission.reason }; continue }
      if (admission.status !== 'accepted') { results[index] = admission.status === 'stored' ? { attachmentId, status: 'sent' } : { attachmentId, status: 'refused', reason: 'expired' }; continue }
      const data = await readAttachment(deps, entry)
      const put = data ? await deps.relay.uploadFeedbackAttachment(reportId, index, admission.uploadToken, data) : 'invalid'
      if (put === 'unknown') unknown = true
      else results[index] = put === 'stored' ? { attachmentId, status: 'sent' } : { attachmentId, status: 'refused', reason: put }
    }
    if (!unknown) return { reportId, attachments: results.filter((row) => row !== undefined) }
    if (round >= 1) throw new RelayPairingError('relay_unreachable', 502)
  }
}

/** Redact before truncation so a long credential cannot lose its identifying prefix. */
export function redactFeedbackText(text: string, config: ServerConfig): string {
  const homes = [config.env.HOME, config.env.USERPROFILE, homedir(), config.hermesHome, config.stateDir].filter((v): v is string => Boolean(v)).sort((a, b) => b.length - a.length)
  for (const home of homes) text = text.replaceAll(home, '<home>')
  return redactSensitive(text)
    .replace(/\b(?:prompt|transcript|messages|content|body)["']?\s*[:=].*/gi, '[content omitted]')
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*[ \t]*=[\s\S]*/g, '[environment omitted]')
    .replace(/https?:\/\/[^\s'"<>]+/gi, '<url>')
    .replace(/(["'])(?:<home>|\/|[A-Za-z]:[\\/]|\\\\)(?:\\.|(?!\1)[^\\])*(?:\1|$)/g, '<path>')
    .replace(/(?<![A-Za-z0-9_.:])(?:<home>|\/|[A-Za-z]:[\\/]|\\\\)(?:\\[\s\S]|[^\s'"<>])+/g, '<path>')
}

/** Both HTTP routes use this projection; no session or conversation state is read. */
export async function feedbackDiagnostics(deps: AppDeps, profileHome: string): Promise<{ text: string; bytes: number }> {
  const providers = await deps.catalog.providers(profileHome)
  const names = providers.providers.filter((p) => p.configured || p.has_key).map((p) => String(p.id)).filter((id) => /^[a-z][a-z0-9_-]{0,63}$/i.test(id)).sort()
  const registered = await loadRelayConfig(documents(deps))
  const lines = [
    `Web: ${deps.version}`, `Agent: ${deps.agentVersion()}`, `Node: ${process.version}`,
    `OS: ${platform()}/${arch()}`, `Relay registered: ${registered ? 'yes' : 'no'}`,
    `Enabled providers: ${names.join(', ') || 'none'}`,
    ...deps.recentErrors().slice(-10),
  ]
  const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.from(redactFeedbackText(lines.join('\n'), deps.config)).subarray(0, MAX_DIAGNOSTICS_BYTES)).replace(/\uFFFD$/, '')
  return { text, bytes: Buffer.byteLength(text) }
}

/** Drop diagnostic snapshots after a definitive result; retain a small retry receipt or quota entry. */
async function settleFeedback(deps: AppDeps, requestId: string, owner: string, sent?: { reportId: string; attachments: AttachmentResult[] }): Promise<void> {
  const expiresAt = await updateDocument(documents(deps), 'feedback', 'state', (raw) => {
    if (raw === undefined) return { value: raw, result: null, skip: true }
    const state = FeedbackState.parse(raw)
    const entry = state.entries.find((row) => row.requestId === requestId && row.owner === owner)
    if (!entry || entry.reportId) return { value: state, result: null, skip: true }
    delete entry.snapshot
    if (sent) Object.assign(entry, { reportId: sent.reportId, results: sent.attachments })
    else entry.expiresAt = Date.now() / 1000 + QUOTA_WINDOW
    return { value: state, result: entry.expiresAt }
  })
  // A refused report (for example Relay's 429) keeps its files for the quota marker's lifetime, so a retry can send them.
  if (sent) await releaseAttachments(deps, requestId)
  else if (expiresAt !== null) await retainAttachments(deps, requestId, expiresAt)
}

/** Like RelayService.pair, serialize each identity through its complete send/settle lifecycle. */
export function submitFeedback(deps: AppDeps, profileHome: string, input: z.infer<typeof FeedbackSubmitSchema>): ReturnType<typeof submitFeedbackSerial> {
  let pending = submissions.get(deps)
  if (!pending) { pending = new Map(); submissions.set(deps, pending) }
  const result = (pending.get(input.requestId) ?? Promise.resolve()).then(() => submitFeedbackSerial(deps, profileHome, input))
  const settled = result.then(() => undefined, () => undefined)
  pending.set(input.requestId, settled)
  void settled.then(() => { if (pending.get(input.requestId) === settled) pending.delete(input.requestId) })
  return result
}

async function submitFeedbackSerial(deps: AppDeps, profileHome: string, input: z.infer<typeof FeedbackSubmitSchema>): Promise<z.infer<typeof FeedbackResultSchema>> {
  let outcome = 'feedback_unavailable'
  const owner = ownerHash(deps)
  try {
    // Only a new admission needs the claim to succeed; a retry reuses its receipt even after those files are released.
    const fresh = await claimAttachments(deps, input.attachmentIds ?? [], owner, input.requestId).catch((error: unknown) => error as Error)
    const claimed = fresh instanceof Error ? [] : fresh.claimed
    // Admission, quota and snapshot writes share one bounded document transaction. Invalid envelopes write nothing.
    const admitted = await updateDocument<{ sent: z.infer<typeof FeedbackResultSchema> | null; body: string; manifest: ManifestEntry[]; expiresAt: number }>(documents(deps), 'feedback', 'state', async (raw) => {
      const now = Date.now() / 1000
      const state = raw === undefined ? { installId: randomUUID(), entries: [] } : FeedbackState.parse(raw)
      state.entries = state.entries.filter((row) => row.expiresAt > now)
      let entry = state.entries.find((row) => row.requestId === input.requestId)
      // A retry resends the admitted manifest; the fingerprint covers each file's hash, not only its ID.
      if (!entry && fresh instanceof Error) throw fresh
      const manifest = entry ? entry.attachments ?? [] : (fresh as { manifest: ManifestEntry[] }).manifest
      const hash = createHash('sha256').update(JSON.stringify(input))
      for (const row of manifest) hash.update(row.sha256)
      const fingerprint = hash.digest('hex')
      if (entry && (entry.owner !== owner || entry.fingerprint !== fingerprint)) throw new HttpFailure(400, 'invalid')
      if (entry?.reportId) return { value: state, result: { sent: { status: 'sent', reportId: entry.reportId, attachments: entry.results ?? [] }, body: '', manifest, expiresAt: entry.expiresAt } }
      if (!entry) {
        const recent = state.entries.filter((row) => row.owner === owner && row.createdAt > now - QUOTA_WINDOW)
        if (recent.length >= MAX_REPORTS_PER_OWNER_HOUR || state.entries.length >= MAX_RECEIPTS) {
          const until = recent.length >= MAX_REPORTS_PER_OWNER_HOUR ? Math.min(...recent.map((row) => row.createdAt + QUOTA_WINDOW)) : Math.min(...state.entries.map((row) => row.expiresAt))
          throw new HttpFailure(429, 'rate_limited', { retryAfterSeconds: Math.max(1, Math.ceil(until - now)) })
        }
      }
      const snapshot = entry?.snapshot ?? { server: ServerStamp.parse({ webVersion: deps.version.slice(0, 64), agentVersion: deps.agentVersion().slice(0, 64) }), ...(input.includeDiagnostics ? { diagnostics: (await feedbackDiagnostics(deps, profileHome)).text } : {}) }
      const { requestId, kind, title, body: text, client } = input
      const attachments = manifest.map(({ contentType, bytes, sha256 }) => ({ contentType, bytes, sha256 }))
      const body = JSON.stringify({ requestId, kind, title, body: text, client, installId: state.installId, ...snapshot, ...(attachments.length ? { attachments } : {}) })
      if (Buffer.byteLength(body) > 32 * 1024) throw new HttpFailure(400, 'invalid')
      if (!entry) {
        entry = { requestId, fingerprint, owner, createdAt: now, expiresAt: now + RECEIPT_RETENTION }
        state.entries.push(entry)
      }
      entry.snapshot = snapshot
      if (manifest.length) entry.attachments = manifest
      entry.expiresAt = entry.createdAt + RECEIPT_RETENTION
      return { value: state, result: { sent: null, body, manifest, expiresAt: entry.expiresAt } }
    }).catch(async (error: unknown) => { await unclaimAttachments(deps, claimed, input.requestId); throw error })
    if (admitted.sent) { outcome = 'sent'; return admitted.sent }
    if (admitted.manifest.length) await retainAttachments(deps, input.requestId, admitted.expiresAt)
    let sent: Awaited<ReturnType<typeof forwardFeedback>>
    try {
      sent = await forwardFeedback(deps, admitted.body, admitted.manifest)
    } catch (error) {
      if (error instanceof RelayPairingError && error.message !== 'relay_unreachable') await settleFeedback(deps, input.requestId, owner)
      throw error
    }
    // A failed compaction leaves the already durable, bounded snapshot available for safe retry.
    await settleFeedback(deps, input.requestId, owner, sent).catch(() => undefined)
    outcome = 'sent'
    return { status: 'sent', ...sent }
  } catch (error) {
    if (error instanceof RelayPairingError) { outcome = error.message; throw new HttpFailure(error.status, error.message, error.extra) }
    if (error instanceof HttpFailure) { outcome = error.message; throw error }
    throw new HttpFailure(503, 'feedback_unavailable')
  } finally { deps.log(`[feedback] ${input.requestId} ${outcome}`) }
}
