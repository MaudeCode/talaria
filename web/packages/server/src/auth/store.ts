/**
 * Session, key, password-hash, and login-rate state (Python `api/auth.py`).
 * Every on-disk artefact keeps its Python name and format so an install can
 * switch backends without a forced logout: `.pbkdf2_key`, `.signing_key`,
 * `.sessions.json`, `.login_attempts.json`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { atomicWriteTextAsync } from '../fs/atomic.js'
import { truthy, type Env } from '../config.js'
import type { SettingsStore } from '../settings.js'
import { COOKIE_NAME_RE } from './cookies.js'
import { hashPassword, hmacHex, newKey, newSessionToken, safeEqual, splitSigned } from './crypto.js'

export const SESSION_TTL = 86400 * 30
export const COOKIE_NAME = 'hermes_session'
export const CSRF_HEADER_NAME = 'X-Hermes-CSRF-Token'
const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_WINDOW = 60

export interface SessionRecord {
  expiry: number
  auth_type?: string | null
  username?: string | null
  bound_profile?: string | null
  oidc_mapping_fingerprint?: string | null
  oidc_profile_identity?: string | null
  oidc_issuer?: string | null
  oidc_subject?: string | null
  oidc_owner?: boolean
  [key: string]: unknown
}

export interface SessionInfo extends SessionRecord {
  token: string
  auth_type: string | null
  username: string | null
  bound_profile: string | null
}

type StoredSession = number | SessionRecord

const OIDC_KEEP = new Set(['oidc_mapping_fingerprint', 'oidc_profile_identity', 'oidc_issuer', 'oidc_subject', 'oidc_owner'])

export function sessionExpiry(record: unknown): number | null {
  const raw = record && typeof record === 'object' ? ((record as SessionRecord).expiry ?? (record as Record<string, unknown>).expires_at) : record
  const expiry = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isFinite(expiry) ? expiry : null
}

export interface AuthStoreOptions {
  stateDir: string
  env: Env
  settings: SettingsStore
  log?: (line: string) => void
  /** Seconds since the epoch; tests inject a clock. */
  now?: () => number
  /** At least one passkey credential is registered (feature flag applied by the caller). */
  passkeysEnabled?: () => boolean
  /** Last-known OIDC availability (sync for the auth gate). */
  oidcEnabled?: () => boolean
  /** Refresh the OIDC config before `isAuthEnabled` answers; errors are swallowed. */
  oidcProbe?: () => Promise<unknown>
  /** `webui_passkey_enabled` from the base-home config.yaml (last known), consulted when the env flag is unset. */
  passkeyConfigFlag?: () => unknown
  /** Writes one serialized table; tests inject a slow or failing writer. */
  persistWrite?: (file: string, text: string) => Promise<void>
}

async function writeSecretFile(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await atomicWriteTextAsync(file, text, { mode: 0o600 })
}

/**
 * Write-behind for one file: at most one write in flight; requests made meanwhile coalesce into one follow-up that
 * snapshots the table as it is then, so writes never reorder and the file converges on the newest state.
 */
class WriteBehind {
  private running: Promise<void> | null = null
  private dirty = false

  constructor(private readonly write: () => Promise<void>) {}

  request(): void {
    if (this.running) this.dirty = true
    else this.running = this.drain()
  }

  private async drain(): Promise<void> {
    try {
      do {
        this.dirty = false
        await this.write()
      } while (this.dirty)
    } finally {
      this.running = null
    }
  }

  get busy(): boolean {
    return this.running !== null
  }

  /** Resolves once the in-flight write and any coalesced follow-up have landed. */
  flush(): Promise<void> {
    return this.running ?? Promise.resolve()
  }
}

/** Returned while settings.json cannot be read: auth counts as enabled and no password verifies against it. */
const UNREADABLE_PASSWORD_HASH = 'unreadable'

export class AuthStore {
  readonly stateDir: string
  readonly env: Env
  readonly settings: SettingsStore
  readonly now: () => number
  private readonly log: (line: string) => void
  private readonly sessionsFile: string
  private readonly attemptsFile: string
  private sessions: Record<string, StoredSession>
  private attempts: Record<string, number[]>
  private pbkdf2KeyCache: Buffer | null = null
  private signingKeyCache: Buffer | null = null
  private passwordHash: { computed: boolean; value: string | null; pending: Promise<string | null> | null } = { computed: false, value: null, pending: null }
  private readonly warned = new Set<string>()
  passkeysEnabled: () => boolean
  oidcEnabled: () => boolean
  private readonly oidcProbe: () => Promise<unknown>
  passkeyConfigFlag: () => unknown
  persistWrite: (file: string, text: string) => Promise<void>
  // The in-memory tables are authoritative; disk is a write-behind copy so a slow fsync never blocks a request.
  private readonly sessionsWriter = new WriteBehind(() => this.persistWrite(this.sessionsFile, JSON.stringify(this.sessions)).catch((error: unknown) => {
    this.warnPersistence('Auth session persistence failed', this.sessionsFile, error, 'keeping the in-process session table available')
  }))
  private readonly attemptsWriter = new WriteBehind(() => this.persistWrite(this.attemptsFile, JSON.stringify(this.attempts)).catch(() => {
    /* debug-level in Python */
  }))

  constructor(opts: AuthStoreOptions) {
    this.stateDir = opts.stateDir
    this.env = opts.env
    this.settings = opts.settings
    this.now = opts.now ?? (() => Date.now() / 1000)
    this.log = opts.log ?? ((line) => { console.error(line) })
    this.sessionsFile = resolve(this.stateDir, '.sessions.json')
    this.attemptsFile = resolve(this.stateDir, '.login_attempts.json')
    this.sessions = this.loadSessions()
    this.attempts = this.loadLoginAttempts()
    this.passkeysEnabled = opts.passkeysEnabled ?? (() => false)
    this.oidcEnabled = opts.oidcEnabled ?? (() => false)
    this.oidcProbe = opts.oidcProbe ?? (() => Promise.resolve())
    this.passkeyConfigFlag = opts.passkeyConfigFlag ?? (() => undefined)
    this.persistWrite = opts.persistWrite ?? writeSecretFile
  }

  /**
   * Awaits every pending session and login-attempt write; orderly shutdown and restart call it before exiting. Loops
   * until both writers are idle, because a request still being served can start a write while this one waits.
   */
  async flushPersistence(): Promise<void> {
    while (this.sessionsWriter.busy || this.attemptsWriter.busy) await Promise.all([this.sessionsWriter.flush(), this.attemptsWriter.flush()])
  }

  private warnPersistence(prefix: string, artifact: string, error: unknown, consequence: string): void {
    const err = error as { name?: string; message?: string }
    this.log(`[webui] WARNING: ${prefix} at ${artifact} (STATE_DIR=${this.stateDir}): ${err.name ?? 'Error'}: ${err.message ?? String(error)}; ${consequence}`)
  }

  warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.log(`[webui] WARNING: ${message}`)
  }

  // ── keys ──────────────────────────────────────────────────────────────────

  private loadKey(filename: string): Buffer {
    const file = resolve(this.stateDir, filename)
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file)
        if (raw.length >= 32) return raw.subarray(0, 32)
      }
    } catch (error) {
      this.warnPersistence('Auth key read failed', file, error, 'generating a new key and continuing')
    }
    const key = newKey()
    try {
      mkdirSync(this.stateDir, { recursive: true })
      writeFileSync(file, key)
      chmodSync(file, 0o600)
    } catch (error) {
      this.warnPersistence('Auth key persistence failed', file, error, 'returning the generated key so startup can continue')
    }
    return key
  }

  pbkdf2Key(): Buffer {
    this.pbkdf2KeyCache ??= this.loadKey('.pbkdf2_key')
    return this.pbkdf2KeyCache
  }

  signingKey(): Buffer {
    this.signingKeyCache ??= this.loadKey('.signing_key')
    return this.signingKeyCache
  }

  /** Tests inject fixed keys to assert byte compatibility with Python outputs. */
  setKeysForTest(pbkdf2Key: Buffer, signingKey: Buffer): void {
    this.pbkdf2KeyCache = pbkdf2Key
    this.signingKeyCache = signingKey
  }

  hashPassword(password: string, salt?: Buffer): Promise<string> {
    return hashPassword(password, salt ?? this.pbkdf2Key())
  }

  // ── password hash / enablement ────────────────────────────────────────────

  invalidatePasswordHashCache(): void {
    this.passwordHash = { computed: false, value: null, pending: null }
  }

  async getPasswordHash(): Promise<string | null> {
    if (this.passwordHash.computed) return this.passwordHash.value
    if (this.passwordHash.pending) return this.passwordHash.pending
    // Single flight: a burst of requests computes PBKDF2 once (Python's double-checked lock).
    let settled = false
    const pending = (async () => {
      const envPw = (this.env.HERMES_WEBUI_PASSWORD ?? '').trim()
      let stored: unknown
      try {
        stored = this.settings.readRaw({ strict: true }).password_hash
      } catch (error) {
        // An unreadable settings.json (permissions, I/O, corrupt JSON) must not read as "no password": report a hash
        // that no input can match, and do not cache so the next request retries the read.
        settled = true
        this.passwordHash = { computed: false, value: null, pending: null }
        this.log(`[auth] settings.json unreadable; password auth stays enabled and login is refused: ${(error as Error).message}`)
        return UNREADABLE_PASSWORD_HASH
      }
      const value = envPw ? await this.hashPassword(envPw) : typeof stored === 'string' && stored ? stored : null
      settled = true
      this.passwordHash = { computed: true, value, pending: null }
      return value
    })()
    if (!settled) this.passwordHash.pending = pending
    return pending
  }

  async isPasswordAuthEnabled(): Promise<boolean> {
    return (await this.getPasswordHash()) !== null
  }

  /** Python `_passkey_feature_flag_enabled`: env wins, else `webui_passkey_enabled` in the operator config. */
  /** The flag as configured: `null` while the operator config cannot be read (the last-known snapshot is cold). */
  passkeyFeatureFlagState(): boolean | null {
    const raw = this.env.HERMES_WEBUI_PASSKEY ?? ''
    if (raw) return truthy(raw)
    const cfg = this.passkeyConfigFlag()
    if (cfg === null) return null
    if (typeof cfg === 'boolean') return cfg
    if (typeof cfg === 'string') return truthy(cfg)
    return false
  }

  passkeyFeatureFlagEnabled(): boolean {
    return this.passkeyFeatureFlagState() === true
  }

  /**
   * Feature flag AND at least one registered credential (Python `are_passkeys_enabled`). With credentials on disk and
   * the flag unknown (sidecar down, config changed underneath), the gate stays closed rather than opening the API.
   */
  passkeysAvailable(): boolean {
    return this.passkeysEnabled() && this.passkeyFeatureFlagState() !== false
  }

  isTrustedAuthEnabled(): boolean {
    return Boolean((this.env.HERMES_WEBUI_TRUSTED_AUTH_HEADER ?? '').trim())
  }

  async isAuthEnabled(): Promise<boolean> {
    if (await this.isPasswordAuthEnabled()) return true
    if (this.passkeysAvailable() || this.isTrustedAuthEnabled()) return true
    try { await this.oidcProbe() } catch { /* last-known config stands */ }
    return this.oidcEnabled()
  }

  async verifyPassword(plain: string): Promise<boolean> {
    const expected = await this.getPasswordHash()
    if (!expected) return false
    if (safeEqual(await this.hashPassword(plain), expected)) return true
    const legacySalt = this.signingKey()
    if (!legacySalt.equals(this.pbkdf2Key()) && safeEqual(await this.hashPassword(plain, legacySalt), expected)) {
      await this.settings.save({ _set_password: plain })
      return true
    }
    return false
  }

  // ── TTL / cookie policy ───────────────────────────────────────────────────

  resolveSessionTtl(): number {
    const envV = (this.env.HERMES_WEBUI_SESSION_TTL ?? '').trim()
    if (/^\d+$/.test(envV)) {
      const val = Number.parseInt(envV, 10)
      if (val >= 60 && val <= 86400 * 365) return val
    }
    const v = this.settings.load().session_ttl_seconds
    if (typeof v === 'number' && Number.isInteger(v) && v >= 60 && v <= 86400 * 365) return v
    return SESSION_TTL
  }

  resolveSessionSliding(): boolean {
    const value = (this.env.HERMES_WEBUI_SESSION_SLIDING ?? '').trim().toLowerCase()
    if (value) return ['1', 'true', 'yes', 'on'].includes(value)
    let webui: unknown
    try {
      webui = this.settings.readRaw({ strict: true }).webui ?? {}
    } catch (error) {
      this.warnOnce('session-sliding-settings', `Cannot read session sliding policy (${(error as Error).name}); session renewal is disabled`)
      return false
    }
    if (!webui || typeof webui !== 'object' || Array.isArray(webui)) return false
    const sliding = (webui as Record<string, unknown>).session_sliding
    return sliding === undefined || sliding === true
  }

  cookieName(): string {
    const name = (this.env.HERMES_WEBUI_COOKIE_NAME ?? '').trim()
    if (!name) return COOKIE_NAME
    if (COOKIE_NAME_RE.test(name)) return name
    this.warnOnce('cookie-name', `Ignoring invalid HERMES_WEBUI_COOKIE_NAME=${JSON.stringify(name)}; falling back to ${JSON.stringify(COOKIE_NAME)} (name must be a valid RFC 6265 token)`)
    return COOKIE_NAME
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  private loadSessions(): Record<string, StoredSession> {
    let data: unknown
    try {
      if (!existsSync(this.sessionsFile)) return {}
      data = JSON.parse(readFileSync(this.sessionsFile, 'utf8'))
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('malformed sessions file: expected dict')
    } catch (error) {
      const prefix = (error as NodeJS.ErrnoException).code ? 'Auth session store read failed' : 'Ignoring malformed auth session store'
      this.warnPersistence(prefix, this.sessionsFile, error, 'starting fresh with an empty session table')
      return {}
    }
    const now = this.now()
    const sessions: Record<string, StoredSession> = {}
    for (const [token, record] of Object.entries(data as Record<string, unknown>)) {
      if (!token) continue
      const expiry = sessionExpiry(record)
      if (expiry === null || expiry <= now) continue
      if (record && typeof record === 'object') {
        const normalized: SessionRecord = { expiry }
        for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
          if (key.startsWith('oidc_') && !OIDC_KEEP.has(key)) continue
          normalized[key] = value
        }
        normalized.expiry = expiry
        sessions[token] = normalized
      } else {
        sessions[token] = expiry
      }
    }
    return sessions
  }

  private persistSessions(): void {
    this.sessionsWriter.request()
  }

  /** Test seam: the in-memory table, keyed by raw token. */
  get sessionTable(): Record<string, StoredSession> {
    return this.sessions
  }

  signToken(token: string): string {
    return hmacHex(this.signingKey(), token)
  }

  createSession(opts: { authType?: string | null; username?: string | null; boundProfile?: string | null; oidcBinding?: Record<string, unknown> | null } = {}): string {
    const token = newSessionToken()
    const expiry = this.now() + this.resolveSessionTtl()
    const typed = [opts.authType, opts.username, opts.boundProfile, opts.oidcBinding].some((v) => v !== null && v !== undefined)
    let record: StoredSession = expiry
    if (typed) {
      record = { expiry, auth_type: opts.authType ?? null, username: opts.username ?? null, bound_profile: opts.boundProfile ?? null }
      if (opts.oidcBinding) {
        record.oidc_mapping_fingerprint = (opts.oidcBinding.mapping_fingerprint as string | undefined) ?? null
        record.oidc_profile_identity = (opts.oidcBinding.profile_identity as string | undefined) ?? null
        record.oidc_issuer = (opts.oidcBinding.issuer as string | undefined) ?? null
        record.oidc_subject = (opts.oidcBinding.subject as string | undefined) ?? null
        if (opts.oidcBinding.owner) record.oidc_owner = true
      }
    }
    this.sessions[token] = record
    this.persistSessions()
    return `${token}.${this.signToken(token)}`
  }

  private pruneExpiredSessions(): void {
    const now = this.now()
    let changed = false
    for (const [token, record] of Object.entries(this.sessions)) {
      const expiry = sessionExpiry(record)
      if (expiry === null || now > expiry) {
        Reflect.deleteProperty(this.sessions, token)
        changed = true
      }
    }
    if (changed) this.persistSessions()
  }

  verifySession(cookieValue: string | null | undefined): boolean {
    if (!cookieValue) return false
    const parts = splitSigned(cookieValue)
    if (!parts) return false
    this.pruneExpiredSessions()
    const [token, sig] = parts
    const full = this.signToken(token)
    const valid = safeEqual(sig, full) || (sig.length === 32 && safeEqual(sig, full.slice(0, 32)))
    if (!valid) return false
    const expiry = sessionExpiry(this.sessions[token])
    if (expiry === null || this.now() > expiry) {
      Reflect.deleteProperty(this.sessions, token)
      this.persistSessions()
      return false
    }
    return true
  }

  static tokenFromCookieValue(cookieValue: string | null | undefined): string | null {
    if (!cookieValue) return null
    const parts = splitSigned(cookieValue)
    return parts?.[0] ?? null
  }

  getSessionInfo(cookieValue: string | null | undefined): SessionInfo | null {
    if (!this.verifySession(cookieValue)) return null
    const token = AuthStore.tokenFromCookieValue(cookieValue)
    if (!token) return null
    const record = this.sessions[token]
    const expiry = sessionExpiry(record)
    if (expiry === null) return null
    const info: SessionInfo = { token, expiry, auth_type: null, username: null, bound_profile: null }
    if (record && typeof record === 'object') {
      for (const [k, v] of Object.entries(record)) if (k !== 'expiry') info[k] = v
      if (!('bound_profile' in record) && typeof record.profile === 'string') info.bound_profile = record.profile
    }
    info.auth_type = (info.auth_type) ?? null
    info.username = (info.username) ?? null
    info.bound_profile = (info.bound_profile) ?? null
    return info
  }

  invalidateSession(cookieValue: string | null | undefined): void {
    const token = AuthStore.tokenFromCookieValue(cookieValue)
    if (!token) return
    Reflect.deleteProperty(this.sessions, token)
    this.persistSessions()
  }

  /**
   * Logout: resolves once the revocation is on disk, so a crash cannot revive a cookie the user was told is gone.
   * Concurrent calls join the same pending write; ordinary verification never waits on disk.
   */
  async revokeSession(cookieValue: string | null | undefined): Promise<void> {
    this.invalidateSession(cookieValue)
    await this.sessionsWriter.flush()
  }

  /**
   * Sliding renewal: extend a live session when its remaining lifetime has
   * dropped below TTL minus min(TTL/10, 1h). Returns true when extended.
   */
  extendSession(cookieValue: string, ttl: number): boolean {
    const token = AuthStore.tokenFromCookieValue(cookieValue)
    if (!token) return false
    const record = this.sessions[token]
    const expiry = sessionExpiry(record)
    const now = this.now()
    if (expiry === null || now >= expiry || expiry - now >= ttl - Math.min(ttl / 10, 3600)) return false
    const updated: SessionRecord = record && typeof record === 'object' ? { ...record } : { expiry }
    updated.expiry = now + ttl
    this.sessions[token] = updated
    this.persistSessions()
    return true
  }

  // ── CSRF and profile cookie signatures ────────────────────────────────────

  csrfTokenForSession(cookieValue: string | null | undefined): string | null {
    const token = AuthStore.tokenFromCookieValue(cookieValue)
    return token ? hmacHex(this.signingKey(), `csrf:${token}`) : null
  }

  verifyCsrfToken(cookieValue: string, csrfToken: string): boolean {
    if (!cookieValue || !csrfToken || !this.verifySession(cookieValue)) return false
    const expected = this.csrfTokenForSession(cookieValue)
    return Boolean(expected && safeEqual(csrfToken, expected))
  }

  signProfileCookieValue(profileName: string, sessionCookieValue: string | null | undefined): string {
    if (!sessionCookieValue || !this.verifySession(sessionCookieValue)) throw new Error('active auth session is required to sign profile cookie')
    const token = AuthStore.tokenFromCookieValue(sessionCookieValue)
    if (!token) throw new Error('active auth session is required to sign profile cookie')
    return `${profileName}.${hmacHex(this.signingKey(), `profile:${token}:${profileName}`)}`
  }

  verifyProfileCookieValue(cookieValue: string, sessionCookieValue: string | null | undefined, validName: (name: string) => boolean): string | null {
    const parts = splitSigned(cookieValue)
    if (!parts || !sessionCookieValue || !this.verifySession(sessionCookieValue)) return null
    const [profileName, sig] = parts
    const token = AuthStore.tokenFromCookieValue(sessionCookieValue)
    if (!profileName || !token || !sig) return null
    if (!validName(profileName)) return null
    const expected = hmacHex(this.signingKey(), `profile:${token}:${profileName}`)
    return safeEqual(sig, expected) ? profileName : null
  }

  // ── login rate limit ──────────────────────────────────────────────────────

  private loadLoginAttempts(): Record<string, number[]> {
    try {
      if (!existsSync(this.attemptsFile)) return {}
      const data = JSON.parse(readFileSync(this.attemptsFile, 'utf8')) as unknown
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
      const now = this.now()
      const attempts: Record<string, number[]> = {}
      for (const [ip, times] of Object.entries(data as Record<string, unknown>)) {
        if (!Array.isArray(times)) continue
        const fresh = times.filter((t): t is number => typeof t === 'number' && now - t < LOGIN_WINDOW)
        if (fresh.length) attempts[ip] = fresh
      }
      return attempts
    } catch {
      return {}
    }
  }

  private saveLoginAttempts(): void {
    this.attemptsWriter.request()
  }

  checkLoginRate(ip: string): boolean {
    const now = this.now()
    const stored = this.attempts[ip] ?? []
    const attempts = stored.filter((t) => now - t < LOGIN_WINDOW)
    if (attempts.length) this.attempts[ip] = attempts
    else Reflect.deleteProperty(this.attempts, ip)
    if (attempts.length !== stored.length) this.saveLoginAttempts()
    return attempts.length < LOGIN_MAX_ATTEMPTS
  }

  recordLoginAttempt(ip: string): void {
    const list = this.attempts[ip] ?? []
    list.push(this.now())
    this.attempts[ip] = list
    this.saveLoginAttempts()
  }

  clearLoginAttempts(ip: string): void {
    if (ip in this.attempts) {
      Reflect.deleteProperty(this.attempts, ip)
      this.saveLoginAttempts()
    }
  }
}
