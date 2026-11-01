/**
 * TAL-48: per-person session ownership on a shared server. The only trusted person source is a validated OIDC login
 * (issuer + subject recorded on its auth session); request fields, names and headers never name a person.
 */
import { createHash } from 'node:crypto'
import { truthy, type Env } from '../config.js'
import type { SessionInfo } from './store.js'
import { str } from '../util.js'

/** Version of the `person_isolation` capability in `/api/auth/status`. */
export const PERSON_ISOLATION_VERSION = 1

/** The operator opt-in; without it every session stays visible to every login exactly as before. */
export function personIsolationEnabled(env: Env): boolean {
  return truthy(env.HERMES_WEBUI_PERSON_ISOLATION)
}

/**
 * Isolation outside a request (queue workers, a session's tools, push channels): only where sign-in tells people apart,
 * as the request gate, which binds no person on a server without authentication.
 */
export async function personIsolationActive(env: Env, auth: { isAuthEnabled: () => Promise<boolean> }): Promise<boolean> {
  return personIsolationEnabled(env) && await auth.isAuthEnabled()
}

/** The opaque person a login belongs to, with its display name; null for any login that is not a validated OIDC identity. */
export function personIdentity(info: SessionInfo | null | undefined): { id: string; display_name: string } | null {
  if (str(info?.auth_type).trim() !== 'oidc') return null
  const issuer = str(info?.oidc_issuer).trim()
  const subject = typeof info?.oidc_subject === 'string' ? info.oidc_subject : ''
  if (!issuer || !subject.trim()) return null
  const id = `oidc:${createHash('sha256').update(JSON.stringify([issuer, subject]), 'utf8').digest('hex')}`
  return { id, display_name: str(info?.username).trim() || subject }
}

/** A request's session authority while isolation is on; absent means isolation is off (or no request is in scope). */
export interface PersonAccess {
  /** The request's person; null for a login with no trusted person (password, passkey, trusted header). */
  personId: string | null
  /** Existing server-owner authority, which alone reaches sessions no person owns (legacy, imported, scheduled). */
  serverOwner: boolean
}

/**
 * The single ownership rule every session read, write, stream and projection applies: a person's session belongs to
 * that person; an unowned session (created before isolation, by a non-person login, or projected from Agent state)
 * belongs to server owners until it is explicitly shared.
 */
export function personMaySee(access: PersonAccess | null | undefined, owner: unknown): boolean {
  if (!access) return true
  const ownerId = typeof owner === 'string' && owner ? owner : null
  return ownerId ? ownerId === access.personId : access.serverOwner
}
