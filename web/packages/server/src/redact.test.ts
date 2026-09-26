import { describe, expect, it } from 'vitest'
import { publicToolFrame, redactSensitive, redactSessionData, redactText } from './redact.js'

describe('redactSensitive', () => {
  it('masks the password of a URL with userinfo and keeps the user and host', () => {
    expect(redactSensitive('psql postgres://u:pgSyntheticSecret42@h/db')).toBe('psql postgres://u:pgSynt...et42@h/db')
    expect(redactSensitive('curl https://user:pw@example.com/x')).toBe('curl https://user:***@example.com/x')
    expect(redactSensitive('see https://example.com/a:b@c')).toBe('see https://example.com/a:b@c')
    expect(redactSensitive('curl https://:hunter2@example.com/x')).toBe('curl https://:***@example.com/x')
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
    expect(redactSensitive('login --XApiKey=opaque1 --AWSSecretAccessKey opaque2 {"XAuthToken": "x"}')).toBe('login --XApiKey=*** --AWSSecretAccessKey *** {"XAuthToken": "***"}')
    // Compound camelCase and upper snake credential names.
    expect(redactSensitive('deploy --secretAccessKey=opaque123 --awsSessionToken opaque456 AWS_SECRET_ACCESS_KEY: opaque789 {"sessionToken": "x"}')).toBe('deploy --secretAccessKey=*** --awsSessionToken *** AWS_SECRET_ACCESS_KEY: *** {"sessionToken": "***"}')
    // A backslash-escaped shell word is one value.
    expect(redactSensitive(String.raw`login --password=correct\ horse\ battery -u bob:pw\ word https://x`)).toBe(String.raw`login --password=*** -u bob:*** https://x`)
    expect(redactSensitive(String.raw`PASSWORD=correct\ horse\ battery GITHUB_TOKEN=syntheticGithubToken0123456789 x`)).toBe(String.raw`PASSWORD=*** GITHUB_TOKEN=synthe...6789 x`)
    // A credential-named value is masked whatever characters it holds; empty and already-masked values stay.
    expect(redactSensitive(`login --password='!@#$' --token=%%% -u bob:'!!' {"secret": ""} password=*** PASSWORD=!@#%`)).toBe(`login --password='***' --token=*** -u bob:'***' {"secret": ""} password=*** PASSWORD=***`)
    // A quoted value spanning lines is masked through its closing quote.
    expect(redactSensitive("login --password 'correct\nhorse' -u 'bob:pw\nword' --token=\"a\nb\" x")).toBe("login --password '***' -u 'bob:***' --token=\"***\" x")
    // A container value (the sidecar's Python repr of nested args) is masked whole.
    expect(redactSensitive(`{'password': ['hunter2'], 'auth': {'token': 'x'}, "secret": {"a": 1}, 'user': 'bob'}`)).toBe(`{'password': ***, 'auth': {'token': '***'}, "secret": ***, 'user': 'bob'}`)
    expect(publicToolFrame({ name: 'deploy', args: { config: "{'password': ['hunter2']}" } }, true).args).toEqual({ config: "{'password': ***}" })
    // A value is the whole shell word: nested containers, concatenated pieces, unterminated quotes to the line end.
    expect(redactSensitive(`{'password': [['hunter2'], ['secondsecret']], 'user': 'bob'}`)).toBe(`{'password': ***, 'user': 'bob'}`)
    expect(redactSensitive(`login --password='foo'"bar"baz\\ qux --token=a'b c'd -u bob:'x'"y" next`)).toBe(`login --password=*** --token=*** -u bob:*** next`)
    expect(redactSensitive(`login --password "unterminated secret\nnext line`)).toBe(`login --password ***\nnext line`)
    // Punctuation inside a bare word is part of it; after a value it is structure.
    expect(redactSensitive(`login --password=correct]horse --token=a,b}c|next {"secret": 123}, {'token': 'x'}`)).toBe(`login --password=*** --token=***|next {"secret": ***}, {'token': '***'}`)
    // Command substitution, backticks and parameter expansion are part of the word.
    // A command substitution cannot be bounded without a shell parser (`case` patterns have unmatched `)`): it is masked to the line end.
    expect(redactSensitive('login --secret=${S:-x y} --password=$(printf hunter2) next\nls')).toBe('login --secret=*** --password=***')
    expect(redactSensitive("PASSWORD=$(printf 'x\nhunter2') next")).toBe('PASSWORD=***')
    expect(redactSensitive('login --password=`printf foo\\` hunter2` next\nls')).toBe('login --password=***')
    expect(redactSensitive('login --password=${X:-$(echo } hunter2)} next\nls')).toBe('login --password=***')
    expect(redactSensitive('login --password=<(printf hunter2) --token >(tee t) next\nls')).toBe('login --password=***')
    expect(redactSensitive('login --password=$(case x in x) echo hunter2;; esac) next')).toBe('login --password=***')
    expect(redactSensitive(`login --password=$(printf '%s)' "a)b" \\) hunter2) next`)).toBe('login --password=***')
    // Every prefiltered key alias, and Python tuple containers.
    expect(redactSensitive(`login --secret_input opaque1 --key-material=opaque2 {"bearer": "opaque3"} {'password': ('hunter2', 'second'), 'user': 'bob'}`)).toBe(`login --secret_input *** --key-material=*** {"bearer": "***"} {'password': ***, 'user': 'bob'}`)
    expect(redactSensitive('TOKEN=${TOKEN:-fallback secret} PASSWORD=$(printf hunter2) next')).toBe('TOKEN=*** PASSWORD=***')
    expect(redactSensitive(String.raw`login --password=foo\"bar next`)).toBe('login --password=*** next')
    expect(redactSensitive(String.raw`login --password=$'correct\' horse' next -u $'bob:a\' b' x`)).toBe(String.raw`login --password=*** next -u $'bob:***' x`)
    // Inside an enclosing quote a bare value runs to its closing quote, newlines and spaces included.
    expect(redactSensitive('login "--password=correct\nhorse" next \'--token=a b\' x')).toBe('login "--password=***" next \'--token=***\' x')
    // The shell word continues past the enclosing quote into adjacent pieces.
    expect(redactSensitive(`login '--password=foo'bar"baz" next`)).toBe(`login '--password=*** next`)
    // An apostrophe inside a word is prose, not a quote.
    expect(redactSensitive("don't share it: password: hunter2 and it's fine")).toBe("don't share it: password: *** and it's fine")
    expect(redactSensitive(`ssh-keygen --passphrase 'correct horse' && openssl rsa -passin=pass:abc {"pass_phrase": "x"}`)).toBe(`ssh-keygen --passphrase '***' && openssl rsa -passin=*** {"pass_phrase": "***"}`)
    // Escaped JSON inside a shell string ends only at its real closing quote.
    expect(redactSensitive(String.raw`curl -d "{\"password\":\"foo\\\"bar baz\",\"user\":\"bob\"}" x`)).toBe(String.raw`curl -d "{\"password\":\"***\",\"user\":\"bob\"}" x`)
    expect(redactSensitive('PASSWORD+=hunter2 token+=abc next')).toBe('PASSWORD+=*** token+=*** next')
    expect(redactSensitive(String.raw`curl -H $'Cookie: session=foo\'; auth=hunter2' x`)).toBe(String.raw`curl -H $'Cookie: ***' x`)
    expect(redactSensitive('login --companyProdEuAwsSecretAccessKey=hunter2 a_b_c_d_e_f_password: x2 next')).toBe('login --companyProdEuAwsSecretAccessKey=*** a_b_c_d_e_f_password: *** next')
    expect(redactSensitive('login --auth.password=hunter2 --auth[password]=hunter3 --db.user=bob next')).toBe('login --auth.password=*** --auth[password]=*** --db.user=bob next')
    expect(redactSensitive(String.raw`curl -H 'Authorization: Digest username="bo\"b", response="cafebabe"' x`)).toBe(String.raw`curl -H 'Authorization: Digest ***' x`)
    // Ordinary words and non-credential parameters stay readable.
    expect(redactSensitive('keep the secret sauce --secret-file ./s.txt')).toBe('keep the secret sauce --secret-file ./s.txt')
    expect(redactSensitive('apiKeyId: 12 max_tokens=100 --user-agent curl')).toBe('apiKeyId: 12 max_tokens=100 --user-agent curl')
    expect(redactSensitive('maxTokens=100 mytoken=abc tokenizer=bpe tokenCount=3')).toBe('maxTokens=100 mytoken=abc tokenizer=bpe tokenCount=3')
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

describe('curl -u', () => {
  it('masks every attached, tab-separated and escaped-quote form, through the public prefilter', () => {
    expect(redactText('curl -ualice:hunter2 example.com', true)).toBe('curl -ualice:*** example.com')
    expect(redactText('curl -u\tbob:pw example.com', true)).toBe('curl -u\tbob:*** example.com')
    expect(redactSensitive(String.raw`curl -u "bob:pw\"word" https://x`)).toBe(String.raw`curl -u "bob:***" https://x`)
    expect(redactSensitive('ls -u /tmp && curl --user carol:pw1 x')).toBe('ls -u /tmp && curl --user carol:*** x')
    expect(redactSensitive(`curl -u 'bob':'hunter2' https://x`)).toBe(`curl -u 'bob':'***' https://x`)
  })
})

describe('redactSensitive cost', () => {
  it('stays linear on long runs of scheme and identifier characters', () => {
    // A quadratic scan takes seconds on these inputs; a linear one takes milliseconds.
    // Unquoted runs, and many credential keys inside one long quoted argument.
    for (const text of [...['abcdefghij-', 'a.b+c-', 'token_', '--password ', 'aB', 'aBcD_', 'ABCd', 'AB'].map((seg) => seg.repeat(Math.ceil(200_000 / seg.length))),
      ...['Authorization: x ', 'Authorization: *** ', 'secret sauce ', 'password=*** '].map((seg) => `"${seg.repeat(Math.ceil(200_000 / seg.length))}"`)]) {
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
    expect(publicToolFrame({ name: 'aws', args: { secretAccessKey: 'a', awsSessionToken: 'b', XApiKey: 'c', AWSSecretAccessKey: 'd', region: 'us' } }, true).args).toEqual({ secretAccessKey: '***', awsSessionToken: '***', XApiKey: '***', AWSSecretAccessKey: '***', region: 'us' })
    // Structured results and outputs are redacted by key as well.
    expect(publicToolFrame({ name: 'vault', args: {}, result: { token: 'opaque', ttl: 60 }, output: [{ password: 'x' }] }, true)).toMatchObject({ result: { token: '***', ttl: 60 }, output: [{ password: '***' }] })
    expect(publicToolFrame({ name: 'cfg', args: { COMPANY_PROD_EU_AWS_SECRET_ACCESS_KEY: 'a', companyProdEuAwsSessionToken: 'b', company_prod_eu_region_name: 'eu' } }, true).args).toEqual({ COMPANY_PROD_EU_AWS_SECRET_ACCESS_KEY: '***', companyProdEuAwsSessionToken: '***', company_prod_eu_region_name: 'eu' })
    // A namespaced key is a credential when any of its path segments names one.
    expect(publicToolFrame({ name: 'cfg', args: { 'auth.token': 'a', 'database.password': 'b', 'db/user': 'bob', 'x:api_key': 'c', 'auth[password]': 'd', 'user[name]': 'e', 'auth["token"]': 'f', "auth['secret']": 'g' } }, true).args).toEqual({ 'auth["token"]': '***', "auth['secret']": '***', 'auth.token': '***', 'database.password': '***', 'db/user': 'bob', 'x:api_key': '***', 'auth[password]': '***', 'user[name]': 'e' })
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
