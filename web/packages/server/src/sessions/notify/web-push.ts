/**
 * Browser Web Push channel. VAPID keys and subscriptions live in the document store (secret files under the
 * JSON adapter). Each change diffs every subscribed profile's activity rows against the phase last seen per
 * session and applies the shared alert rule; delivery goes through the vetted, address-pinned fetch because
 * the browser chose the endpoint.
 */
import { createHash } from 'node:crypto'
import webpush from 'web-push'
import { WebPushPreferencesSchema } from '@maudecode/talaria-web-contracts'
import { z } from 'zod'
import { isNonGlobalAddress } from '../../http/addresses.js'
import { vettedAddresses, type DnsLookup, type PinnedFetch } from '../../http/pinned.js'
import type { DocumentBackend } from '../storage/backend.js'
import { readDocument, updateDocument } from '../storage/document.js'
import type { ActivityState, ActivityStates } from './activity.js'
import { alertForTransition, DEFAULT_ALERT_PREFERENCES, type AlertKind, type AlertPreferences } from './alerts.js'
import type { NotificationChannel } from './channel.js'

const MAX_SUBSCRIPTIONS = 64
const MAX_TRIES = 3
const REQUEST_TIMEOUT_MS = 10_000
const LOCAL_SUBJECT = 'mailto:talaria-web@localhost'
const BODY: Record<AlertKind, string> = { approval: 'Approval needed', input: 'Input needed', completion: 'Completed', failure: 'Failed' }

export class WebPushRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

const SubscriptionSchema = z.object({
  endpoint: z.string(), keys: z.object({ p256dh: z.string(), auth: z.string() }), profile: z.string(),
  login: z.string().nullable(), origin: z.string(), preferences: WebPushPreferencesSchema, created_at: z.number(),
})
type Subscription = z.infer<typeof SubscriptionSchema>
const SubscriptionsSchema = z.object({ version: z.literal(1), subscriptions: z.array(SubscriptionSchema) })
const VapidSchema = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) })

export interface WebPushDeps {
  documents: DocumentBackend
  activity: ActivityStates
  lookup: () => DnsLookup
  fetch: () => PinnedFetch
  /** Hashes of the live login sessions (`liveLoginHashes`); a subscription created by a login that is gone is deleted. */
  liveLogins: () => Promise<Set<string>>
  /** A deleted profile's subscriptions are deleted with it. */
  profileExists: (profile: string) => boolean
  env: Record<string, string | undefined>
  now: () => number
  log: (line: string) => void
  sleep?: (ms: number) => Promise<void>
}

export interface WebPushRequester { profile: string; login: string | null; origin: string }

/** Hash of a login token, so the subscription file never holds a credential. */
export const loginHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

/**
 * Hashes of the logins a request would still accept: unexpired, and for OIDC with the identity mapping and
 * profile binding `ensureTrustedAuthSession` checks, so a revoked user stops receiving alerts without a request.
 */
export async function liveLoginHashes<T extends { token: string; auth_type?: unknown }>(auth: { liveSessions: () => readonly T[] }, oidc: { sessionBindingIsCurrent: (info: T) => Promise<boolean> }): Promise<Set<string>> {
  const live = new Set<string>()
  for (const info of auth.liveSessions()) {
    if (info.auth_type === 'oidc' && !(await oidc.sessionBindingIsCurrent(info).catch(() => false))) continue
    live.add(loginHash(info.token))
  }
  return live
}

const parse = (raw: unknown): Subscription[] => raw === undefined || raw === null ? [] : SubscriptionsSchema.parse(raw).subscriptions

function decodedLength(value: string): number { return /^[A-Za-z0-9_-]+={0,2}$/.test(value) ? Buffer.from(value, 'base64url').length : -1 }

export class WebPushChannel implements NotificationChannel {
  readonly id = 'web-push'
  /** profile → session → effective phase last seen. */
  private readonly lastPhase = new Map<string, Map<string, string>>()
  private readonly inFlight = new Set<Promise<void>>()
  private dirty = false
  private running: Promise<void> | null = null
  private stopped = false

  constructor(private readonly deps: WebPushDeps) {}

  stop(): void { this.stopped = true }

  changed(): void {
    if (this.stopped) return
    this.dirty = true
    this.running ??= this.run().finally(() => { this.running = null })
  }

  /** Settles once the current pass and its deliveries are done (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running || this.inFlight.size) await Promise.allSettled([this.running, ...this.inFlight])
  }

  clearDeleted(sid: string): Promise<void> {
    for (const phases of this.lastPhase.values()) phases.delete(sid)
    return Promise.resolve()
  }

  async publicKey(): Promise<string> {
    return (await updateDocument(this.deps.documents, 'web-push', 'vapid', (raw) => {
      const parsed = VapidSchema.safeParse(raw)
      const keys = parsed.success ? parsed.data : webpush.generateVAPIDKeys()
      return { value: { publicKey: keys.publicKey, privateKey: keys.privateKey }, result: keys.publicKey }
    }, { replaceInvalid: true }))
  }

  private async subscriptions(): Promise<Subscription[]> {
    return parse((await readDocument(this.deps.documents, 'web-push-subscriptions', 'subscriptions', { replaceInvalid: true }))?.value)
  }

  private mutate<T>(edit: (subs: Subscription[]) => T): Promise<T> {
    return updateDocument(this.deps.documents, 'web-push-subscriptions', 'subscriptions', (raw) => {
      const subs = parse(raw)
      const result = edit(subs)
      return { value: { version: 1, subscriptions: subs }, result }
    }, { replaceInvalid: true })
  }

  async status(endpoint: string | undefined, requester: WebPushRequester): Promise<{ public_key: string; subscription: { preferences: AlertPreferences } | null }> {
    const sub = endpoint ? (await this.subscriptions()).find((s) => s.endpoint === endpoint && s.profile === requester.profile) : undefined
    return { public_key: await this.publicKey(), subscription: sub ? { preferences: sub.preferences } : null }
  }

  /** Save or update this browser's subscription; the endpoint must be HTTPS on a public address. */
  async subscribe(input: { endpoint: string; keys: { p256dh: string; auth: string }; preferences?: AlertPreferences | undefined }, requester: WebPushRequester): Promise<{ preferences: AlertPreferences }> {
    let url: URL
    try { url = new URL(input.endpoint) } catch { throw new WebPushRequestError('Push endpoint must be an HTTPS URL', 400) }
    if (url.protocol !== 'https:' || url.username || url.password) throw new WebPushRequestError('Push endpoint must be an HTTPS URL', 400)
    try { await vettedAddresses(url.hostname, isNonGlobalAddress, this.deps.lookup()) } catch { throw new WebPushRequestError('Push endpoint must resolve to a public address', 400) }
    if (decodedLength(input.keys.p256dh) !== 65 || decodedLength(input.keys.auth) !== 16) throw new WebPushRequestError('Invalid push subscription keys', 400)
    await this.publicKey()
    const created = Math.floor(this.deps.now())
    const preferences = await this.mutate((subs) => {
      const index = subs.findIndex((s) => s.endpoint === input.endpoint)
      const preferences = input.preferences ?? (index >= 0 && subs[index]!.profile === requester.profile ? subs[index]!.preferences : DEFAULT_ALERT_PREFERENCES)
      if (index >= 0) subs.splice(index, 1)
      subs.push({ endpoint: input.endpoint, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth }, profile: requester.profile, login: requester.login, origin: requester.origin, preferences: { ...preferences }, created_at: created })
      if (subs.length > MAX_SUBSCRIPTIONS) subs.splice(0, subs.length - MAX_SUBSCRIPTIONS)
      return preferences
    })
    // The rows already visible are this subscription's baseline, so subscribing never replays old outcomes.
    this.changed()
    return { preferences }
  }

  async update(endpoint: string, preferences: AlertPreferences, requester: WebPushRequester): Promise<{ preferences: AlertPreferences }> {
    const found = await this.mutate((subs) => {
      const sub = subs.find((s) => s.endpoint === endpoint && s.profile === requester.profile)
      if (sub) sub.preferences = { ...preferences }
      return Boolean(sub)
    })
    if (!found) throw new WebPushRequestError('Push subscription not found', 404)
    return { preferences }
  }

  async unsubscribe(endpoint: string, requester: WebPushRequester): Promise<void> {
    await this.mutate((subs) => {
      const index = subs.findIndex((s) => s.endpoint === endpoint && s.profile === requester.profile)
      if (index >= 0) subs.splice(index, 1)
    })
  }

  /** Logout ends the subscriptions that login created. */
  async forgetLogin(login: string): Promise<void> {
    await this.mutate((subs) => { for (let i = subs.length - 1; i >= 0; i--) if (subs[i]!.login === login) subs.splice(i, 1) })
  }

  private async run(): Promise<void> {
    while (this.dirty && !this.stopped) {
      this.dirty = false
      try { await this.pass() } catch (error) { this.deps.log(`[web-push] notification pass failed (${(error as Error).message})`) }
    }
  }

  private async pass(): Promise<void> {
    let subs = await this.subscriptions()
    if (!subs.length && !this.lastPhase.size) return
    const live = await this.deps.liveLogins()
    const valid = (s: Subscription): boolean => (s.login === null || live.has(s.login)) && this.deps.profileExists(s.profile)
    if (subs.some((s) => !valid(s))) {
      await this.mutate((all) => { for (let i = all.length - 1; i >= 0; i--) if (!valid(all[i]!)) all.splice(i, 1) })
      subs = subs.filter(valid)
    }
    const profiles = new Set(subs.map((s) => s.profile))
    for (const profile of this.lastPhase.keys()) if (!profiles.has(profile)) this.lastPhase.delete(profile)
    for (const profile of profiles) {
      const rows = await this.deps.activity.states(profile, () => { this.changed() })
      const previous = this.lastPhase.get(profile)
      const next = new Map<string, string>()
      for (const row of rows) {
        const phase = row.activityPhase ?? row.phase
        next.set(row.sessionId, phase)
        if (!previous) continue
        for (const sub of subs) {
          if (sub.profile !== profile) continue
          const kind = alertForTransition(previous.get(row.sessionId) ?? null, { phase, alertEligible: row.alertEligible }, sub.preferences)
          if (kind) this.track(this.deliver(sub, row, kind))
        }
      }
      this.lastPhase.set(profile, next)
    }
  }

  private track(delivery: Promise<void>): void {
    const settled = delivery.catch((error: unknown) => { this.deps.log(`[web-push] delivery failed (${(error as Error).message})`) })
    this.inFlight.add(settled)
    void settled.finally(() => this.inFlight.delete(settled))
  }

  private subject(sub: Subscription): string {
    const configured = (this.deps.env.TALARIA_WEB_PUSH_SUBJECT ?? '').trim()
    if (configured) return configured
    return sub.origin.startsWith('https://') ? sub.origin : LOCAL_SUBJECT
  }

  private async stillSubscribed(sub: Subscription): Promise<boolean> {
    if ((sub.login !== null && !(await this.deps.liveLogins()).has(sub.login)) || !this.deps.profileExists(sub.profile)) return false
    return (await this.subscriptions()).some((s) => s.endpoint === sub.endpoint && s.profile === sub.profile && s.login === sub.login)
  }

  private async deliver(sub: Subscription, row: ActivityState, kind: AlertKind): Promise<void> {
    const vapid = VapidSchema.parse((await this.deps.documents.get('web-push', 'vapid'))?.value)
    // The Relay deep link is the app's route; the browser opens the Web chat, resolved against the worker's mount scope.
    const payload = JSON.stringify({ title: row.title, body: BODY[kind], tag: row.sessionId, url: `/session/${encodeURIComponent(row.sessionId)}` })
    const details = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: sub.keys }, payload, {
      vapidDetails: { subject: this.subject(sub), publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: 3600, urgency: kind === 'approval' || kind === 'input' ? 'high' : 'normal', contentEncoding: 'aes128gcm',
    })
    const headers = Object.fromEntries(Object.entries(details.headers).map(([k, v]) => [k, String(v)]))
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref() }))
    let failure = ''
    for (let attempt = 1; attempt <= MAX_TRIES && !this.stopped; attempt++) {
      // Logout, expiry, unsubscribe or a 410 during a retry delay ends the alert with its subscription.
      if (!(await this.stillSubscribed(sub))) return
      try {
        const addresses = await vettedAddresses(new URL(sub.endpoint).hostname, isNonGlobalAddress, this.deps.lookup())
        const res = await this.deps.fetch()(sub.endpoint, { method: 'POST', headers, ...(details.body ? { body: details.body } : {}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, addresses)
        void res.body?.cancel().catch(() => undefined)
        if (res.ok) return
        if (res.status === 404 || res.status === 410) {
          await this.mutate((subs) => { const index = subs.findIndex((s) => s.endpoint === sub.endpoint); if (index >= 0) subs.splice(index, 1) })
          return
        }
        failure = `HTTP ${String(res.status)}`
      } catch (error) {
        failure = (error as Error).message
      }
      if (attempt < MAX_TRIES) await sleep(Math.min(1000 * 4 ** (attempt - 1), 10_000))
    }
    if (failure) this.deps.log(`[web-push] push service refused an alert after ${String(MAX_TRIES)} tries (${failure})`)
  }
}
