/** Todo snapshot derivation from settled transcripts (Python `api/todo_state.py`). */
export const TODO_STATE_VERSION = 1
export const TODO_PAYLOAD_KEY = 'todo_state'

const isDict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

export function normalizeTodoSnapshot(data: unknown): Record<string, unknown> | null {
  if (!isDict(data) || !Array.isArray(data.todos)) return null
  return { todos: data.todos, summary: isDict(data.summary) ? data.summary : {}, version: TODO_STATE_VERSION }
}

export function parseTodoToolResult(result: unknown): Record<string, unknown> | null {
  let data: unknown = result
  if (typeof result === 'string') {
    try { data = JSON.parse(result) } catch { return null }
  }
  return normalizeTodoSnapshot(data)
}

export const tsFloat = (raw: unknown): number => { const n = Number(raw ?? 0); return Number.isFinite(n) && n > 0 ? n : 0 }

/** One todo-tool row, using the same timestamp floor for a scan and a prefix index. */
export function messageTodoSnapshot(message: unknown, timestampFloor = 0): Record<string, unknown> | null {
  if (!isDict(message) || message.role !== 'tool' || typeof message.content !== 'string' || !message.content.includes('"todos"')) return null
  const snapshot = parseTodoToolResult(message.content)
  if (!snapshot) return null
  const ts = tsFloat(message.timestamp) || timestampFloor
  if (ts > 0) snapshot.ts = ts
  return snapshot
}

/** Latest `todo` tool result, with a causal timestamp floor when the row lost its own. */
export function deriveTodoState(messages: unknown[] | null | undefined): Record<string, unknown> | null {
  if (!messages?.length) return null
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const snapshot = messageTodoSnapshot(messages[idx])
    if (!snapshot) continue
    if (!snapshot.ts) {
      let ts = 0
      for (let i = idx; i >= 0; i -= 1) { const m = messages[i]; if (isDict(m)) ts = Math.max(ts, tsFloat(m.timestamp)) }
      if (ts > 0) snapshot.ts = ts
    }
    return snapshot
  }
  return null
}

/**
 * TAL-397: the session key for the list a todo tool wrote in a turn that then errored or was cancelled. Its tool row
 * never reached the transcript, so it stands until a later todo write in the transcript is newer.
 */
export const UNSETTLED_TODO_KEY = 'unsettled_todo_state'

export function attachTodoState(payload: Record<string, unknown>, messages: unknown[] | null | undefined, unsettled?: unknown): boolean {
  try {
    return attachTodoSnapshot(payload, deriveTodoState(messages), unsettled)
  } catch {
    return false
  }
}

/** Shared precedence for a pre-indexed snapshot and an unsettled write. */
export function attachTodoSnapshot(payload: Record<string, unknown>, derived: Record<string, unknown> | null, unsettled?: unknown): boolean {
  try {
    const kept = normalizeTodoSnapshot(unsettled)
    if (kept) kept.ts = tsFloat(isDict(unsettled) ? unsettled.ts : 0)
    const snapshot = kept && (!derived || (kept.ts as number) > tsFloat(derived.ts)) ? kept : derived
    if (!snapshot) return false
    payload[TODO_PAYLOAD_KEY] = snapshot
    return true
  } catch {
    return false
  }
}
