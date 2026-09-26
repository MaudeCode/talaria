import { describe, expect, it } from 'vitest'
import { redactSensitive } from './redact.js'

describe('redactSensitive', () => {
  it('masks the password of a URL with userinfo and keeps the user and host', () => {
    expect(redactSensitive('psql postgres://u:pgSyntheticSecret42@h/db')).toBe('psql postgres://u:pgSynt...et42@h/db')
    expect(redactSensitive('curl https://user:pw@example.com/x')).toBe('curl https://user:***@example.com/x')
    expect(redactSensitive('see https://example.com/a:b@c')).toBe('see https://example.com/a:b@c')
  })

  it('masks lowercase credential parameters in commands, URLs and JSON', () => {
    expect(redactSensitive('curl "https://x/cb?access_token=opaqueValue1&x=1"')).toBe('curl "https://x/cb?access_token=***&x=1"')
    expect(redactSensitive('login --client_secret=opaque --password=hunter2')).toBe('login --client_secret=*** --password=***')
    expect(redactSensitive('{"token": "opaque", "passwd":"pw1"}')).toBe('{"token": "***", "passwd":"***"}')
    expect(redactSensitive('curl https://maps.example/api?key=opaqueKey123')).toBe('curl https://maps.example/api?key=***')
    // CLI flags take a space-separated value, and keys match in any case.
    expect(redactSensitive('login --password hunter2 --Password=hunter3 --api-key opaqueKey1 --Client-Secret: opaque2')).toBe('login --password *** --Password=*** --api-key *** --Client-Secret: ***')
    expect(redactSensitive('{"Token": "opaque"}')).toBe('{"Token": "***"}')
    // Ordinary words and non-credential parameters stay readable.
    expect(redactSensitive('keep the secret sauce --secret-file ./s.txt')).toBe('keep the secret sauce --secret-file ./s.txt')
    expect(redactSensitive('max_tokens=100 tokenizer=bpe keyboard=us')).toBe('max_tokens=100 tokenizer=bpe keyboard=us')
  })

  it('never trusts a secret that looks like a masked value', () => {
    expect(redactSensitive('Authorization: Bearer abcdef...wxyz')).toBe('Authorization: Bearer ***')
  })
})
