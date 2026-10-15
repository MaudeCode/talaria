import { createHash } from 'node:crypto'

type Message = Record<string, unknown>

/** The database row identity, including an archive-proven compaction copy's original id. */
export function stateDbRowId(message: Message): number | null {
  const id = message._state_db_row_id
  return typeof id === 'number' && Number.isFinite(id) ? id : null
}

/** Direct and absorbed durable identities; text and timestamps are never absorption witnesses. */
export function stateDbIdentityKeys(message: Message, includeUids = true, fallbackGeneration: string | null = null): string[] {
  const keys: string[] = []
  const generation = '_state_db_generation' in message ? message._state_db_generation : fallbackGeneration
  const numericKey = (id: number): string => `id:${JSON.stringify([typeof generation === 'string' ? generation : null, id])}`
  const id = stateDbRowId(message)
  if (id !== null) keys.push(numericKey(id))
  for (const absorbed of Array.isArray(message._absorbed_row_ids) ? message._absorbed_row_ids : []) {
    if (typeof absorbed === 'number' && Number.isFinite(absorbed)) keys.push(numericKey(absorbed))
  }
  // A reused UID does not vouch for an authored edit: the archive reader gives that generation its own row id.
  if (includeUids && message._state_db_authored_change !== true) {
    const absorbed: unknown[] = Array.isArray(message._absorbed_message_uids) ? message._absorbed_message_uids : []
    for (const uid of [message.message_uid, message._state_db_message_uid, ...absorbed]) {
      if (typeof uid === 'string' && uid.length) keys.push(`uid:${uid}`)
    }
  }
  return keys
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
