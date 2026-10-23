import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { PromptQueueRunSchema, PromptQueueCardsSchema } from './prompt-queue.js'

it('decodes shared cross-chat run states with explicit server policy and receipts', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/prompt-queues.json', import.meta.url), 'utf8')) as Record<string, unknown>
  for (const value of Object.values(fixtures)) expect(PromptQueueRunSchema.parse(value)).toEqual(value)
})
it('rejects empty, oversized and blank-message queues', () => {
  const card = { session_id: 'synthetic', project_id: null, text: 'prompt' }
  for (const input of [[], Array(101).fill(card), [{ ...card, text: '  ' }], [{ ...card, text: 'x'.repeat(32001) }]]) expect(PromptQueueCardsSchema.safeParse(input).success).toBe(false)
})
