import { describe, expect, it } from 'vitest'
import { publicToolFrame, redactSensitive, redactSessionData, redactText } from './redact.js'

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
    expect(aws).not.toContain('abcdef0123')
    expect(redactSensitive(`curl -H 'Authorization: Digest username="bob", realm="api", response="cafebabe"' https://x`)).toBe(`curl -H 'Authorization: Digest ***' https://x`)
    // A bare JWT is masked wherever it appears.
    expect(redactSensitive('curl "https://x/cb?jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"')).not.toContain('dozjgNryP4J3jVmNHl0w5N')
    // A parameterized scheme's whole value is masked, through escaped quotes, up to the closing quote.
    expect(redactSensitive(`curl -H "Authorization: Digest username=\\"bob\\", realm=\\"api\\", response=\\"cafebabe\\"" https://x`)).toBe(`curl -H "Authorization: Digest ***" https://x`)
    // A quoted value is masked through its closing quote, spaces included.
    expect(redactSensitive(`login --password 'correct horse battery staple' --token="a b c"`)).toBe(`login --password '***' --token="***"`)
    expect(redactSensitive('{"Authorization": "Bearer opaque123", "password": "two words"}')).toBe('{"Authorization": "***", "password": "***"}')
    expect(redactSensitive(`export PASSWORD='correct horse battery staple' GITHUB_TOKEN=syntheticGithubToken0123456789`)).toBe(`export PASSWORD='***' GITHUB_TOKEN=synthe...6789`)
    // A bearer credential is masked whatever header carries it.
    expect(redactSensitive('curl -H "X-Auth: Bearer opaque123" -H "Authorization: Bearer synthetic-bearer-0123456789abcdef"')).toBe('curl -H "X-Auth: Bearer ***" -H "Authorization: Bearer synthe...cdef"')
    expect(redactSensitive(`curl -H "Cookie: session=abc123; theme=dark" -H 'Set-Cookie: sid=xyz'`)).toBe(`curl -H "Cookie: ***" -H 'Set-Cookie: ***'`)
    expect(redactSensitive(`curl -u 'user:correct horse battery staple' --user "bob:two words" -u alice:pw1 https://x`)).toBe(`curl -u 'user:***' --user "bob:***" -u alice:*** https://x`)
    // Bash ANSI-C and locale quoting.
    expect(redactSensitive(`login --password $'correct horse battery staple' --token=$"a b" -u $'bob:two words'`)).toBe(`login --password $'***' --token=$"***" -u $'bob:***'`)
    // Shell quoting variants: inner quoted cookie values, backslash-escaped JSON, a quoted password after `user:`.
    expect(redactSensitive(`curl -H 'Cookie: session="abc def"; theme=x' https://x`)).toBe(`curl -H 'Cookie: ***' https://x`)
    expect(redactSensitive(String.raw`curl -H "Cookie: session=\"abc def\"; theme=x" https://x`)).toBe(String.raw`curl -H "Cookie: ***" https://x`)
    expect(redactSensitive(String.raw`curl -d "{\"password\":\"hunter2\",\"token\":\"a b\",\"user\":\"bob\"}" https://x`)).toBe(String.raw`curl -d "{\"password\":\"***\",\"token\":\"***\",\"user\":\"bob\"}" https://x`)
    expect(redactSensitive(`curl -u user:'correct horse' -u bob:"pw word" -ualice:pw3 https://x`)).toBe(`curl -u user:'***' -u bob:"***" -ualice:*** https://x`)
    // Ordinary words and non-credential parameters stay readable.
    expect(redactSensitive('keep the secret sauce --secret-file ./s.txt')).toBe('keep the secret sauce --secret-file ./s.txt')
    expect(redactSensitive('apiKeyId: 12 max_tokens=100 --user-agent curl')).toBe('apiKeyId: 12 max_tokens=100 --user-agent curl')
    expect(redactSensitive('max_tokens=100 tokenizer=bpe keyboard=us')).toBe('max_tokens=100 tokenizer=bpe keyboard=us')
  })

  it('never trusts a secret that looks like a masked value', () => {
    expect(redactSensitive('Authorization: Bearer abcdef...wxyz')).toBe('Authorization: Bearer ***')
  })
})

describe('redactText', () => {
  it('runs the redactor for every credential key the matcher accepts', () => {
    for (const key of ['access_key', 'session-key', 'private-key', 'secretKey', 'refresh_token', 'client-secret', 'credentials', 'signature', 'passwd'])
      expect(redactText(`login --${key} opaque99`, true)).toBe(`login --${key} ***`)
  })
})

describe('surrogate pairs', () => {
  it('never splits a surrogate pair when truncating a target or masking a token', () => {
    const target = String(publicToolFrame({ name: 'terminal', args: { command: `${'a'.repeat(199)}😀tail` } }, true).target)
    expect(target).toBe(`${'a'.repeat(199)}😀`)
    expect(JSON.stringify(target)).not.toMatch(/\\ud83d(?!\\ude00)/)
    expect(redactSensitive('Authorization: Bearer 😀abcdefghijklmnopqrs😀')).toBe('Authorization: Bearer 😀abcde...qrs😀')
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
    // Cookie keys, header tuples and name/value pairs are credentials too.
    expect(publicToolFrame({ name: 'http', args: { headers: { Cookie: 'session=abc123', 'Set-Cookie': ['sid=x'] }, pairs: [['X-Token', 'abc'], ['Accept', 'json']], har: [{ name: 'Authorization', value: 'opaque' }, { name: 'Accept', value: 'json' }] } }, true).args)
      .toEqual({ headers: { Cookie: '***', 'Set-Cookie': ['***'] }, pairs: [['X-Token', '***'], ['Accept', 'json']], har: [{ name: 'Authorization', value: '***' }, { name: 'Accept', value: 'json' }] })
    // Everything under a credential key is masked, however deeply nested.
    expect(publicToolFrame({ name: 'login', args: { password: ['hunter2'], authorization: { value: 'Bearer opaque', ttl: 3 }, empty: { token: '' } } }, true).args)
      .toEqual({ password: ['***'], authorization: { value: '***', ttl: '***' }, empty: { token: '' } })
  })

  it('omits the target of a frame without args, so a completion keeps the target its start frame set', () => {
    expect(publicToolFrame({ name: 'terminal', tid: 't1', preview: 'ok' }, true)).toEqual({ name: 'terminal', tid: 't1', preview: 'ok', kind: 'shell' })
    expect(publicToolFrame({ name: 'terminal', tid: 't1', args: { command: 'ls' } }, true)).toMatchObject({ kind: 'shell', target: 'ls' })
    // Empty or non-displayable args (the sidecar sends `{}` for non-dict callback args) carry no target either.
    expect(publicToolFrame({ name: 'terminal', tid: 't1', args: {} }, true)).not.toHaveProperty('target')
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
