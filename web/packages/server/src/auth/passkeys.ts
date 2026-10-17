/**
 * Passkeys / WebAuthn (Python `api/passkeys.py`): ES256 only, `attestation: none`,
 * minimal CBOR, rpIdHash + user-presence + counter checks, SPKI PEM storage in
 * `passkeys.json`, bounded challenge store in `.passkey_challenges.json`.
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto'
import type { DocumentBackend } from '../sessions/storage/backend.js'
import { readDocument, updateDocument } from '../sessions/storage/document.js'
import { domainToASCII } from 'node:url'
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
  private readonly credentialsFile = 'passkeys'
  private readonly challengesFile = '.passkey_challenges'

  constructor(private readonly documents: DocumentBackend, private readonly now: () => number = () => Date.now() / 1000) {}

  private async loadJson(key: string): Promise<unknown> {
    try {
      const record = await readDocument(this.documents, 'passkeys', key, { replaceInvalid: true })
      return record?.value ?? null
    } catch { return null }
  }

  private async credentials(): Promise<Credential[]> {
    return this.parseCredentials(await this.loadJson(this.credentialsFile))
  }

  private parseCredentials(raw: unknown): Credential[] {
    return Array.isArray(raw) ? raw.filter((c): c is Dict => isDict(c) && typeof c.id === 'string').map((c) => ({ id: str(c.id), label: str(c.label), public_key_pem: str(c.public_key_pem), sign_count: Number(c.sign_count) || 0, created_at: Number(c.created_at) || 0, last_used_at: typeof c.last_used_at === 'number' ? c.last_used_at : null })) : []
  }

  /** Public metadata only; never the public key. */
  async registered(): Promise<Dict[]> {
    return (await this.credentials()).map((c) => ({ id: c.id, label: c.label || 'Passkey', created_at: c.created_at, last_used_at: c.last_used_at, sign_count: c.sign_count }))
  }

  async available(): Promise<boolean> { return (await this.credentials()).length > 0 }

  private challenges(raw: unknown): Record<string, Challenge> {
    if (!isDict(raw)) return {}
    const now = this.now()
    const clean: Record<string, Challenge> = {}
    for (const [key, value] of Object.entries(raw)) if (isDict(value) && now - (Number(value.ts) || 0) < CHALLENGE_TTL_S) clean[key] = { kind: str(value.kind), rp_id: str(value.rp_id), origin: str(value.origin), ts: Number(value.ts) || 0 }
    return clean
  }

  private async storeChallenge(challenge: string, kind: string, rpId: string, origin: string): Promise<void> {
    await updateDocument(this.documents, 'passkeys', this.challengesFile, (raw) => {
      const data = this.challenges(raw)
      const oldest = (keys: string[]): string | null => keys.sort((a, b) => (data[a]?.ts ?? 0) - (data[b]?.ts ?? 0))[0] ?? null
      for (;;) {
        const same = Object.keys(data).filter((key) => data[key]?.kind === kind && data[key]?.rp_id === rpId && data[key]?.origin === origin)
        if (same.length < MAX_PER_CONTEXT) break
        const victim = oldest(same)
        if (!victim) break
        Reflect.deleteProperty(data, victim)
      }
      while (Object.keys(data).length >= MAX_CHALLENGES) { const victim = oldest(Object.keys(data)); if (!victim) break; Reflect.deleteProperty(data, victim) }
      data[challenge] = { kind, rp_id: rpId, origin, ts: this.now() }
      return { value: data, result: undefined }
    }, { replaceInvalid: true })
  }

  private async consumeChallenge(challenge: string, kind: string): Promise<Challenge> {
    const entry = await updateDocument(this.documents, 'passkeys', this.challengesFile, (raw) => {
      const data = this.challenges(raw)
      const entry = data[challenge]
      Reflect.deleteProperty(data, challenge)
      return { value: data, result: entry }
    }, { replaceInvalid: true })
    if (entry?.kind !== kind) throw new PasskeyError('Passkey challenge expired. Try again.')
    return entry
  }

  async registrationOptions(rpId: string, origin: string): Promise<Dict> {
    const challenge = b64u(randomBytes(32))
    await this.storeChallenge(challenge, 'register', rpId, origin)
    return {
      challenge, rp: { name: RP_NAME, id: rpId }, user: { id: b64u(createHash('sha256').update(rpId).digest().subarray(0, 16)), name: RP_NAME, displayName: RP_NAME },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }, timeout: 60000, attestation: 'none',
      excludeCredentials: (await this.registered()).map((c) => ({ type: 'public-key', id: c.id })),
    }
  }

  async authenticationOptions(rpId: string, origin: string): Promise<Dict> {
    const creds = (await this.registered())
    if (!creds.length) throw new PasskeyError('No passkeys are registered.')
    const challenge = b64u(randomBytes(32))
    await this.storeChallenge(challenge, 'login', rpId, origin)
    return { challenge, rpId, allowCredentials: creds.map((c) => ({ type: 'public-key', id: c.id })), timeout: 60000, userVerification: 'preferred' }
  }

  private async clientData(encoded: unknown, expectedType: string, kind: string): Promise<[Dict, Challenge, Buffer]> {
    const raw = b64uDecode(encoded)
    let data: unknown
    try { data = JSON.parse(raw.toString('utf8')) } catch { throw new PasskeyError('Malformed client data') }
    if (!isDict(data) || data.type !== expectedType) throw new PasskeyError('Unexpected passkey response type')
    if (typeof data.challenge !== 'string') throw new PasskeyError('Missing passkey challenge')
    const entry = (await this.consumeChallenge(data.challenge, kind))
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

  async finishRegistration(payload: Dict): Promise<{ ok: true; credential: { id: string; label: string } }> {
    const response = isDict(payload.response) ? payload.response : {}
    const [, entry] = (await this.clientData(response.clientDataJSON ?? '', 'webauthn.create', 'register'))
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
    await updateDocument(this.documents, 'passkeys', this.credentialsFile, (raw) => {
      const creds = this.parseCredentials(raw).filter((credential) => credential.id !== id)
      creds.push({ id, label, public_key_pem: pem, sign_count: parsed.sign_count, created_at: this.now(), last_used_at: null })
      return { value: creds, result: undefined }
    }, { replaceInvalid: true })
    return { ok: true, credential: { id, label } }
  }

  async finishLogin(payload: Dict): Promise<{ ok: true; credential_id: string }> {
    const response = isDict(payload.response) ? payload.response : {}
    const credId = payload.id ?? payload.rawId
    if (typeof credId !== 'string') throw new PasskeyError('Missing passkey credential id')
    const creds = (await this.credentials())
    const idx = creds.findIndex((c) => c.id === credId)
    if (idx < 0) throw new PasskeyError('Unknown passkey')
    const [, entry, clientRaw] = (await this.clientData(response.clientDataJSON ?? '', 'webauthn.get', 'login'))
    const authData = b64uDecode(response.authenticatorData ?? '')
    const parsed = this.parseAuthData(authData, entry.rp_id)
    const signature = b64uDecode(response.signature ?? '')
    const signed = Buffer.concat([authData, createHash('sha256').update(clientRaw).digest()])
    let ok = false
    try { ok = cryptoVerify('sha256', signed, createPublicKey(creds[idx]!.public_key_pem), signature) } catch { ok = false }
    if (!ok) throw new PasskeyError('Passkey signature verification failed')
    await updateDocument(this.documents, 'passkeys', this.credentialsFile, (raw) => {
      const current = this.parseCredentials(raw)
      const credential = current.find((item) => item.id === credId)
      if (credential?.public_key_pem !== creds[idx]!.public_key_pem) throw new PasskeyError('Unknown passkey')
      if (parsed.sign_count && credential.sign_count && parsed.sign_count <= credential.sign_count) throw new PasskeyError('Passkey sign counter did not advance')
      credential.sign_count = parsed.sign_count || credential.sign_count
      credential.last_used_at = this.now()
      return { value: current, result: undefined }
    }, { replaceInvalid: true })
    return { ok: true, credential_id: credId }
  }

  async delete(credentialId: string): Promise<{ ok: true; credentials: Dict[] }> {
    await updateDocument(this.documents, 'passkeys', this.credentialsFile, (raw) => {
      const creds = this.parseCredentials(raw)
      const kept = creds.filter((credential) => credential.id !== credentialId)
      if (kept.length === creds.length) throw new PasskeyError('Passkey not found')
      return { value: kept, result: undefined }
    }, { replaceInvalid: true })
    return { ok: true, credentials: (await this.registered()) }
  }

  async clear(): Promise<void> {
    if (await this.loadJson(this.credentialsFile)) await updateDocument(this.documents, 'passkeys', this.credentialsFile, () => ({ value: [], result: undefined }), { replaceInvalid: true })
  }
}
