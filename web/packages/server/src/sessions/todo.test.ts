import { expect, it } from 'vitest'
import { attachTodoState } from './todo.js'

type Json = Record<string, unknown>

it('keeps an unsettled todo list only until the transcript holds a newer todo write', () => {
  const row = (content: string, timestamp: number): Json => ({ role: 'tool', content: JSON.stringify({ todos: [{ id: '1', content, status: 'pending' }] }), timestamp })
  const unsettled = { todos: [{ id: '1', content: 'kept', status: 'in_progress' }], summary: {}, version: 1, ts: 200 }
  const pick = (messages: Json[]): unknown => { const payload: Json = {}; attachTodoState(payload, messages, unsettled); return ((payload.todo_state as Json).todos as Json[])[0]?.content }
  expect(pick([row('older', 100)])).toBe('kept')
  expect(pick([])).toBe('kept')
  expect(pick([row('older', 100), row('newer', 300)])).toBe('newer')
})
