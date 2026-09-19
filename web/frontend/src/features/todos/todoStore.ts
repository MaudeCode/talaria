/** Current task list per session, fed by `todo_state` stream events and the settled session payload. */
import { useSyncExternalStore } from 'react'
import { TodoStateSchema, type TodoState } from '../../contracts/resources'

const bySession = new Map<string, TodoState>()
const listeners = new Set<() => void>()
let version = 0
const emit = () => { version += 1; for (const l of listeners) l() }

export function setTodoState(sessionId: string, raw: unknown): void {
  const parsed = TodoStateSchema.safeParse(raw)
  if (!parsed.success) return
  const prev = bySession.get(sessionId)
  if (prev && parsed.data.version !== undefined && prev.version !== undefined && parsed.data.version < prev.version) return
  bySession.set(sessionId, parsed.data)
  emit()
}

export function clearTodoState(sessionId: string): void {
  if (bySession.delete(sessionId)) emit()
}

export function useTodoState(sessionId: string | null): TodoState | null {
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => version, () => version)
  return sessionId ? bySession.get(sessionId) ?? null : null
}

export function resetTodoStoreForTests(): void {
  bySession.clear()
  emit()
}
