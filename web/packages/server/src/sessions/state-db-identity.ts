import { createHash } from 'node:crypto'

type Message = Record<string, unknown>

/** The database row identity, including an archive-proven compaction copy's original id. */
export function stateDbRowId(message: Message): number | null {
  const id = message._state_db_row_id
  return typeof id === 'number' && Number.isFinite(id) ? id : null
}

/** Direct and absorbed durable identities; text and timestamps are never absorption witnesses. */
export function stateDbIdentityKeys(message: Message, includeUids = true, fallbackGeneration: string | null = null, includeAbsorbed = true): string[] {
  const keys: string[] = []
  const generation = '_state_db_generation' in message ? message._state_db_generation : fallbackGeneration
  const numericKey = (id: number): string => `id:${JSON.stringify([typeof generation === 'string' ? generation : null, id])}`
  const id = stateDbRowId(message)
  if (id !== null) keys.push(numericKey(id))
  for (const absorbed of includeAbsorbed && Array.isArray(message._absorbed_row_ids) ? message._absorbed_row_ids : []) {
    if (typeof absorbed === 'number' && Number.isFinite(absorbed)) keys.push(numericKey(absorbed))
  }
  // A reused UID does not vouch for an authored edit: the archive reader gives that generation its own row id.
  if (includeUids && message.role !== 'tool') {
    const own = message._state_db_authored_change === true ? [] : [message.message_uid, message._state_db_message_uid]
    const absorbed: unknown[] = includeAbsorbed && Array.isArray(message._absorbed_message_uids) ? message._absorbed_message_uids : []
    for (const uid of [...own, ...absorbed]) {
      if (typeof uid === 'string' && uid.length) keys.push(`uid:${uid}`)
    }
  }
  return keys
}

/** A carrier is covered only by its own identity and every constituent it declares; partial overlap is new work. */
export function stateDbMessageRepresented(message: Message, represented: Pick<ReadonlySet<string>, 'has'>, includeUids = true, generation: string | null = null): boolean {
  const own = stateDbIdentityKeys(message, includeUids, generation, false)
  return own.some((id) => represented.has(id)) && stateDbIdentityKeys(message, includeUids, generation).every((id) => own.includes(id) || represented.has(id))
}

/** Bind newly observed numeric provenance once; even an unknown generation must never be rebound to a new database. */
export function stampStateDbGeneration(rows: Message[], generation: string | null): void {
  for (const message of rows) {
    if (!('_state_db_generation' in message) && stateDbIdentityKeys(message, false).length) message._state_db_generation = generation
  }
}

/** The append-only merge's role/timestamp/content comparison, shared with archived-source matching. */
export function stateDbMessageKey(message: Message): string {
  const timestamp = Number(message.timestamp)
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null)
  return `${String(message.role)}\0${String(Number.isFinite(timestamp) ? timestamp : '')}\0${content}`
}

/** Fixed-width replay metadata; UTF-16 preserves JavaScript string equality, including lone surrogates. */
export function stateDbMessageFingerprint(message: Message): string {
  return createHash('sha256').update(stateDbMessageKey(message), 'utf16le').digest('hex')
}

/** The last recorded database generation remains the numeric identity's owner when a marker becomes stale. */
export function markedStateDbGeneration(s: { state_db_seen_boundary: string | null }): string | null {
  if (!s.state_db_seen_boundary) return null
  try {
    const boundary: unknown = JSON.parse(s.state_db_seen_boundary)
    if (!Array.isArray(boundary) || !Array.isArray(boundary[4])) return null
    const anchor: unknown[] = boundary[4]
    return typeof anchor[2] === 'string' ? anchor[2] : null
  } catch { return null }
}
