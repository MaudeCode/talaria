import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { redactText } from './redact.js'

// Prototype spies change V8 fast paths even after restoration; keep them in an isolated test worker.
describe('redactText cache', () => {
  function measure(text: string): { result: unknown; passes: number } {
    const exec = vi.spyOn(RegExp.prototype, 'exec')
    try {
      const result = redactText(text, true)
      return { result, passes: exec.mock.calls.length }
    } finally {
      exec.mockRestore()
    }
  }

  it.each([64, 200 * 1024].flatMap((size) => [true, false].map((sensitive) => ({ size, sensitive }))))(
    'skips every regex pass on a repeated $size-character payload, sensitive=$sensitive', ({ size, sensitive }) => {
      const head = sensitive ? 'PASSWORD=syntheticCacheSecret\n' : 'ordinary cache output\n'
      const text = head + 'plain output\n'.repeat(Math.ceil(size / 13)).slice(0, size - head.length)
      const expected = sensitive ? text.replace('syntheticCacheSecret', '***') : text
      const first = measure(text)
      const second = measure(text)
      expect(first.result).toBe(expected)
      expect(second.result).toBe(first.result)
      expect(first.passes).toBeGreaterThan(0)
      expect(second.passes).toBe(0)
      expect(redactText(text, false)).toBe(text)
    },
  )

  it('keeps inline text, hashed text and distinct UTF-16 strings separate', () => {
    const text = `PASSWORD=syntheticCacheIdentity\n${'ordinary output\n'.repeat(14_000)}`
    const expected = text.replace('syntheticCacheIdentity', '***')
    expect(redactText(text, true)).toBe(expected)
    const hashKey = `sha256:${createHash('sha256').update(text, 'utf16le').digest('hex')}`
    expect(redactText(hashKey, true)).toBe(hashKey)
    for (const suffix of ['\ud800', '\ud801', '\ufffd']) {
      expect(redactText(text + suffix, true)).toBe(expected + suffix)
    }
  })

  it('evicts the least recently used entry at the shared 4096-entry limit', () => {
    const entries = Array.from({ length: 4096 }, (_, i) => `cache eviction fixture ${i}`)
    entries[0] = 'cache eviction large output\n'.repeat(8000)
    for (const text of entries) redactText(text, true)
    redactText(entries[0], true)
    redactText('cache eviction overflow', true)
    expect(measure(entries[0]).passes).toBe(0)
    expect(measure(entries[1]!).passes).toBeGreaterThan(0)
  })

  it('evicts old large results before retained strings exceed the byte budget', () => {
    const payload = 'ordinary budget output\n'.repeat(10_000)
    const entries = Array.from({ length: 96 }, (_, i) => `${i}\n${payload}`)
    for (const text of entries) expect(redactText(text, true)).toBe(text)
    expect(measure(entries[0]!).passes).toBeGreaterThan(0)
    expect(measure(entries.at(-1)!).passes).toBe(0)
  })

  it('does not retain a single output larger than the byte budget', () => {
    const text = 'z'.repeat(8 * 1024 * 1024 + 1)
    const first = measure(text)
    const second = measure(text)
    expect(first.result).toBe(text)
    expect(second.result).toBe(text)
    expect(second.passes).toBeGreaterThan(0)
  })
})
