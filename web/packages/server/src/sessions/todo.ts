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

const tsFloat = (raw: unknown): number => { const n = Number(raw ?? 0); return Number.isFinite(n) && n > 0 ? n : 0 }

/** Latest `todo` tool result, with a causal timestamp floor when the row lost its own. */
export function deriveTodoState(messages: unknown[] | null | undefined): Record<string, unknown> | null {
  if (!messages?.length) return null
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const msg = messages[idx]
    if (!isDict(msg) || msg.role !== 'tool') continue
    const content = msg.content
    if (typeof content !== 'string' || !content.includes('"todos"')) continue
    let data: unknown
    try { data = JSON.parse(content) } catch { continue }
    const snapshot = normalizeTodoSnapshot(data)
    if (!snapshot) continue
    let ts = tsFloat(msg.timestamp)
    if (ts <= 0) {
      for (let i = Math.min(idx, messages.length - 1); i >= 0; i -= 1) {
        const m = messages[i]
        if (isDict(m)) ts = Math.max(ts, tsFloat(m.timestamp))
      }
    }
    if (ts > 0) snapshot.ts = ts
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
    const derived = deriveTodoState(messages)
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
