/**
 * Byte-compatible primitives of Python `api/auth.py`: PBKDF2-HMAC-SHA256
 * (600k iterations, salted with the per-install `.pbkdf2_key`), HMAC-SHA256
 * session/CSRF/profile signatures keyed by `.signing_key`.
 */
import { createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const pbkdf2Async = promisify(pbkdf2)
export const PBKDF2_ITERATIONS = 600_000

export async function hashPassword(password: string, salt: Buffer): Promise<string> {
  const dk = await pbkdf2Async(Buffer.from(password, 'utf8'), salt, PBKDF2_ITERATIONS, 32, 'sha256')
  return dk.toString('hex')
}

export function hmacHex(key: Buffer, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex')
}

/** Constant-time string comparison that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function newSessionToken(): string {
  return randomBytes(32).toString('hex')
}

export function newKey(): Buffer {
  return randomBytes(32)
}

/** Split `<token>.<sig>` on the last dot (Python `rsplit('.', 1)`). */
export function splitSigned(value: string): [string, string] | null {
  const at = value.lastIndexOf('.')
  if (at < 0) return null
  return [value.slice(0, at), value.slice(at + 1)]
}

const ASSET_GRANT_BUCKET_MS = 3_600_000

/** An expiring, domain-separated capability for cookie-free sandbox subresources. */
export function signAssetGrant(key: Buffer, namespace: string, value: string, now = Date.now()): string {
  const exp = (Math.ceil(now / ASSET_GRANT_BUCKET_MS) + 1) * (ASSET_GRANT_BUCKET_MS / 1000)
  const grant = `${Buffer.from(value, 'utf8').toString('base64url')}.${String(exp)}`
  return `${grant}.${hmacHex(key, `${namespace}:${grant}`)}`
}

export function assetGrantValue(key: Buffer, namespace: string, segment: string, now = Date.now()): string | null {
  const parts = segment.split('.')
  if (parts.length !== 3) return null
  const [value, exp, sig] = parts as [string, string, string]
  if (!safeEqual(sig, hmacHex(key, `${namespace}:${value}.${exp}`))) return null
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null
  return Buffer.from(value, 'base64url').toString('utf8')
}
