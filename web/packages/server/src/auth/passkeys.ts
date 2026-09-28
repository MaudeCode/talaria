/**
 * Passkeys / WebAuthn (Python `api/passkeys.py`): ES256 only, `attestation: none`,
 * minimal CBOR, rpIdHash + user-presence + counter checks, SPKI PEM storage in
 * `passkeys.json`, bounded challenge store in `.passkey_challenges.json`.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { domainToASCII } from 'node:url'
import { atomicWriteText } from '../fs/atomic.js'
import { isDict, type Dict } from '../config/agent-config.js'
import { str } from '../util.js'

export class PasskeyError extends Error {}
export class PasskeyRateLimitError extends PasskeyError {}

const CHALLENGE_TTL_S = 90
const MAX_CHALLENGES = 128
const MAX_PER_CONTEXT = 8
const RP_NAME = 'Talaria Web'

const b64u = (b: Buffer): string => b.toString('base64url')
const b64uDecode = (v: unknown): Buffer => Buffer.from(str(v).trim(), 'base64url')

interface Credential { id: string; label: string; public_key_pem: string; sign_count: number; created_at: number; last_used_at: number | null }
interface Challenge { kind: string; rp_id: string; origin: string; ts: number }

/** Minimal CBOR decoder (major types 0-5, 7 simple values); indefinite lengths are rejected. */
export function cborDecode(data: Buffer): unknown {
  let pos = 0
  const read = (n: number): Buffer => { if (pos + n > data.length) throw new PasskeyError('Malformed CBOR data'); const out = data.subarray(pos, pos + n); pos += n; return out }
  const val = (addl: number): number => {
    if (addl < 24) return addl
    if (addl === 24) return read(1)[0] ?? 0
    if (addl === 25) return read(2).readUInt16BE(0)
    if (addl === 26) return read(4).readUInt32BE(0)
    if (addl === 27) return Number(read(8).readBigUInt64BE(0))
    throw new PasskeyError('Indefinite CBOR values are not supported')
  }
  const item = (): unknown => {
    const initial = read(1)[0] ?? 0
    const major = initial >> 5
    const v = val(initial & 0x1f)
    if (major === 0) return v
    if (major === 1) return -1 - v
    if (major === 2) return Buffer.from(read(v))
    if (major === 3) return read(v).toString('utf8')
    if (major === 4) return Array.from({ length: v }, () => item())
    if (major === 5) { const m = new Map<unknown, unknown>(); for (let i = 0; i < v; i += 1) { const k = item(); m.set(k, item()) } return m }
    if (major === 7) { if (v === 20) return false; if (v === 21) return true; if (v === 22) return null }
    throw new PasskeyError('Unsupported CBOR data')
  }
  const value = item()
  if (pos !== data.length) throw new PasskeyError('Trailing CBOR data')
  return value
}

function hostWithoutPort(host: string): string {
  const h = (host || 'localhost').trim().split(',', 1)[0] ?? 'localhost'
  if (h.startsWith('[') && h.includes(']')) return h.slice(1, h.indexOf(']'))
  return h.includes(':') ? h.slice(0, h.lastIndexOf(':')) : h
}

/** Python `rp_context`: RP id and origin from the browser Origin, else Host + proto. */
export function rpContext(headers: { origin?: string | undefined; host?: string | undefined; forwardedProto?: string | undefined }, secure: boolean): [string, string] {
  const origin = (headers.origin ?? '').trim()
  if (origin) {
    try {
      const u = new URL(origin)
      if (['http:', 'https:'].includes(u.protocol) && u.hostname) {
        const host = u.hostname.includes(':') && !u.hostname.startsWith('[') ? `[${u.hostname}]` : u.hostname
        return [u.hostname.replace(/^\[|\]$/g, ''), `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`]
      }
    } catch { /* fall through */ }
  }
  const host = hostWithoutPort(headers.host ?? 'localhost')
  let proto = (headers.forwardedProto ?? '').split(',', 1)[0]?.trim().toLowerCase() ?? ''
  if (proto !== 'http' && proto !== 'https') proto = secure ? 'https' : 'http'
  return [host, `${proto}://${headers.host ?? host}`]
}

export class PasskeyStore {
  private readonly credentialsFile: string
  private readonly challengesFile: string

  constructor(private readonly stateDir: string, private readonly now: () => number = () => Date.now() / 1000) {
    this.credentialsFile = join(stateDir, 'passkeys.json')
    this.challengesFile = join(stateDir, '.passkey_challenges.json')
  }

  private loadJson(path: string): unknown {
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null } catch { return null }
  }

  private writeJson(path: string, payload: unknown): void {
    mkdirSync(this.stateDir, { recursive: true })
    atomicWriteText(path, JSON.stringify(payload, sortedReplacer, 2), { mode: 0o600 })
    try { chmodSync(path, 0o600) } catch { /* best effort */ }
  }

  private credentials(): Credential[] {
    const raw = this.loadJson(this.credentialsFile)
    return Array.isArray(raw) ? raw.filter((c): c is Dict => isDict(c) && typeof c.id === 'string').map((c) => ({ id: str(c.id), label: str(c.label), public_key_pem: str(c.public_key_pem), sign_count: Number(c.sign_count) || 0, created_at: Number(c.created_at) || 0, last_used_at: typeof c.last_used_at === 'number' ? c.last_used_at : null })) : []
  }

  /** Public metadata only; never the public key. */
  registered(): Dict[] {
    return this.credentials().map((c) => ({ id: c.id, label: c.label || 'Passkey', created_at: c.created_at, last_used_at: c.last_used_at, sign_count: c.sign_count }))
  }

  available(): boolean { return this.credentials().length > 0 }

  private challenges(): Record<string, Challenge> {
    const raw = this.loadJson(this.challengesFile)
    if (!isDict(raw)) return {}
    const now = this.now()
    const clean: Record<string, Challenge> = {}
    for (const [k, v] of Object.entries(raw)) if (isDict(v) && now - (Number(v.ts) || 0) < CHALLENGE_TTL_S) clean[k] = { kind: str(v.kind), rp_id: str(v.rp_id), origin: str(v.origin), ts: Number(v.ts) || 0 }
    if (Object.keys(clean).length !== Object.keys(raw).length) this.writeJson(this.challengesFile, clean)
    return clean
  }

  private storeChallenge(challenge: string, kind: string, rpId: string, origin: string): void {
    const data = this.challenges()
    const oldest = (keys: string[]): string | null => keys.sort((a, b) => (data[a]?.ts ?? 0) - (data[b]?.ts ?? 0))[0] ?? null
    for (;;) {
      const same = Object.keys(data).filter((k) => data[k]?.kind === kind && data[k]?.rp_id === rpId && data[k]?.origin === origin)
      if (same.length < MAX_PER_CONTEXT) break
      const victim = oldest(same)
      if (!victim) break
      Reflect.deleteProperty(data, victim)
    }
    while (Object.keys(data).length >= MAX_CHALLENGES) { const victim = oldest(Object.keys(data)); if (!victim) break; Reflect.deleteProperty(data, victim) }
    data[challenge] = { kind, rp_id: rpId, origin, ts: this.now() }
    this.writeJson(this.challengesFile, data)
  }

  private consumeChallenge(challenge: string, kind: string): Challenge {
    const data = this.challenges()
    const entry = data[challenge]
    Reflect.deleteProperty(data, challenge)
    this.writeJson(this.challengesFile, data)
    if (entry?.kind !== kind) throw new PasskeyError('Passkey challenge expired. Try again.')
    return entry
  }

  registrationOptions(rpId: string, origin: string): Dict {
    const challenge = b64u(randomBytes(32))
    this.storeChallenge(challenge, 'register', rpId, origin)
    return {
      challenge, rp: { name: RP_NAME, id: rpId }, user: { id: b64u(createHash('sha256').update(rpId).digest().subarray(0, 16)), name: RP_NAME, displayName: RP_NAME },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }, timeout: 60000, attestation: 'none',
      excludeCredentials: this.registered().map((c) => ({ type: 'public-key', id: c.id })),
    }
  }

  authenticationOptions(rpId: string, origin: string): Dict {
    const creds = this.registered()
    if (!creds.length) throw new PasskeyError('No passkeys are registered.')
    const challenge = b64u(randomBytes(32))
    this.storeChallenge(challenge, 'login', rpId, origin)
    return { challenge, rpId, allowCredentials: creds.map((c) => ({ type: 'public-key', id: c.id })), timeout: 60000, userVerification: 'preferred' }
  }

  private clientData(encoded: unknown, expectedType: string, kind: string): [Dict, Challenge, Buffer] {
    const raw = b64uDecode(encoded)
    let data: unknown
    try { data = JSON.parse(raw.toString('utf8')) } catch { throw new PasskeyError('Malformed client data') }
    if (!isDict(data) || data.type !== expectedType) throw new PasskeyError('Unexpected passkey response type')
    if (typeof data.challenge !== 'string') throw new PasskeyError('Missing passkey challenge')
    const entry = this.consumeChallenge(data.challenge, kind)
    if (data.origin !== entry.origin) throw new PasskeyError('Passkey origin mismatch')
    return [data, entry, raw]
  }

  private parseAuthData(authData: Buffer, rpId: string): { flags: number; sign_count: number; rest: Buffer } {
    if (authData.length < 37) throw new PasskeyError('Malformed authenticator data')
    const expected = createHash('sha256').update(domainToASCII(rpId) || rpId, 'ascii').digest()
    if (!timingSafeEqual(authData.subarray(0, 32), expected)) throw new PasskeyError('Passkey RP ID mismatch')
    const flags = authData[32] ?? 0
    if (!(flags & 0x01)) throw new PasskeyError('Passkey user presence was not verified')
    return { flags, sign_count: authData.readUInt32BE(33), rest: authData.subarray(37) }
  }

  finishRegistration(payload: Dict): { ok: true; credential: { id: string; label: string } } {
    const response = isDict(payload.response) ? payload.response : {}
    const [, entry] = this.clientData(response.clientDataJSON ?? '', 'webauthn.create', 'register')
    const att = cborDecode(b64uDecode(response.attestationObject ?? ''))
    if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new PasskeyError('Malformed attestation object')
    const parsed = this.parseAuthData(att.get('authData') as Buffer, entry.rp_id)
    if (!(parsed.flags & 0x40)) throw new PasskeyError('Passkey credential data missing')
    const rest = parsed.rest
    if (rest.length < 18) throw new PasskeyError('Malformed credential data')
    const credLen = rest.readUInt16BE(16)
    const credentialId = rest.subarray(18, 18 + credLen)
    const cose = cborDecode(rest.subarray(18 + credLen))
    if (!(cose instanceof Map)) throw new PasskeyError('Only ES256 passkeys are supported')
    const x: unknown = cose.get(-2)
    const y: unknown = cose.get(-3)
    if (cose.get(3) !== -7 || cose.get(1) !== 2 || cose.get(-1) !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new PasskeyError('Only ES256 passkeys are supported')
    let pem: string
    try { pem = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString() } catch { throw new PasskeyError('Only ES256 passkeys are supported') }
    const id = b64u(credentialId)
    const label = str(payload.label).trim().slice(0, 80) || 'Passkey'
    const creds = this.credentials().filter((c) => c.id !== id)
    creds.push({ id, label, public_key_pem: pem, sign_count: parsed.sign_count, created_at: this.now(), last_used_at: null })
    this.writeJson(this.credentialsFile, creds)
    return { ok: true, credential: { id, label } }
  }

  finishLogin(payload: Dict): { ok: true; credential_id: string } {
    const response = isDict(payload.response) ? payload.response : {}
    const credId = payload.id ?? payload.rawId
    if (typeof credId !== 'string') throw new PasskeyError('Missing passkey credential id')
    const creds = this.credentials()
    const idx = creds.findIndex((c) => c.id === credId)
    if (idx < 0) throw new PasskeyError('Unknown passkey')
    const [, entry, clientRaw] = this.clientData(response.clientDataJSON ?? '', 'webauthn.get', 'login')
    const authData = b64uDecode(response.authenticatorData ?? '')
    const parsed = this.parseAuthData(authData, entry.rp_id)
    const signature = b64uDecode(response.signature ?? '')
    const signed = Buffer.concat([authData, createHash('sha256').update(clientRaw).digest()])
    let ok = false
    try { ok = cryptoVerify('sha256', signed, createPublicKey(creds[idx]!.public_key_pem), signature) } catch { ok = false }
    if (!ok) throw new PasskeyError('Passkey signature verification failed')
    const cred = creds[idx]!
    if (parsed.sign_count && cred.sign_count && parsed.sign_count <= cred.sign_count) throw new PasskeyError('Passkey sign counter did not advance')
    cred.sign_count = parsed.sign_count || cred.sign_count
    cred.last_used_at = this.now()
    this.writeJson(this.credentialsFile, creds)
    return { ok: true, credential_id: credId }
  }

  delete(credentialId: string): { ok: true; credentials: Dict[] } {
    const creds = this.credentials()
    const kept = creds.filter((c) => c.id !== credentialId)
    if (kept.length === creds.length) throw new PasskeyError('Passkey not found')
    this.writeJson(this.credentialsFile, kept)
    return { ok: true, credentials: this.registered() }
  }

  clear(): void {
    if (existsSync(this.credentialsFile)) this.writeJson(this.credentialsFile, [])
  }
}

function sortedReplacer(this: unknown, _key: string, value: unknown): unknown {
  return isDict(value) ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])) : value
}
