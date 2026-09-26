import { describe, expect, it } from 'vitest'
import { publicToolFrame, redactSensitive, redactSessionData } from './redact.js'

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
    expect(redactSensitive(`login --password 'hunter2' --token "opaque"`)).toBe(`login --password '***' --token "***"`)
    // Every key the removed client guards hid: camelCase, prefixed, and key-material names.
    expect(redactSensitive('{"apiKey": "opaqueA", "clientSecret": "opaqueB", "accessToken": "opaqueC"}')).toBe('{"apiKey": "***", "clientSecret": "***", "accessToken": "***"}')
    expect(redactSensitive('aws_secret_access_key = opaqueD private_key: opaqueE session_key=opaqueF credentials=opaqueG PRIVATE_KEY=opaqueH')).toBe('aws_secret_access_key = *** private_key: *** session_key=*** credentials=*** PRIVATE_KEY=***')
    expect(redactSensitive('curl -H "Authorization: Basic dXNlcjpwYXNz" -H "X-Api-Key: opaqueI" -u user:hunter2 https://x')).toBe('curl -H "Authorization: Basic ***" -H "X-Api-Key: ***" -u user:*** https://x')
    expect(redactSensitive('login --authorization=opaque123 --Authorization opaque456 authorization: opaque789')).toBe('login --authorization=*** --Authorization *** authorization: ***')
    expect(redactSensitive('curl -H "Authorization: Bearer synthetic-bearer-0123456789abcdef"')).toBe('curl -H "Authorization: Bearer synthe...cdef"')
    // The credential of an Authorization header is masked whatever its scheme.
    expect(redactSensitive('-H "Authorization: ApiKey opaque123" -H "Authorization: opaque456"')).toBe('-H "Authorization: ApiKey ***" -H "Authorization: ***"')
    const aws = redactSensitive('Authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/x, SignedHeaders=host, Signature=abcdef0123')
    expect(aws).not.toContain('AKIDEXAMPLE')
    expect(aws).toContain('Signature=***')
    // Ordinary words and non-credential parameters stay readable.
    expect(redactSensitive('keep the secret sauce --secret-file ./s.txt')).toBe('keep the secret sauce --secret-file ./s.txt')
    expect(redactSensitive('apiKeyId: 12 max_tokens=100 --user-agent curl')).toBe('apiKeyId: 12 max_tokens=100 --user-agent curl')
    expect(redactSensitive('max_tokens=100 tokenizer=bpe keyboard=us')).toBe('max_tokens=100 tokenizer=bpe keyboard=us')
  })

  it('never trusts a secret that looks like a masked value', () => {
    expect(redactSensitive('Authorization: Bearer abcdef...wxyz')).toBe('Authorization: Bearer ***')
  })
})

describe('redactSensitive cost', () => {
  it('stays linear on long runs of scheme and identifier characters', () => {
    // A quadratic scan takes seconds on these inputs; a linear one takes milliseconds.
    for (const seg of ['abcdefghij-', 'a.b+c-', 'token_', '--password ']) {
      const text = seg.repeat(Math.ceil(200_000 / seg.length))
      const started = performance.now()
      redactSensitive(text)
      expect(performance.now() - started).toBeLessThan(1000)
    }
  })
})

describe('publicToolFrame', () => {
  it('masks argument values whose key names a credential', () => {
    const frame = publicToolFrame({ name: 'login', args: { user: 'bob', password: 'hunter2', auth: { apiKey: 'opaque', token: 12345 } } }, true)
    expect(frame.args).toEqual({ user: 'bob', password: '***', auth: { apiKey: '***', token: '***' } })
    expect(publicToolFrame({ name: 'login', args: { password: 'hunter2' } }, false).args).toEqual({ password: 'hunter2' })
  })

  it('omits the target of a frame without args, so a completion keeps the target its start frame set', () => {
    expect(publicToolFrame({ name: 'terminal', tid: 't1', preview: 'ok' }, true)).toEqual({ name: 'terminal', tid: 't1', preview: 'ok', kind: 'shell' })
    expect(publicToolFrame({ name: 'terminal', tid: 't1', args: { command: 'ls' } }, true)).toMatchObject({ kind: 'shell', target: 'ls' })
  })
})

describe('redactSessionData', () => {
  it('masks credential-keyed arguments of persisted calls in every shape', () => {
    const args = { command: 'login', password: 'hunter2' }
    const out = redactSessionData({ tool_calls: [{ name: 'login', args }], messages: [
      { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'login', arguments: JSON.stringify(args) } }], content: [{ type: 'tool_use', id: 'b', name: 'login', input: args }] },
    ] }, true)
    expect(JSON.stringify(out)).not.toContain('hunter2')
    const message = (out.messages as Record<string, unknown>[])[0]!
    const call = (message.tool_calls as { function: { arguments: string } }[])[0]!
    expect(JSON.parse(call.function.arguments)).toEqual({ command: 'login', password: '***' })
  })
})
