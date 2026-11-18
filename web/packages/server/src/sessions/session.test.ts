import { describe, expect, it, vi } from 'vitest'
import { contextUsage, Session } from './session.js'

type Json = Record<string, unknown>

describe('server-computed context ring (TAL-299)', () => {
  it('uses the post-compression estimate, else the last prompt, never the cumulative input, over a known window only', () => {
    const ring = (used: number | null, window: number | null, percent: number | null, threshold: number | null = null) => ({ context_used_tokens: used, context_window_tokens: window, context_usage_percent: percent, context_threshold_percent: threshold, context_window_source: null })
    expect(contextUsage({ last_prompt_tokens: 64_000, context_length: 128_000 })).toEqual(ring(64_000, 128_000, 50))
    expect(contextUsage({ post_compression_context_tokens_estimate: 10_347, last_prompt_tokens: 120_000, context_length: 128_000 })).toEqual(ring(10_347, 128_000, 8))
    expect(contextUsage({ input_tokens: 900_000, last_prompt_tokens: 0, context_length: 200_000 } as Json)).toEqual(ring(null, 200_000, null))
    expect(contextUsage({ last_prompt_tokens: 5_000, context_length: null })).toEqual(ring(5_000, null, null))
    expect(contextUsage({ last_prompt_tokens: 5_000, context_length: 0 }, () => 20_000)).toEqual(ring(5_000, 20_000, 25))
    expect(contextUsage({ last_prompt_tokens: 300_000, context_length: 200_000, threshold_tokens: 160_000 })).toEqual(ring(300_000, 200_000, 100, 80))
    expect(contextUsage({ last_prompt_tokens: 'junk', context_length: '128000', threshold_tokens: -1 })).toEqual(ring(null, 128_000, null))
  })

  it('labels the window with the source that supplied it, never a source without a window (TAL-1908)', () => {
    const source = (...args: Parameters<typeof contextUsage>) => contextUsage(...args).context_window_source
    expect(source({ context_length: 128_000, context_window_source: 'pinned' }, () => 256_000, () => 'fallback')).toBe('pinned')
    expect(source({ context_length: 128_000, context_window_source: null }, () => 256_000, () => 'fallback')).toBeNull()
    expect(source({ context_length: 0, context_window_source: 'pinned' }, () => 256_000, () => 'fallback')).toBe('fallback')
    expect(source({ context_length: 0, context_window_source: 'pinned' }, () => null, () => 'fallback')).toBeNull()
    expect(source({ context_length: 128_000, context_window_source: 'guessed' })).toBeNull()
  })
})

describe('Session transcript load', () => {
  it('serialises each row at most once when a full transcript loads, with the same rows kept (TAL-1742)', () => {
    const parts = (text: string): Json[] => [{ type: 'text', text }]
    const rows = (): Json[] => Array.from({ length: 400 }, (_, i) => [
      { role: 'user', content: parts(`u${i}`), timestamp: i },
      { role: 'user', content: parts(`u${i}`), timestamp: i, _state_db_row_id: i },
      { role: 'user', content: parts(`edited ${i}`), timestamp: i, _state_db_row_id: i },
      { role: 'user', content: parts(`u${i}`), timestamp: i, _state_db_row_id: i, _turn_id: 't' },
    ]).flat()
    const messages = rows()
    const context = rows()
    const contents = new Set([...messages, ...context].map((m) => m.content))
    const stringify = vi.spyOn(JSON, 'stringify')
    const session = new Session({ messages, context_messages: context }, { workspace: '/synthetic/workspace', model: null })
    const serialised = stringify.mock.calls.map(([value]) => value as unknown).filter((value) => contents.has(value))
    stringify.mockRestore()
    expect(new Set(serialised).size).toBe(serialised.length)
    const kept = rows().filter((_, i) => i % 4 !== 1)
    expect(session.messages).toEqual(kept)
    expect(session.context_messages).toEqual(kept)
  })
})
