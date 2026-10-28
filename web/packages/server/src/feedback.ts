import { createHash, randomUUID } from 'node:crypto'
import { arch, platform, homedir } from 'node:os'
import { z } from 'zod'
import { FeedbackSubmitSchema } from '@maudecode/talaria-web-contracts'
import type { AppDeps } from './http/context.js'
import { redactSensitive } from './redact.js'
import { HttpFailure } from './sessions/service.js'
import { loadRelayConfig, RelayPairingError } from './sessions/relay.js'
import { updateDocument } from './sessions/storage/document.js'

const MAX_DIAGNOSTICS_BYTES = 16 * 1024
const documents = (deps: AppDeps) => deps.sessionStore.deps.storage.documents
const ServerStamp = z.object({ webVersion: z.string().max(64), agentVersion: z.string().max(64).optional() })
const Snapshot = z.object({ fingerprint: z.string(), installId: z.uuid(), server: ServerStamp, diagnostics: z.string().optional() })

/** Redact before truncation so a long credential cannot lose its identifying prefix. */
function safeText(text: string, deps: AppDeps): string {
  const homes = [deps.config.env.HOME, deps.config.env.USERPROFILE, homedir(), deps.config.hermesHome, deps.config.stateDir].filter((v): v is string => Boolean(v)).sort((a, b) => b.length - a.length)
  for (const home of homes) text = text.replaceAll(home, '<home>')
  return redactSensitive(text)
    .replace(/(?:<home>|\/(?:Users|home)\/)[^\s'"<>]*/g, '<path>')
    .replace(/\b(?:prompt|transcript|messages|content|body)["']?\s*[:=].*/gi, '[content omitted]')
    .replace(/\b[A-Z][A-Z0-9_]*\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/g, '[environment omitted]')
    .replace(/https?:\/\/[^\s'"<>]+/gi, '<url>')
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
    ...deps.recentErrors().slice(-10).map((line) => safeText(line, deps).split(/\r?\n/, 1)[0]!.slice(0, 300)),
  ]
  const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.from(safeText(lines.join('\n'), deps)).subarray(0, MAX_DIAGNOSTICS_BYTES)).replace(/\uFFFD$/, '')
  return { text, bytes: Buffer.byteLength(text) }
}

export async function submitFeedback(deps: AppDeps, profileHome: string, input: z.infer<typeof FeedbackSubmitSchema>): Promise<{ status: 'sent'; reportId: string }> {
  let outcome = 'feedback_unavailable'
  try {
    const backend = documents(deps)
    const installId = await updateDocument(backend, 'feedback', 'install', (raw) => {
      const id = raw === undefined ? randomUUID() : z.uuid().parse(raw)
      return { value: id, result: id }
    })
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    // Freeze only the server-produced fields. A retry after a lost acknowledgement must send identical bytes,
    // even after logs, versions or registration change. User-written report text is never persisted here.
    const snapshot = await updateDocument(backend, 'feedback', input.requestId, async (raw) => {
      if (raw !== undefined) {
        const saved = Snapshot.parse(raw)
        if (saved.fingerprint !== fingerprint) throw new HttpFailure(400, 'invalid')
        return { value: saved, result: saved }
      }
      const value = { fingerprint, installId, server: ServerStamp.parse({ webVersion: deps.version.slice(0, 64), agentVersion: deps.agentVersion().slice(0, 64) }), ...(input.includeDiagnostics ? { diagnostics: (await feedbackDiagnostics(deps, profileHome)).text } : {}) }
      return { value, result: value }
    })
    const { requestId, kind, title, body: text, client } = input
    const report = { requestId, kind, title, body: text, client }
    const body = JSON.stringify({ ...report, installId: snapshot.installId, server: snapshot.server, ...(snapshot.diagnostics === undefined ? {} : { diagnostics: snapshot.diagnostics }) })
    if (Buffer.byteLength(body) > 32 * 1024) throw new HttpFailure(400, 'invalid')
    const reportId = await deps.relay.submitFeedback(body)
    outcome = 'sent'
    return { status: 'sent', reportId }
  } catch (error) {
    if (error instanceof RelayPairingError) { outcome = error.message; throw new HttpFailure(error.status, error.message, error.extra) }
    if (error instanceof HttpFailure) { outcome = error.message; throw error }
    throw new HttpFailure(503, 'feedback_unavailable')
  } finally { deps.log(`[feedback] ${input.requestId} ${outcome}`) }
}
