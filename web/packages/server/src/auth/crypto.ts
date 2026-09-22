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
