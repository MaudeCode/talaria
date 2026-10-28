import { createHash, randomUUID } from 'node:crypto'
import { arch, platform, homedir } from 'node:os'
import { z } from 'zod'
import { FeedbackSubmitSchema } from '@maudecode/talaria-web-contracts'
import type { AppDeps } from './http/context.js'
import type { ServerConfig } from './config.js'
import { redactSensitive } from './redact.js'
import { HttpFailure } from './sessions/service.js'
import { loadRelayConfig, RelayPairingError } from './sessions/relay.js'
import { updateDocument } from './sessions/storage/document.js'

const MAX_DIAGNOSTICS_BYTES = 16 * 1024
const documents = (deps: AppDeps) => deps.sessionStore.deps.storage.documents
const ServerStamp = z.object({ webVersion: z.string().max(64), agentVersion: z.string().max(64).optional() })
const Snapshot = z.object({ server: ServerStamp, diagnostics: z.string().max(MAX_DIAGNOSTICS_BYTES).optional() })
const MAX_RECEIPTS = 1024
const MAX_REPORTS_PER_OWNER_HOUR = 20
const QUOTA_WINDOW = 3600
const RECEIPT_RETENTION = 30 * 86400
const Receipt = z.object({ requestId: z.uuid(), fingerprint: z.string().length(64), owner: z.string().length(64), createdAt: z.number(), expiresAt: z.number(), snapshot: Snapshot.optional(), reportId: z.string().min(1).max(256).optional() })
const FeedbackState = z.object({ installId: z.uuid(), entries: z.array(Receipt).max(MAX_RECEIPTS) })
const submissions = new WeakMap<AppDeps, Map<string, Promise<void>>>()

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
async function settleFeedback(deps: AppDeps, requestId: string, owner: string, reportId?: string): Promise<void> {
  await updateDocument(documents(deps), 'feedback', 'state', (raw) => {
    if (raw === undefined) return { value: raw, result: undefined, skip: true }
    const state = FeedbackState.parse(raw)
    const entry = state.entries.find((row) => row.requestId === requestId && row.owner === owner)
    if (!entry || entry.reportId) return { value: state, result: undefined, skip: true }
    delete entry.snapshot
    if (reportId) entry.reportId = reportId
    else entry.expiresAt = Date.now() / 1000 + QUOTA_WINDOW
    return { value: state, result: undefined }
  })
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

async function submitFeedbackSerial(deps: AppDeps, profileHome: string, input: z.infer<typeof FeedbackSubmitSchema>): Promise<{ status: 'sent'; reportId: string }> {
  let outcome = 'feedback_unavailable'
  const owner = createHash('sha256').update(deps.requestScope.getStore()?.notificationOwner ?? 'local-owner').digest('hex')
  try {
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    // Admission, quota and snapshot writes share one bounded document transaction. Invalid envelopes write nothing.
    const admitted = await updateDocument<{ reportId: string | null; body: string }>(documents(deps), 'feedback', 'state', async (raw) => {
      const now = Date.now() / 1000
      const state = raw === undefined ? { installId: randomUUID(), entries: [] } : FeedbackState.parse(raw)
      state.entries = state.entries.filter((row) => row.expiresAt > now)
      let entry = state.entries.find((row) => row.requestId === input.requestId)
      if (entry && (entry.owner !== owner || entry.fingerprint !== fingerprint)) throw new HttpFailure(400, 'invalid')
      if (entry?.reportId) return { value: state, result: { reportId: entry.reportId, body: '' } }
      if (!entry) {
        const recent = state.entries.filter((row) => row.owner === owner && row.createdAt > now - QUOTA_WINDOW)
        if (recent.length >= MAX_REPORTS_PER_OWNER_HOUR || state.entries.length >= MAX_RECEIPTS) {
          const until = recent.length >= MAX_REPORTS_PER_OWNER_HOUR ? Math.min(...recent.map((row) => row.createdAt + QUOTA_WINDOW)) : Math.min(...state.entries.map((row) => row.expiresAt))
          throw new HttpFailure(429, 'rate_limited', { retryAfterSeconds: Math.max(1, Math.ceil(until - now)) })
        }
      }
      const snapshot = entry?.snapshot ?? { server: ServerStamp.parse({ webVersion: deps.version.slice(0, 64), agentVersion: deps.agentVersion().slice(0, 64) }), ...(input.includeDiagnostics ? { diagnostics: (await feedbackDiagnostics(deps, profileHome)).text } : {}) }
      const { requestId, kind, title, body: text, client } = input
      const body = JSON.stringify({ requestId, kind, title, body: text, client, installId: state.installId, ...snapshot })
      if (Buffer.byteLength(body) > 32 * 1024) throw new HttpFailure(400, 'invalid')
      if (!entry) {
        entry = { requestId, fingerprint, owner, createdAt: now, expiresAt: now + RECEIPT_RETENTION }
        state.entries.push(entry)
      }
      entry.snapshot = snapshot
      entry.expiresAt = entry.createdAt + RECEIPT_RETENTION
      return { value: state, result: { reportId: null, body } }
    })
    if (admitted.reportId) { outcome = 'sent'; return { status: 'sent', reportId: admitted.reportId } }
    let reportId: string
    try {
      reportId = await deps.relay.submitFeedback(admitted.body)
    } catch (error) {
      if (error instanceof RelayPairingError && error.message !== 'relay_unreachable') await settleFeedback(deps, input.requestId, owner)
      throw error
    }
    // A failed compaction leaves the already durable, bounded snapshot available for safe retry.
    await settleFeedback(deps, input.requestId, owner, reportId).catch(() => undefined)
    outcome = 'sent'
    return { status: 'sent', reportId }
  } catch (error) {
    if (error instanceof RelayPairingError) { outcome = error.message; throw new HttpFailure(error.status, error.message, error.extra) }
    if (error instanceof HttpFailure) { outcome = error.message; throw error }
    throw new HttpFailure(503, 'feedback_unavailable')
  } finally { deps.log(`[feedback] ${input.requestId} ${outcome}`) }
}
