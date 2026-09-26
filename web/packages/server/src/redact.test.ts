import { describe, expect, it } from 'vitest'
import { redactSensitive } from './redact.js'

describe('redactSensitive', () => {
  it('masks the password of a URL with userinfo and keeps the user and host', () => {
    expect(redactSensitive('psql postgres://u:pgSyntheticSecret42@h/db')).toBe('psql postgres://u:pgSynt...et42@h/db')
    expect(redactSensitive('curl https://user:pw@example.com/x')).toBe('curl https://user:***@example.com/x')
    expect(redactSensitive('see https://example.com/a:b@c')).toBe('see https://example.com/a:b@c')
  })

  it('leaves already-redacted text unchanged', () => {
    const once = redactSensitive('curl -H "Authorization: Bearer synthetic-bearer-0123456789abcdef" && GITHUB_TOKEN=syntheticGithubToken0123456789 x')
    expect(once).toBe('curl -H "Authorization: Bearer synthe...cdef" && GITHUB_TOKEN=synthe...6789 x')
    expect(redactSensitive(once)).toBe(once)
  })
})
