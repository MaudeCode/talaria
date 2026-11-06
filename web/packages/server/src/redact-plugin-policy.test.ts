import { describe, expect, it } from 'vitest'
import { applyRedactionPolicy, publicToolFrame, redactSessionData, redactText } from './redact.js'
import { sanitizeShareMessage } from './sessions/shares.js'
import { bootTestServer } from './test/harness.js'
import { FakeSidecar } from './sidecar/fake.js'

// Native rules are process-wide and additive; keep synthetic rules out of the default-policy parity worker.
describe('plugin redaction policy', () => {
  it('preserves disjoint built-in masks while adding a plugin mask', () => {
    applyRedactionPolicy({ fingerprint: 'disjoint-policy', patterns: [{ pattern: 'acmeisolated_[a-z0-9]{10,}', literal_prefix: 'acmeisolated_' }] })
    const text = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890 and acmeisolated_0123456789abcdef'
    expect(redactText(text, true)).toBe('ghp_ab...7890 and acmeis...cdef')
  })

  it.each([
    { name: 'built-in token', text: 'sk-abcdefghijklmnopqrstuvwxyz1234567890', hidden: 'klmnopqrstuvwxyz1234567890', patterns: [{ pattern: 'sk-[a-z]{10}', literal_prefix: 'sk-' }] },
    { name: 'shorter plugin first', text: 'overlap_abcdefghijklmnopqrstuvwxyz1234567890', hidden: 'klmnopqrstuvwxyz1234567890', patterns: [{ pattern: 'overlap_[a-z]{10}', literal_prefix: 'overlap_' }, { pattern: 'overlap_[a-z0-9]{20,}', literal_prefix: 'overlap_' }] },
    { name: 'longer plugin first', text: 'reverse_abcdefghijklmnopqrstuvwxyz1234567890', hidden: 'klmnopqrstuvwxyz1234567890', patterns: [{ pattern: 'reverse_[a-z0-9]{20,}', literal_prefix: 'reverse_' }, { pattern: 'reverse_[a-z]{10}', literal_prefix: 'reverse_' }] },
    { name: 'credential field name', text: 'PLUGIN_API_KEY=syntheticOriginalSecret0123456789', hidden: 'syntheticOriginalSecret0123456789', patterns: [{ pattern: 'PLUGIN_API_[A-Z]+', literal_prefix: 'PLUGIN_API_' }] },
    { name: 'plugin extending a built-in match', text: 'sk-abcdefghijklmnopqrstuvwxyz1234567890.syntheticPrivateSuffix', hidden: 'syntheticPrivateSuffix', patterns: [{ pattern: 'sk-[a-zA-Z0-9.]{20,}', literal_prefix: 'sk-' }] },
  ])('keeps overlapping redaction coverage for $name', ({ text, hidden, patterns }) => {
    applyRedactionPolicy({ fingerprint: text, patterns })
    expect(redactText(text, true)).not.toContain(hidden)
    expect(sanitizeShareMessage({ role: 'assistant', content: text }, [], [], '/nonexistent-home')?.content).not.toContain(hidden)
  })

  it.each([
    { pattern: String.raw`anchored_[a-z0-9]{10,}\Z`, prefix: 'anchored_', text: 'anchored_0123456789abcdef', expected: 'anchor...cdef' },
    { pattern: String.raw`unicodeword_\w{10,}`, prefix: 'unicodeword_', text: 'unicodeword_' + 'α'.repeat(16), expected: 'unicod...αααα' },
    { pattern: String.raw`unicodedigit_\d{10,}`, prefix: 'unicodedigit_', text: 'unicodedigit_' + '١'.repeat(16), expected: 'unicod...١١١١' },
    { pattern: 'wildcard_.{10,}', prefix: 'wildcard_', text: 'wildcard_' + 'a'.repeat(8) + '\u2028' + 'b'.repeat(8), expected: 'wildca...bbbb' },
  ])('preserves Python credential coverage for $pattern', ({ pattern, prefix, text, expected }) => {
    applyRedactionPolicy({ fingerprint: pattern, patterns: [{ pattern, literal_prefix: prefix }] })
    expect(redactText(text, true)).toBe(expected)
    expect(sanitizeShareMessage({ role: 'assistant', content: text }, [], [], '/nonexistent-home')?.content).toBe(expected)
  })

  it('refreshes cached titles, messages, tool results, live tool frames and public shares at startup', async () => {
    const secret = 'acme_0123456789abcdef'
    const text = `value ${secret} here`
    const split = 'value acme_0123\u200b456789abcdef here'
    const large = text + ' ordinary output'.repeat(1500)
    expect(redactText(text, true)).toBe(text)
    expect(redactText(split, true)).toBe(split)
    expect(redactText(large, true)).toBe(large)
    const sidecar = new FakeSidecar()
    sidecar.respond('redaction.policy', () => ({ fingerprint: 'synthetic-policy', patterns: [{ pattern: 'acme_[a-z0-9]{10,}', literal_prefix: 'acme_' }, { pattern: 'pyacme_(?P<value>[a-z0-9]+)', literal_prefix: 'pyacme_' }, { pattern: 'control_.{1,}', literal_prefix: 'control_' }] }))
    const server = await bootTestServer({ sidecar })
    try {
      const expected = 'value acme_0...cdef here'
      expect(redactText(text, true)).toBe(expected)
      expect(redactText(split, true)).toBe(expected)
      expect(redactText('control_' + '\u200b'.repeat(8) + '12345678', true)).toBe('***')
      expect(redactText(large, true)).toBe(expected + ' ordinary output'.repeat(1500))
      const session = redactSessionData({ title: text, messages: [{ role: 'assistant', content: text }, { role: 'tool', content: text }] }, true)
      expect(session.title).toBe(expected)
      expect((session.messages as { content: string }[]).map((m) => m.content)).toEqual([expected, expected])
      expect(publicToolFrame({ name: 'synthetic', result: text }, true).result).toBe(expected)
      expect(sanitizeShareMessage({ role: 'assistant', content: text }, [], [], '/nonexistent-home')?.content).toBe(expected)
      expect(redactText(text, false)).toBe(text)
      expect(redactText('pyacme_0123456789abcdef after', true)).toBe('*** after')
      const later = 'later_0123456789abcdef'
      expect(redactText(later, true)).toBe(later)
      sidecar.respond('redaction.policy', () => ({ fingerprint: 'synthetic-restarted-policy', patterns: [{ pattern: 'later_[a-z0-9]{10,}', literal_prefix: 'later_' }] }))
      await sidecar.restart()
      expect(redactText(later, true)).toBe('later_...cdef')
      // A restarted or concurrently older snapshot cannot undo already learned rules.
      expect(redactText(text, true)).toBe(expected)
    } finally { await server.close() }
  })
})
