import { createHash } from 'node:crypto'

type Message = Record<string, unknown>

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
