import { crc32 } from 'node:zlib'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { describe, expect, it, vi } from 'vitest'
import { isRasterDataUri } from './raster-image.js'
import { mightContainSensitiveText, publicToolFrame, redactNestedMessageContainers, redactSensitive, redactSessionData, redactText } from './redact.js'
import { MessageSchema } from '@maudecode/talaria-web-contracts'
import { sanitizeShareMessage } from './sessions/shares.js'
import { hydrateAnchorActivityScenes, withTurnIds } from './sessions/anchor.js'
import { toolEditDiff } from './sessions/tool-display.js'

/** A base64 run shaped like an AWS key: text redaction rewrites any image payload that carries it. */
const AWS = 'AKIAIOSFODNN7EXAMPLE'
const u16le = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const u32le = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const jpeg = (scan: Buffer): Buffer => Buffer.concat([Buffer.from('ffd8ffc0000b080001000101011100ffda000801010000003f00', 'hex'), scan, Buffer.from('ffd9', 'hex')])
const dataUri = (mime: string, bytes: Buffer): string => `data:${mime};base64,${bytes.toString('base64')}`
const imageUrl = (url: string, role = 'user'): unknown => (((redactSessionData({ messages: [{ role, content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url, detail: 'auto' } }] }] }, true).messages as Record<string, unknown>[])[0]!.content as Record<string, unknown>[])[1]!.image_url as Record<string, unknown>).url

describe('redactSensitive', () => {
  it('gives no object a way out of redaction by its shape (TAL-1317)', () => {
    const link = 'https://example.test/?token=abcdefghijklmnopqrstuvwx'
    expect(JSON.stringify(redactNestedMessageContainers({ row: { env_fields: [], connect_url: link } }, true))).not.toContain('abcdefghijklmnopqrstuvwx')
    expect(JSON.stringify(redactNestedMessageContainers({ row: { env_fields: [], connect_url: { nested: link } } }, true))).not.toContain('abcdefghijklmnopqrstuvwx')
  })

  it.each([
    ['plain', '{"password":" x password=foo"}--password finalSecret987'],
    ['ANSI-coloured', '{"pass\x1b[31mword":" x password=foo"}--password finalSecret987'],
    ['single-quoted', "echo 'x password=foo'}--token finalSecret987"],
    ['ANSI-C-quoted', "echo $'x password=foo'}--password finalSecret987"],
    ['computed flag', '{"password":" x password=foo"}--${FLAG} finalSecret987'],
    ['computed suffix', '{"password":" x password=foo"}--password${SUFFIX} finalSecret987'],
  ])('masks later credentials after an enclosing quote in %s text', (_name, input) => {
    expect.soft(redactText(input, true)).not.toContain('finalSecret987')
    expect.soft(sanitizeShareMessage({ role: 'assistant', content: input }, [], [], '/nonexistent-home')?.content).not.toContain('finalSecret987')
  })

  it.each([
    'Authorization: "--password foo "--password finalSecret987',
    "Authorization: '--token foo '--token finalSecret987",
    'Bearer "--password foo "--password finalSecret987',
    'X-Auth: Bearer "--token foo "--token finalSecret987',
  ])('preserves composed-word masks when a header contains overlapping credential heads: %s', (input) => {
    expect.soft(redactText(input, true)).not.toContain('finalSecret987')
    expect.soft(sanitizeShareMessage({ role: 'assistant', content: input }, [], [], '/nonexistent-home')?.content).not.toContain('finalSecret987')
  })

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

  it('masks the rest of a -u value when an expansion may supply its colon', () => {
    expect(redactText('SEP=:; curl -u bob${SEP}hunter2 https://x', true)).toBe('SEP=:; curl -u bob*** https://x')
    expect(redactText('curl -u $USER https://x', true)).toBe('curl -u $USER https://x')
  })

  it('masks curl\'s accepted --proxy-user abbreviations', () => {
    expect(redactText('curl --proxy-u bob:hunter2 --proxy-use amy:pw2 --proxy-us cy:pw3 x', true)).toBe('curl --proxy-u bob:*** --proxy-use amy:*** --proxy-us cy:*** x')
  })

  it('masks a private key whose end marker a display cap cut off', () => {
    const key = 'K'.repeat(64)
    const query = `inspect -----BEGIN PRIVATE KEY-----${key}-----END PRIVATE KEY-----`
    const frame = publicToolFrame({ name: 'web_search', args: { query } }, true)
    expect(JSON.stringify(frame)).not.toContain(key.slice(0, 16))
    expect(redactText(`x -----BEGIN RSA PRIVATE KEY-----${key}`, true)).not.toContain(key.slice(0, 16))
  })

  it('re-parses an edit diff\'s hunks from its redacted text, so a key spanning lines never shows in them (TAL-604)', () => {
    const key = 'K'.repeat(64)
    const diff = `@@ -0,0 +1,3 @@\n+-----BEGIN PRIVATE KEY-----\n+${key}\n+-----END PRIVATE KEY-----`
    const frame = publicToolFrame({ name: 'patch', edit_diff: toolEditDiff('patch', { diff }) }, true)
    expect(JSON.stringify(frame)).not.toContain(key.slice(0, 16))
    expect((frame.edit_diff as { hunks: { lines: { text: string }[] }[] }).hunks[0]!.lines.map((line) => line.text)).toEqual(['+[REDACTED PRIVATE KEY]'])
  })

  it('masks curl proxy credentials (-U, --proxy-user), through the public prefilter', () => {
    expect(redactText('curl --proxy-user bob:hunter2 https://x', true)).toBe('curl --proxy-user bob:*** https://x')
    expect(redactText('curl -U bob:hunter2 https://x', true)).toBe('curl -U bob:*** https://x')
    expect(redactText(`curl -U'bob:two words' https://x`, true)).toBe(`curl -U'bob:***' https://x`)
  })
})

describe('command-specific short credential flags', () => {
  it('masks the secret short flag of a known command, separate or attached, through the public prefilter', () => {
    expect(redactText('docker login -u bob -p hunter2 x', true)).toBe('docker login -u bob -p *** x')
    expect(redactText('mysql -uroot -phunter2', true)).toBe('mysql -uroot -p***')
    expect(redactText('sshpass -p hunter2 ssh h', true)).toBe('sshpass -p *** ssh h')
    expect(redactText('redis-cli -a pw', true)).toBe('redis-cli -a ***')
    expect(redactText('smbclient //h/s -U bob%hunter2', true)).toBe('smbclient //h/s -U bob%***')
    expect(redactText(`sudo /usr/bin/mysqldump -h db -p'two words' app`, true)).toBe(`sudo /usr/bin/mysqldump -h db -p'***' app`)
    expect(redactText('helm registry login r.example -u bob -p=hunter2', true)).toBe('helm registry login r.example -u bob -p=***')
  })

  it('keeps a short flag that is no credential for its command as written', () => {
    for (const text of ['ssh -p 2222 host', 'tar -p -xf a.tar', 'cp -p a b', 'docker run -p 8080:80 nginx', 'mysql -p app', 'redis-cli -h h -p 6380', 'smbclient -U bob //h/s']) expect(redactText(text, true)).toBe(text)
    // sshpass's options end at the command it runs.
    expect(redactText('sshpass -p hunter2 ssh -p 2222 h', true)).toBe('sshpass -p *** ssh -p 2222 h')
    expect(redactText('mysql -e "select 1"; ssh -p 2222 h', true)).toBe('mysql -e "select 1"; ssh -p 2222 h')
  })

  it('masks a command quoted inside another, in argv arrays and in the listed snapshot text', () => {
    expect(redactText(`docker exec db sh -c 'mysql -uroot -phunter2'`, true)).toBe(`docker exec db sh -c 'mysql -uroot -p***'`)
    expect(redactText(`{'command': "sshpass -p hunter2 ssh h"}`, true)).toBe(`{'command': "sshpass -p *** ssh h"}`)
    expect(redactText(`['docker', 'login', '-u', 'bob', '-p', 'hunter2']`, true)).toBe(`['docker', 'login', '-u', 'bob', '-p', '***']`)
    expect(redactText(`["/usr/bin/mysql", "-phunter2"]`, true)).toBe(`["/usr/bin/mysql", "-p***"]`)
    expect(redactText(`['redis-cli', '-a', 123456]`, true)).toBe(`['redis-cli', '-a', ***]`)
    const frame = publicToolFrame({ name: 'terminal', args: { command: ['docker', 'login', '-p', 'hunter2', 'x'], other: ['redis-cli', '-a', 123456], db: ['mysql', '-phunter3', '-p', 'app'] } }, true)
    expect(frame.args).toEqual({ command: ['docker', 'login', '-p', '***', 'x'], other: ['redis-cli', '-a', '***'], db: ['mysql', '-p***', '-p', 'app'] })
    expect(JSON.stringify(publicToolFrame({ name: 'terminal', args: { command: 'docker login -u bob -p hunter2 x' } }, true))).not.toContain('hunter2')
    // An inner quote of the other kind groups the secret, closed or not.
    expect(redactText(`sh -c "mysql -p'hunter 2' db"`, true)).toBe(`sh -c "mysql -p'***' db"`)
    expect(redactText(`sh -c 'sshpass -p "hunter 2" ssh h'`, true)).toBe(`sh -c 'sshpass -p "***" ssh h'`)
    expect(redactText(`sh -c "mysql -p'hunter 2"`, true)).not.toContain('2')
    // A quoted password spans a newline.
    expect(redactText('mysql -p"hunter\n2" db', true)).toBe('mysql -p"***" db')
    expect(redactText(`sshpass -p 'hunter\n2' ssh h`, true)).toBe(`sshpass -p '***' ssh h`)
  })

  it('reads the current MariaDB utility names and a subcommand the shell computes', () => {
    expect(redactText('mariadb-dump -uroot -phunter2 app', true)).toBe('mariadb-dump -uroot -p*** app')
    expect(redactText('/usr/bin/mariadb-admin -phunter2 status', true)).toBe('/usr/bin/mariadb-admin -p*** status')
    expect(redactText('docker "$ACTION" -p hunter2', true)).not.toContain('hunter2')
    expect(publicToolFrame({ name: 'terminal', args: { command: ['podman', '$(echo login)', '-p', 'hunter2'] } }, true).args).toEqual({ command: ['podman', '$(echo login)', '-p', '***'] })
    expect(redactText('mariadb-binlog -phunter2 -R binlog.000001', true)).toBe('mariadb-binlog -p*** -R binlog.000001')
    expect(redactText('mysqlbinlog -phunter2 x', true)).toBe('mysqlbinlog -p*** x')
    expect(redactText('mysqlsh -phunter2 --sql', true)).toBe('mysqlsh -p*** --sql')
    expect(publicToolFrame({ name: 'terminal', args: { command: ['mysqlsh', '-phunter2', '--sql'] } }, true).args).toEqual({ command: ['mysqlsh', '-p***', '--sql'] })
  })

  it('reads a substitution as part of its word and a computed executable as a registry client', () => {
    for (const text of ['mysql -p$(printf hunter2) db', 'sshpass -p $(printf hunter2) ssh h', 'sshpass -p `printf hunter2` ssh h', 'mysql -p${PW:-hunter 2} db', 'mysql -p$(printf "$(echo hunter2)") db']) expect(redactText(text, true)).not.toContain('hunter2')
    for (const text of ['$CLIENT login -p hunter2', '${CLIENT} login -p hunter2', '"$CLIENT" login -p hunter2', '$(which docker) login -p hunter2', 'x=$(mysql -phunter2 -e "select 1")']) expect(redactText(text, true)).not.toContain('hunter2')
    expect(publicToolFrame({ name: 'terminal', args: { command: ['$CLIENT', 'login', '-p', 'hunter2'] } }, true).args).toEqual({ command: ['$CLIENT', 'login', '-p', '***'] })
    for (const text of ['cd $DIR && ls -p', '$CLIENT run image login -p public', 'ssh -p 2222 $HOST']) expect(redactText(text, true)).toBe(text)
    // A computed word may be the executable wherever it stands, so it fails closed: `cp $SRC -p dst` reads as `sshpass -p dst`.
    expect(redactText('cp $SRC -p dst', true)).toBe('cp $SRC -p ***')
    // A computed executable may be any known command, and a backtick one too.
    for (const text of ['$CLIENT -phunter2 db', '$CLIENT -a hunter2', '$CLIENT -U bob%hunter2 //h/s', "['$CLIENT', '-phunter2']", '`printf docker` login -p hunter2', 'x; `printf mysql` -phunter2', 'my${EMPTY}sql -phunter2 db', 'dock${EMPTY}er login -p hunter2', '/usr/bin/my$X -phunter2', 'LC_ALL=C $CLIENT -phunter2 db', 'A=1 B="" env $CLIENT -a hunter2', 'sudo $CLIENT login -p hunter2', 'x && nohup $(which mysql) -phunter2', 'sudo -u root $CLIENT -phunter2 db', '$(echo $(which mysql)) -phunter2 db', '"$(echo $(which docker))" login -p hunter2']) expect(redactText(text, true)).not.toContain('hunter2')
  })

  it('skips a redirection and its target', () => {
    expect(redactText('docker </dev/null login -p hunter2', true)).toBe('docker </dev/null login -p ***')
    expect(redactText('sshpass 2>/tmp/e -p hunter2 ssh h', true)).toBe('sshpass 2>/tmp/e -p *** ssh h')
    expect(redactText('docker 2> /tmp/e &>>/tmp/f 2>&1 login -p hunter2', true)).toBe('docker 2> /tmp/e &>>/tmp/f 2>&1 login -p ***')
    expect(redactText('redis-cli -a hunter2>/tmp/o ping', true)).toBe('redis-cli -a ***>/tmp/o ping')
  })

  it('keeps shell punctuation inside a bare credential word', () => {
    expect(redactText('mysql -phunter,2 db', true)).toBe('mysql -p*** db')
    expect(redactText('sshpass -p hunter]2 ssh h', true)).toBe('sshpass -p *** ssh h')
    expect(redactText('redis-cli -a hunter}2 ping', true)).toBe('redis-cli -a *** ping')
    // A list's punctuation still ends its elements.
    expect(redactText(`['redis-cli', '-a', 123456, 'ping']`, true)).toBe(`['redis-cli', '-a', ***, 'ping']`)
  })

  it('reads whitespace other than a space or tab as part of a word', () => {
    for (const text of ['docker\u00a0', 'docker\r', 'mysql\v', 'docker\f', `['docker'\u00a0]`, 'A simple docker mod to auto press the\u00a0...']) expect(redactText(text, true)).toBe(text)
    expect(redactText('mysql -phunter\u00a02 db', true)).toBe('mysql -p*** db')
    expect(redactText('sshpass -p hunter\r2 ssh h', true)).toBe('sshpass -p *** ssh h')
    expect(redactText('docker login -p hunter2\r\nls', true)).not.toContain('hunter2')
  })

  it('reads the command a wrapper runs and only the login subcommand', () => {
    expect(redactText('sudo -u mysql docker login -p hunter2', true)).toBe('sudo -u mysql docker login -p ***')
    expect(publicToolFrame({ name: 'terminal', args: { command: ['sudo', '-u', 'mysql', 'docker', 'login', '-p', 'hunter2'] } }, true).args).toEqual({ command: ['sudo', '-u', 'mysql', 'docker', 'login', '-p', '***'] })
    expect(redactText('docker --config /x login -p hunter2', true)).toBe('docker --config /x login -p ***')
    expect(redactText('docker -D login -p hunter2', true)).toBe('docker -D login -p ***')
    for (const text of ['docker run image login -p public', 'docker run --rm -it image login -p public', 'helm install x login -p public', 'docker --debug run login -p public']) expect(redactText(text, true)).toBe(text)
    // A host named like a command keeps the login read.
    expect(redactText('docker login docker -p hunter2', true)).toBe('docker login docker -p ***')
    expect(redactText('helm registry login helm -p hunter2', true)).toBe('helm registry login helm -p ***')
  })

  it('recognizes a command name composed by quotes or escapes', () => {
    expect(redactText('do"cker" login -p hunter2', true)).not.toContain('hunter2')
    expect(redactText(`my'sql' -phunter2`, true)).not.toContain('hunter2')
    expect(redactText(String.raw`\sshpass -p hunter2 ssh h`, true)).not.toContain('hunter2')
  })
})

describe('round 44 shapes', () => {
  it('reads an argument enclosed in ANSI-C quotes with its escaped quotes', () => {
    expect(redactText(String.raw`login $'--password=correct\' horse' next`, true)).toBe(String.raw`login $'--password=***' next`)
    expect(redactText(String.raw`login '--password=a b' next`, true)).toBe(String.raw`login '--password=***' next`)
  })

  it('reads a whole Authorization scheme token before masking the credential', () => {
    const scheme = 'A'.repeat(33)
    expect(redactText(`curl -H 'Authorization: ${scheme} hunter2' x`, true)).toBe(`curl -H 'Authorization: ${scheme} ***' x`)
    expect(redactText(`curl -H 'Authorization: Custom_Scheme hunter2' x`, true)).toBe(`curl -H 'Authorization: Custom_Scheme ***' x`)
  })

  it('reads any RFC 7235 scheme token and the credential\'s whole shell word', () => {
    expect(redactText(`curl -H 'Authorization: 2FA hunter2' x`, true)).toBe(`curl -H 'Authorization: 2FA ***' x`)
    expect(redactText(`curl -H 'Authorization: Bearer foo'bar x`, true)).toBe(`curl -H 'Authorization: Bearer *** x`)
    expect(redactText(`curl -H "Authorization: Bearer foo"'bar' x`, true)).toBe(`curl -H "Authorization: Bearer *** x`)
    expect(redactText(`curl -H "Authorization: Bearer opaque" x`, true)).toBe(`curl -H "Authorization: Bearer ***" x`)
    // Re-redaction is idempotent: an all-asterisk word is a mask, not a scheme.
    expect(redactText(`Authorization: *** next`, true)).toBe(`Authorization: *** next`)
  })

  it('masks a URL password the shell assembles from quoted or escaped pieces', () => {
    expect(redactText(`curl https://bob:hun'ter2'@example.com`, true)).toBe(`curl https://bob:***@example.com`)
    expect(redactText(String.raw`curl https://b'o'b:hun\ter2@example.com`, true)).toBe(String.raw`curl https://b'o'b:***@example.com`)
    expect(redactText(`curl https://bob:hunter2@example.com`, true)).toBe(`curl https://bob:***@example.com`)
  })

  it('masks the scheme and credential of an Authorization header the dedicated rule cannot read', () => {
    expect(redactText(`curl -H 'Authoriz'ation': Basic hunter2' x`, true)).not.toContain('hunter2')
    expect(redactText(`Authorization : Basic hunter2 next`, true)).toBe(`Authorization : *** next`)
    expect(redactText(`Authorization: Basic 'hunter2' next`, true)).toBe(`Authorization: Basic '***' next`)
    expect(redactText(`curl -H 'Authorization: Basic hunter2' x`, true)).toBe(`curl -H 'Authorization: Basic ***' x`)
  })

  it('fails closed on a key built from substitutions or variables', () => {
    expect(redactText(`login --pass$(printf word)=hunter2 next`, true)).toBe(`login --pass$(printf word)=*** next`)
    expect(redactText('login --pass`printf word`=hunter2 next', true)).toBe('login --pass`printf word`=*** next')
    expect(redactText(`login --pass$W=hunter2 --pass\${W}x=hunter3 next`, true)).toBe(`login --pass$W=*** --pass*** next`)
  })

  it('reads a Bearer or query credential to the end of its shell word', () => {
    expect(redactText(`curl -H 'X-Auth: Bearer foo'bar https://x`, true)).toBe(`curl -H 'X-Auth: Bearer *** https://x`)
    expect(redactText(`X-Auth: Bearer 'hunter2' next`, true)).toBe(`X-Auth: Bearer '***' next`)
    expect(redactText(`curl 'https://x?access_token=foo'bar next`, true)).toBe(`curl 'https://x?access_token=*** next`)
    expect(redactText(`curl 'https://x?access_token=foo&y=1' next`, true)).toBe(`curl 'https://x?access_token=***&y=1' next`)
    expect(redactText(`curl https://x?access_token=a&token=b#frag next`, true)).toBe(`curl https://x?access_token=***&token=***#frag next`)
  })

  it('reads keys that start with an underscore or a digit', () => {
    expect(redactText(`login --_password=hunter2 next`, true)).toBe(`login --_password=*** next`)
    expect(redactText(`login --2fa_token=hunter2 next`, true)).toBe(`login --2fa_token=*** next`)
  })

  it('fails closed to the end of the text on a key substitution it cannot parse', () => {
    expect(redactText(`login --pass$(echo $(printf word))=hunter2 next`, true)).toBe(`login --pass***`)
    expect(redactText(`login --pass$(echo "a)b")=hunter2 next`, true)).toBe(`login --pass***`)
    expect(redactText(`cp file-$(date +%F).log backup/`, true)).toBe(`cp file-$(date +%F).log backup/`)
    expect(redactText('login --pass`echo \\`printf word\\``=hunter2 next', true)).toBe('login --pass`echo \\`printf word\\``=*** next')
    expect(redactText('login --pass`echo x=hunter2 next', true)).toBe('login --pass***')
    expect(redactText(`login --pass{word,word}=hunter2 next`, true)).toBe(`login --pass{word,word}=*** next`)
    expect(redactText(`login --pass{w{o,x}rd,}=hunter2 next`, true)).toBe(`login --pass***`)
    expect(redactText(`cp a.{txt,bak} && echo file{1..3}.txt`, true)).toBe(`cp a.{txt,bak} && echo file{1..3}.txt`)
    expect(redactText(`login --$(printf password)=hunter2 --\${KEY}=hunter3 -$K=hunter4 next`, true)).toBe(`login --$(printf password)=*** --\${KEY}=*** -$K=*** next`)
    expect(redactText('login --`printf password`=hunter2 next', true)).toBe('login --`printf password`=*** next')
    expect(redactText(`login --$(echo $(printf password))=hunter2 next`, true)).toBe(`login --***`)
    // A computed key needs `=`: `$HOST:$PORT`, `-$OPTS dir` and `` `code`: `` prose stay as written.
    expect(redactText('curl "$HOST:$PORT/token" && ls -$OPTS dir', true)).toBe('curl "$HOST:$PORT/token" && ls -$OPTS dir')
    expect(redactText('`password`: the login secret', true)).toBe('`password`: the login secret')
    expect(redactText(String.raw`login --pass$'\x77ord'=hunter2 --$'\x70assword'=hunter3 next`, true)).toBe(String.raw`login --pass$'\x77ord'=*** --$'\x70assword'=*** next`)
    expect(redactText(String.raw`printf $'a\tb' --width=4`, true)).toBe(String.raw`printf $'a\tb' --width=4`)
    expect(redactText(String.raw`login --password\=hunter2 api_key\: opaque next`, true)).toBe(String.raw`login --password\=*** api_key\: *** next`)
    expect(redactText(String.raw`curl https://bob\:hunter2@example.com next`, true)).toBe(String.raw`curl https://bob\:***@example.com next`)
    expect(redactText(String.raw`curl https://bob:hunter2\@example.com next`, true)).toBe(String.raw`curl https://bob:***\@example.com next`)
    expect(redactText(String.raw`curl https\:\/\/amy:pw2@x next`, true)).toBe(String.raw`curl https\:\/\/amy:***@x next`)
    expect(redactText(`set -- word; login --pass$1=hunter2 --pass$@=hunter3 -$#=x next`, true)).toBe(`set -- word; login --pass$1=*** --pass$@=*** -$#=*** next`)
    expect(redactText(`echo "costs $5 or $10" && ls $1`, true)).toBe(`echo "costs $5 or $10" && ls $1`)
    expect(redactText(`KEY=password; SEP='='; login --\${KEY}\${SEP}hunter2 next`, true)).toBe(`KEY=password; SEP='='; login --*** next`)
    expect(redactText(`login --pass\${TAIL}\${SEP}hunter2 next`, true)).toBe(`login --pass*** next`)
    expect(redactText('X=; login --password${X} hunter2 --password$Y hunter3 next', true)).toBe('X=; login --password*** *** --password*** *** next')
    expect(redactText('KEY=password; login --${KEY} hunter2 next', true)).toBe('KEY=password; login --*** *** next')
    expect(redactText(`ls -$OPTS dir && tar --out-$(date +%F) x && login --pass$X`, true)).toBe(`ls -$OPTS dir && tar --out-$(date +%F) x && login --pass$X`)
    expect(redactText(`login --{password,user}=hunter2 --{pass,pass}word=hunter3 --{p{a,b},x}=hunter4 next`, true)).toBe(`login --{password,user}=*** --*** --***`)
    expect(redactText(`echo --{a,b} {x,y}=1`, true)).toBe(`echo --{a,b} {x,y}=1`)
    expect(redactText(`SEP='='; login --password\${SEP}hunter2 --api_key$(printf =)hunter3 --token\${S}x=hunter4 next`, true)).toBe(`SEP='***'; login --password*** --api_key*** --token*** next`)
    // Markdown code spans are prose, not substitutions.
    expect(redactText('answer with **markdown** and `code` about the token', true)).toBe('answer with **markdown** and `code` about the token')
    expect(redactText('check the `token` field; use `${base}/api` and `a=$(date)`.', true)).toBe('check the `token` field; use `${base}/api` and `a=$(date)`.')
  })

  it('reads quoted bracket segments of a text credential key', () => {
    expect(redactText(`login --auth["password"]=hunter2 next`, true)).toBe(`login --auth["password"]=*** next`)
    expect(redactText(`login --auth['token']=hunter2 next`, true)).toBe(`login --auth['token']=*** next`)
    expect(redactText(String.raw`login --auth[\"password\"]=hunter2 next`, true)).toBe(String.raw`login --auth[\"password\"]=*** next`)
    expect(redactText(`login --user["name"]=bob`, true)).toBe(`login --user["name"]=bob`)
  })

  it('dequotes a credential option name the shell assembles from quoted or escaped pieces, through the prefilter', () => {
    // A `'` piece inside a word reads as a contraction, so its closing quote opens one: the mask runs to the line end.
    expect(redactText(`login --pass'word'=hunter2 next`, true)).toBe(`login --pass'word'=***`)
    expect(redactText(String.raw`login --pass\word=hunter2 next`, true)).toBe(String.raw`login --pass\word=*** next`)
    expect(redactText(`login --pa"ss"word=hunter2 next`, true)).toBe(`login --pa"ss"word=*** next`)
    expect(redactText(`login --pass$'word'=hunter2 next`, true)).toBe(`login --pass$'word'=*** next`)
    expect(redactText(`PASS'WORD'=hunter2 next`, true)).toBe(`PASS'WORD'=***`)
    expect(redactText(`login --us'er'=bob --pass'word'=hunter2`, true)).toBe(`login --us'er'=bob --pass'word'=***`)
  })

  it('routes an attached upper-case curl -U through the prefilter', () => {
    expect(redactText('curl -Ubob:hunter2 example.com', true)).toBe('curl -Ubob:*** example.com')
  })
})

describe('shell-composed words', () => {
  it('redacts a word as the program receives it when its quoting hides a delimiter', () => {
    for (const quoted of [`login --password'='hunter2 next`, `login --password"="hunter2 next`, `login --password$'='hunter2 next`]) {
      expect(redactText(quoted, true)).toMatch(/^login --password\S*\*\*\*/)
      expect(redactText(quoted, true)).not.toContain('hunter2')
    }
    expect(redactText(`curl https://bob:hunter2'@'example.com next`, true)).toBe(`curl https://bob:***@example.com next`)
    expect(redactText(`curl https://bob':'hunter2@example.com next`, true)).toBe(`curl https://bob:***@example.com next`)
  })

  it('fails closed where an expansion may supply a delimiter', () => {
    expect(redactText('AT=@; curl https://bob:hunter2${AT}example.com next', true)).toBe('AT=@; curl https://bob:*** next')
    expect(redactText(`login --password"\${SEP}"hunter2 next`, true)).not.toContain('hunter2')
    expect(redactText(`login --password"\${SEP}"hunter2 next`, true)).toContain(' next')
    expect(redactText('SEP=:; curl https://bob${SEP}hunter2@example.com https://bob${C}pw2${A}host next', true)).toBe('SEP=:; curl https://bob***@example.com https://bob*** next')
    for (const kept of ['curl https://api.github.com/repos/$OWNER/x', 'curl https://$HOST:8080/x', 'curl https://$SUB.example.com/x', "echo '$HOME' --token-file=$HOME/.tok"]) {
      expect(redactText(kept, true)).toBe(kept)
    }
  })

  it('masks the value after a computed header name', () => {
    expect(redactText('HEADER=Authorization; curl -H "${HEADER}: Basic hunter2" x', true)).toBe('HEADER=Authorization; curl -H "${HEADER}: ***" x')
    expect(redactText('curl -H "${HEADER}:Basic hunter2" --header ${H}:tok2 x', true)).toBe('curl -H "${HEADER}:***" --header ${H}:*** x')
    expect(redactText('curl "http://$HOST:$PORT/x" -o $OUT:file', true)).toBe('curl "http://$HOST:$PORT/x" -o $OUT:file')
  })

  it('decodes ANSI-C escapes as the shell does', () => {
    expect(redactText(String.raw`login $'--password\x3dhunter2' next`, true)).toBe('login --password=*** next')
    expect(redactText(String.raw`curl -H $'Authorization\x3a Basic hunter2' x`, true)).not.toContain('hunter2')
    expect(redactText(String.raw`login $'--\160assword=hunter2' $'--pass\u0077ord=hunter3' next`, true)).not.toMatch(/hunter/)
    expect(redactText(String.raw`printf $'a\tb' && echo $'it\'s'`, true)).toBe(String.raw`printf $'a\tb' && echo $'it\'s'`)
  })

  it('removes a line continuation as the shell does', () => {
    expect(redactText('login --pass\\\nword=hunter2 next', true)).toBe('login --password=*** next')
    expect(redactText('login --api\\\n_key "hunter2" next', true)).not.toContain('hunter2')
    for (const text of ["curl '--user' \\\n  bob:hunter2 https://x", 'curl --user \\\n  bob:hunter2 x', 'login --password \\\n  hunter2 next']) {
      expect(redactText(text, true)).not.toContain('hunter2')
    }
    // Nothing to mask: the command keeps its lines.
    expect(redactText('ls \\\n  -la --token-file=x', true)).toBe('ls \\\n  -la --token-file=x')
  })

  it('reads a quoted flag with the value word after it', () => {
    expect(redactText(`login '--password' hunter2 next`, true)).toBe(`login --password *** next`)
    expect(redactText(`curl '--user' bob:hunter2 https://x`, true)).toBe(`curl --user bob:*** https://x`)
    expect(redactText(`login "--pass"word 'hunter2' next`, true)).not.toContain('hunter2')
    expect(redactText(`curl '-H' 'Accept: json' "--data" 'a b' x`, true)).toBe(`curl '-H' 'Accept: json' "--data" 'a b' x`)
  })

  it('keeps words the rules already read as written', () => {
    expect(redactText(`curl -H "Authorization: Bearer opaque" -d '{"a": 1}' x`, true)).toBe(`curl -H "Authorization: Bearer ***" -d '{"a": 1}' x`)
    expect(redactText(`login "--password=two words" next`, true)).toBe(`login "--password=***" next`)
    expect(redactText(`echo it's fine and "quoted" too`, true)).toBe(`echo it's fine and "quoted" too`)
  })
})

describe('inline shell assignments', () => {
  it('masks a credential the command builds from variables it assigns', () => {
    expect(redactText(`SCHEME='https://'; U=bob; SEP=:; AT=@; curl "\${SCHEME}\${U}\${SEP}hunter2\${AT}example.com"`, true)).toBe(`SCHEME='https://'; U=bob; SEP=:; AT=@; curl "\${SCHEME}\${U}\${SEP}***\${AT}example.com"`)
    expect(redactText('HEADER=Authorization; SEP=:; curl -H "${HEADER}${SEP} Basic hunter2"', true)).toBe('HEADER=Authorization; SEP=:; curl -H "${HEADER}${SEP} Basic ***"')
    for (const text of ['SEP=:; curl -u bob${SEP}hunter2 x', 'export TOKEN_NAME=api_key; login --$TOKEN_NAME hunter2']) expect(redactText(text, true)).not.toContain('hunter2')
    // A reassigned name may hold any of its values: control flow may skip either assignment.
    for (const text of ['HEADER=X-Trace; HEADER=Authorization; SEP=:; curl -H "${HEADER}${SEP} Basic hunter2"', 'HEADER=Authorization; HEADER=X-Trace; SEP=:; curl -H "${HEADER}${SEP} Basic hunter2"', 'OPT=-u; false && OPT=echo; curl $OPT bob:hunter2 x']) {
      expect(redactText(text, true)).not.toContain('hunter2')
    }
    // An unknown reassignment, many values of one name, and combinations of several reassigned names.
    for (const text of ['OPT=-u; false && OPT=$(echo); curl $OPT bob:hunter2 x', 'OPT=a; OPT=b; OPT=-u; false && OPT=c; false && OPT=d; false && OPT=e; false && OPT=f; curl $OPT bob:hunter2 x',
      'H1=Author; false && H1=X; H2=ization; false && H2=Y; SEP=x; SEP=:; curl -H "${H1}${H2}${SEP} Basic hunter2"']) {
      expect(redactText(text, true)).not.toContain('hunter2')
    }
    // Past 8 combinations, a word with a reassigned name's reference fails closed, with the next word when it is whole.
    expect(redactText('A=1; A=2; B=1; B=2; C=1; C=2; D=1; D=2; OPT=-u; false && OPT=echo; curl $OPT bob:hunter2 x', true)).toBe('A=1; A=2; B=1; B=2; C=1; C=2; D=1; D=2; OPT=-u; false && OPT=echo; curl *** x')
    expect(redactText('A=1; A=2; B=1; B=2; C=1; C=2; D=1; D=2; OPT=-u; false && OPT=echo; curl "$OPT" bob:hunter2 x', true)).not.toContain('hunter2')
    // …through overlapping references and any run of blanks…
    for (const gap of [' ', ' '.repeat(65)]) expect(redactText(`A=1; A=2; B=1; B=2; C=1; C=2; D=1; D=2; OPT=x; false && OPT=echo; OPT2=-u; false && OPT2=echo; curl $OPT $OPT2${gap}bob:hunter2 x`, true)).not.toContain('hunter2')
    // …through a word of adjacent references…
    expect(redactText('A=--pass; false && A=x; B=word; false && B=y; C=1; C=2; D=1; D=2; login $A$B hunter2 x', true)).not.toContain('hunter2')
    // …and through a template alias of a reassigned name.
    expect(redactText('A=1; A=2; B=1; B=2; C=1; C=2; D=1; D=2; OPT=-u; false && OPT=echo; ARG=$OPT; curl $ARG bob:hunter2 x', true)).not.toContain('hunter2')
    for (const kept of ['D=/a; false && D=/b; cat $D/x.txt', 'A=1; A=2; seq $A']) expect(redactText(kept, true)).toBe(kept)
    // A value built from other assigned names.
    for (const text of ['OPT=-u; ARG=$OPT; curl $ARG bob:hunter2 x', 'U=bob; SEP=:; CRED="${U}${SEP}"; curl -u ${CRED}hunter2 x']) expect(redactText(text, true)).not.toContain('hunter2')
    // Distinct templates are distinct candidates; a quoted operand of an assignment builtin is an assignment.
    for (const text of ['A=-u; B=echo; ARG=$A; false && ARG=$B; curl $ARG bob:hunter2 x', 'export "KEY=--password"; login $KEY hunter2 x', "declare -x 'OPT=-u'; curl $OPT bob:hunter2 x"]) {
      expect(redactText(text, true)).not.toContain('hunter2')
    }
    expect(redactText('echo "KEY=--password"; login $KEY hunter2 x', true)).toBe('echo "KEY=--password"; login $KEY hunter2 x')
    // A literal append, and a quote inside a comment.
    for (const text of ['OPT=-; OPT+=u; curl $OPT bob:hunter2 x', 'export "OPT=-"; export "OPT+=u"; curl $OPT bob:hunter2 x', `H=Authorization; S=: # don't\ncurl -H "\${H}\${S} Basic hunter2"`]) {
      expect(redactText(text, true)).not.toContain('hunter2')
    }
    // A computed value fails closed; an unquoted value splits into fields as the shell does.
    expect(redactText('OPT=$(printf -- -u); curl $OPT bob:hunter2 x', true)).toBe('OPT=$(printf -- -u); curl *** x')
    expect(redactText(`OPT='foo --password'; login $OPT hunter2 x`, true)).not.toContain('hunter2')
    // An escaped separator keeps the rest in the value: `OPT=echo` is part of `A`.
    expect(redactText('OPT=-u; A=foo\\;OPT=echo; curl $OPT bob:hunter2 x', true)).not.toContain('hunter2')
  })

  it('masks a discovered secret everywhere, the assignment that defined it included', () => {
    expect(redactText('P=hunter2; curl -u bob:$P x', true)).toBe('P=***; curl -u bob:*** x')
    expect(redactText('P=hunter2; curl -u "bob:${P}" x; echo hunter2', true)).toBe('P=***; curl -u "bob:***" x; echo ***')
    // A secret glued from a value and literal text is masked by its pieces.
    expect(redactText(`SCHEME='https://'; U=bob; SEP=:; AT=@; P=hunt; curl "\${SCHEME}\${U}\${SEP}\${P}er2\${AT}example.com"`, true)).not.toMatch(/hunt|er2/)
    // A secret with no letter or digit.
    expect(redactText(`P='!!!'; curl -u "bob:$P" x`, true)).toBe(`P='***'; curl -u "bob:***" x`)
    expect(redactText(`SCHEME='https://'; U=bob; SEP=:; AT=@; curl "\${SCHEME}\${U}\${SEP}!!!\${AT}example.com"`, true)).not.toContain('!!!')
    // Unquoted, `;` would end the substituted word and publish the rest.
    expect(redactText(`P='hunter2;extra words'; curl -u bob:$P x`, true)).not.toMatch(/hunter2|extra|words/)
  })

  it('keeps every fail-closed mask, whatever the shell runs', () => {
    // `KEY=foo` never runs: the ambient `KEY` may name a credential.
    expect(redactText('false && KEY=foo; login --${KEY} hunter2; P=pw; curl -u bob:$P x', true)).toBe('false && KEY=foo; login --*** ***; P=***; curl -u bob:*** x')
  })

  it('reads an assignment wherever the shell may, and past an unknown one', () => {
    for (const text of ['{ OPT=-u; curl $OPT bob:hunter2 x; }', 'if true; then OPT=-u; curl $OPT bob:hunter2 x; fi', 'A=$(printf x); OPT=-u; curl $OPT bob:hunter2 x', 'A="$(date)" OPT=-u; curl $OPT bob:hunter2 x']) {
      expect(redactText(text, true)).not.toContain('hunter2')
    }
  })

  it('masks the whole value of an assignment whose substitution is masked', () => {
    expect(redactText(`P='@@@'; curl -u "bob:$P" x`, true)).toBe(`P='***'; curl -u "bob:***" x`)
    expect(redactText(`P='hunter2!!!'; curl -u "bob:$P" x`, true)).toBe(`P='***'; curl -u "bob:***" x`)
    expect(redactText(`SCHEME='https://'; U=bob; SEP=:; AT=@; curl "\${SCHEME}\${U}\${SEP}hunter2!!!\${AT}example.com"`, true)).not.toMatch(/hunter2|!!!/)
    expect(redactText(`SCHEME='https://'; U=bob; SEP=:; AT=@; P=hunt; curl "\${SCHEME}\${U}\${SEP}$P!!!\${AT}example.com"`, true)).not.toMatch(/hunt|!!!/)
    expect(redactText(`P='$$$'; curl -u "bob:$P" x`, true)).toBe(`P='***'; curl -u "bob:***" x`)
    // A secret is masked at every assignment of it, however spelled.
    expect(redactText(String.raw`P=$'hunter\x32'; false && P=hunter2; curl -u bob:$P x`, true)).toBe(String.raw`P=$'***'; false && P=***; curl -u bob:*** x`)
    // A delimiter-only secret is masked at every assignment of it and as a whole word.
    expect(redactText(`P='@@@'; P='@@@'; curl -u "bob:$P" x; echo @@@`, true)).toBe(`P='***'; P='***'; curl -u "bob:***" x; echo ***`)
    // Past the expansion cap every literal value is taken as a secret.
    const long = 'x'.repeat(2_000)
    expect(redactText(`P=${long}; echo $P $P $P $P $P; curl -u bob:$P x`, true)).not.toContain(long.slice(0, 20))
    expect(redactText(`A=${long}; echo $A $A $A $A $A $A; Q=hunter2; curl -u bob:$Q x`, true)).not.toContain('hunter2')
  })

  it('keeps a command with nothing to mask as written', () => {
    for (const text of ['D=/tmp; cat $D/x.txt', 'N=3; seq $N', 'export D=/tmp && ls "$D"']) expect(redactText(text, true)).toBe(text)
  })

  it('leaves unknown variables, parameter operators and single-quoted names alone', () => {
    expect(redactText('curl -u bob${SEP}hunter2', true)).toBe('curl -u bob***')
    const kept = "A=@; echo 'bob:hunter2$A'x bob:hunter2${A:-}x"
    expect(redactText(kept, true)).toBe(kept)
  })
})

describe('credential key length', () => {
  it('masks a credential option whose identifier is longer than any fixed cap, through the public prefilter', () => {
    const namespace = 'company'.repeat(40)
    expect(redactText(`login --${namespace}Password=hunter2 --user bob`, true)).toBe(`login --${namespace}Password=*** --user bob`)
    expect(redactText(`${namespace}_api_key: "opaque value"`, true)).toBe(`${namespace}_api_key: "***"`)
    expect(redactText(`${namespace}+ssh://bob:hunter2@host`, true)).toBe(`${namespace}+ssh://bob:***@host`)
  })
})

describe('redactSensitive cost', () => {
  it('preserves assignment boundaries and masks other credential families without equals (TAL-1029)', () => {
    for (const [text, expected] of [
      ['https://example.test/UPPERCASE_TOKEN_TEXT', 'https://example.test/UPPERCASE_TOKEN_TEXT'],
      ['= https://bob:secret@example.test/', '= https://bob:***@example.test/'],
      ['https://bob:secret@example.test/ =', 'https://bob:***@example.test/ ='],
      ['API_KEY=secret PASSWORD="secret" TOKEN=\'secret\'', 'API_KEY=*** PASSWORD="***" TOKEN=\'***\''],
      ['API_KEY=) API_KEY=secret API_KEY=) API_KEY=other', 'API_KEY=) API_KEY=*** API_KEY=) API_KEY=***'],
      ['Authorization: Bearer secret', 'Authorization: Bearer ***'],
      ['https://bob:secret@example.test/', 'https://bob:***@example.test/'],
      ['ghp_abcdefghij0123456789', 'ghp_ab...6789'],
      ['ghp_abc\x1b[1mdefghij0123456789', 'ghp_ab...6789'],
      ['ghp_abc\ndefghij0123456789', 'ghp_ab...6789'],
    ]) expect(redactSensitive(text!)).toBe(expected)
  })

  it('skips assignment-family scans when their required equals delimiter is absent (TAL-1029)', () => {
    const scans: unknown[] = []
    const onScan = (message: unknown): void => { scans.push(message) }
    subscribe('talaria.redaction.assignment-scan', onScan)
    try {
      redactSensitive('API_KEY=secret API_KEY=)')
      expect(scans).toContainEqual({ purpose: 'mask', characters: expect.any(Number) as unknown })
      expect(scans).toContainEqual({ purpose: 'restore', characters: expect.any(Number) as unknown })
      scans.length = 0
      for (const size of [64 * 1024, 256 * 1024]) {
        const text = `https://example.test/${'UPPERCASE_TOKEN_TEXT/'.repeat(Math.ceil(size / 21))}`.slice(0, size)
        expect(redactSensitive(text)).toBe(text)
      }
      expect(scans).toEqual([])
    } finally {
      unsubscribe('talaria.redaction.assignment-scan', onScan)
    }
  })

  it('stays linear on long runs of scheme and identifier characters', () => {
    // Four times the input takes about 4x as long when linear and about 16x when quadratic, on a runner of any speed.
    // `scale` multiplies each input's repeat counts, so 1/4 builds the same input at a quarter of its length.
    const inputs = (scale: number): string[] => {
      const fill = (seg: string): string => seg.repeat(Math.ceil(200_000 * scale / seg.length))
      return [
        ...['abcdefghij-', 'a.b+c-', 'token_', '--password ', 'aB', 'aBcD_', 'ABCd', 'AB', 'PW', 'KEY_', 'a_pw', 'a_key_', 'ghp_a\x1b', 'ghp_a\x1b[1m', 'ghp_a\x1b]8;;a', '\x1b[1', 'ghp_a\x9b1m', '\x9d8;;a', 'ghp_a\x1bPa', '\x1b( ', '\x90a\x9d', '\x1b\x00\x00', 'ghp_a\x1b[\x07', '\x1b(\x00', 'g\x1b]0;h\x07', 'x\x1b]0;a\x07', '\x1b]0;g\x07h', 'gh\x1b]0;p\x07\x1b]0;_\x07', 'ghp_ab\n', 'eyJaaaaaaaaaa.', 'eyJaaaaaaaaaa\x1b[1m', 'ey\x1b[1mJ', 'e\x1b]0;y\x07J', '-e\x1b]0;y\x07J', 'eyJaaaa\x1b]0;a\x07', 'eyJaaaaaaaaaa\n.', '+1234567', 'https://aaaaaaaa', 'DB_PW="', "db_pw='a ", 'ghp_ab\nK=', 'a_key=x\\ ', 'a_key=,', '\nsk-a', 'sk-aaaaaaaaaaaa\n', '&a_key=x', 'sk-aaaaaaaaaa\nsk-b\n', '2', '1234 ', '-----BE\x1b[1mGIN PRIVATE KEY-----\n', '-----BEGIN PRI\x1b[1mVATE KEY-----', '-----B\x1b]0;x\x07E\x1b]0;GIN\x07 PRIVATE KEY-----', '-----B\x1b]0;x\x07E\x1b]0;GIN\x07', '-\x1b]0;-\x07', '\x1b[1;31mAPI_KEY\x1b[m=abcdefghij\x1b[m ', '\x1b[1;34m"password"\x1b[0m: "x" ', 'Bear\x1b[1mer $$$$ ', 'Bear\x1b[1mer ****** '].map(fill),
        ...['Authorization: x ', 'Authorization: *** ', 'secret sauce ', 'password=*** '].map((seg) => `"${fill(seg)}"`),
        // Overlapping parameter heads inside a masked word, and flags swallowed by repeated enclosing-quote values.
        `"${'password=x '.repeat(20_000 * scale)}"}--password finalSecret987`,
        ...['{"password":" x password=foo"}--password finalSecret987 ', '{"pass\x1b[31mword":" x password=foo"}--password finalSecret987 '].map(fill),
        'Authorization: "--password foo "--password finalSecret987 '.repeat(4_000 * scale),
        // One huge identifier that does name a credential, and many long ones that are followed by a separator.
        `--${'aB'.repeat(100_000 * scale)}Password=x`, `${'2'.repeat(200_000 * scale)}:`, `ghp_a\x1b${'\x00'.repeat(200_000 * scale)}`, `${'a'.repeat(1_000)}= `.repeat(200 * scale), `${'a'.repeat(1_000)}://x:`.repeat(200 * scale),
        // Shell-composed identifiers: unclosed and alternating quote and escape pieces.
        ...[`a'`, `a"b'c\\d`, `a'b'`, `pass$'`, `a$(b`, 'a`b ', `a\${b`, `a$b`, `x://b:c'd`, `a$(b$(`, `?token=a&`, `Bearer a'`, `a{b,`, `a{b`, `a{,}`, `a$'\\`, `--$'\\x`, `a'='`, `a'b `, `x:'@'`, `%41`, `a%4`, `a:b`, `'--a', '`, `"-u", "x`].map((seg) => `--${fill(seg)}`),
        // Inline assignments: long chains, prefix chains, many substitutions, and a secret substituted many times.
        ...['A=x; ', 'A=x B=y ', 'export A=x ', '; ', ';A', `A='x `, 'A="x ', 'A=${ ', 'A=$( ', `A=n'x `, 'A=@; $A ', 'A=!; $A '].map(fill),
        `A=x; ${'$A ${A} '.repeat(30_000 * scale)}`, Array.from({ length: 20_000 * scale }, (_, i) => `A=${i}; $A `).join(''), `${'A=$(x); '.repeat(20_000 * scale)}${'A=1; $A '.repeat(20_000 * scale)}`,
        Array.from({ length: 5 }, (_, i) => `A=${i}; `).join('') + '$A '.repeat(50_000 * scale), `A=${'x'.repeat(10_000 * scale)}; ${'B=$A; '.repeat(30_000 * scale)}`, `A=x; ${'A=$A$A; '.repeat(25_000 * scale)}curl -u bob:$A`,
        `P=hunter2; ${'Q="${P}x"; curl -u bob:$Q '.repeat(8_000 * scale)}`, `export ${'"A=1" '.repeat(40_000 * scale)}`, `A=1; ${'A+=1; '.repeat(30_000 * scale)}$A`, `x # '\n`.repeat(40_000 * scale), `A=1; A=2; B=1; B=2; C=1; C=2; D=1; D=2; ${'$A '.repeat(40_000 * scale)}`, `export ${'"A=$(x" '.repeat(30_000 * scale)}`, `A=1; A=2; B=1; B=2; C=1; C=2; ${'curl -u bob:$A$B$C '.repeat(12_000 * scale)}`, `P=hunter2; ${'curl -u bob:$P '.repeat(15_000 * scale)}`, `A=${'x'.repeat(10_000 * scale)}; ${'$A'.repeat(50_000 * scale)}`,
        // Command-specific short flags: many commands in one command, quoted ones, and unterminated quotes.
        ...['mysql ', 'mysql -p', 'docker login -p x ', `sh -c 'mysql `, `mysql '`, `'mysql', `, `"mysql -p" `, 'sshpass -f ', 'mysql docker sshpass redis-cli smbclient helm -x ', `d'o"c\\k'e"r `, 'docker login docker ', 'mysql -p"\n', 'docker $A -p x ', 'mysql -p$(', 'mysql -p$(a ', '$A login -p x ', 'x; `a` -p ', 'mysql -pa,b ', `${'$AAAAAAAA'.repeat(20)}= `, 'A=x A=x $A ', `${'A=x '.repeat(50_000 * scale)}$B -p x`, `${'a'.repeat(200_000 * scale)}$b`, 'env sudo $(x) ', 'docker 2>', 'sshpass <x ', '$(a $(b ', `x; ${'a$b'.repeat(50_000 * scale)}=`, `sh -c "mysql -p'a `].map(fill)
      ]
    }
    // This thread's CPU time in milliseconds: wall clock charges a short run less than a long one on a preempted runner.
    const cost = (text: string): number => {
      const started = process.threadCpuUsage()
      mightContainSensitiveText(text)
      redactSensitive(text)
      const { user, system } = process.threadCpuUsage(started)
      return (user + system) / 1000
    }
    const quarters = inputs(1 / 4)
    inputs(1).forEach((text, i) => {
      const label = JSON.stringify(text.slice(0, 60))
      const quarter = quarters[i]!
      // An input whose quarter build keeps its length would compare against itself and never fail.
      expect(text.length / quarter.length, label).toBeGreaterThan(3)
      const quarterCost = cost(quarter)
      const fullCost = cost(text)
      expect(fullCost, label).toBeLessThan(8 * quarterCost + 100)
      // A hang guard, far above any runner's linear cost.
      expect(fullCost, label).toBeLessThan(10_000)
    })
    // The per-input checks above decide; this only has to outlast all of them on a loaded runner.
  }, 300_000)
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

  it('masks a header object\'s value when any of its label fields names a credential', () => {
    const frame = publicToolFrame({ name: 'http', args: { item: { name: 'metadata', header: 'Authorization', value: 'hunter2' }, other: { name: 'Accept', value: 'json' } } }, true)
    expect(frame.args).toEqual({ item: { name: 'metadata', header: 'Authorization', value: '***' }, other: { name: 'Accept', value: 'json' } })
    const plural = publicToolFrame({ name: 'http', args: { h: { name: 'Authorization', values: ['hunter2'], data: { v: 'opaque' } } } }, true)
    expect(plural.args).toEqual({ h: { name: 'Authorization', values: ['***'], data: { v: '***' } } })
  })

  it('masks AWS access key IDs, temporary ones included, by key and by prefix', () => {
    expect(redactText('AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE aws s3 ls', true)).not.toContain('IOSFODNN7EXA')
    expect(redactText('id is ASIAIOSFODNN7EXAMPLE here', true)).not.toContain('IOSFODNN7EXA')
    expect(publicToolFrame({ name: 'aws', args: { accessKeyId: 'opaque-id', access_key_id: 'opaque-2', region: 'us' } }, true).args).toEqual({ accessKeyId: '***', access_key_id: '***', region: 'us' })
  })

  it('decodes a percent-encoded parameter name once before the credential check', () => {
    expect(redactText(`curl 'https://x?api%5Fkey=hunter2&y=1' -d 'pass%77ord=hunter3&user=bob'`, true)).toBe(`curl 'https://x?api%5Fkey=***&y=1' -d 'pass%77ord=***&user=bob'`)
    expect(redactText(`curl 'https://x?q=a%20b&page=2'`, true)).toBe(`curl 'https://x?q=a%20b&page=2'`)
  })

  it('masks userinfo behind a computed or missing scheme', () => {
    expect(redactText('SCHEME=https; curl ${SCHEME}://bob:hunter2@example.com && curl $S://amy:pw2@x', true)).toBe('SCHEME=https; curl ${SCHEME}://bob:***@example.com && curl $S://amy:***@x')
    expect(redactText('curl bob:hunter2@example.com/x', true)).toBe('curl bob:***@example.com/x')
    expect(redactText('curl bob:hunter2@%C3%A9xample.com && curl amy:pw2@éxample.com', true)).toBe('curl bob:***@%C3%A9xample.com && curl amy:***@éxample.com')
    expect(redactText('curl bob:hunter:2@host/x', true)).toBe('curl bob:***@host/x')
    expect(redactText('curl $(printf https)://bob:hunter2@example.com && curl {http,https}://amy:pw2@x', true)).toBe('curl $(printf https)://bob:***@example.com && curl {http,https}://amy:***@x')
    expect(redactText("SCHEME='https://'; curl ${SCHEME}bob:hunter2@example.com", true)).toBe("SCHEME='https://'; curl ${SCHEME}bob:***@example.com")
    expect(redactText('curl "${SCHEME}${USER}hunter2@example.com" x', true)).toBe('curl "${SCHEME}${USER}***@example.com" x')
    expect(redactText('curl "${U}:${P}@host" && cp $HOME/a@b .', true)).toBe('curl "${U}:${P}@host" && cp $HOME/a@b .')
    expect(redactText('ssh git@github.com && git clone git@github.com:org/repo.git && echo 10:30', true)).toBe('ssh git@github.com && git clone git@github.com:org/repo.git && echo 10:30')
  })

  it('masks a credential flag\'s value in an argv array, parsed or as the live snapshot string', () => {
    const parsed = publicToolFrame({ name: 'terminal', args: { command: ['login', '--password', 'hunter2', '--user', 'bob', 'curl', '-u', 'amy:pw2'] } }, true)
    expect((parsed.args as { command: string[] }).command).toEqual(['login', '--password', '***', '--user', 'bob', 'curl', '-u', 'amy:***'])
    expect(JSON.stringify(parsed)).not.toMatch(/hunter2|pw2/)
    const live = publicToolFrame({ name: 'terminal', args: { command: `['login', '--password', 'hunter2', '-u', 'amy:pw2']` } }, true)
    expect(JSON.stringify(live)).not.toMatch(/hunter2|pw2/)
    expect(redactText(`["login", "--api-key", "opaque", "--name", "x"]`, true)).toBe(`["login", "--api-key", "***", "--name", "x"]`)
    const numeric = publicToolFrame({ name: 'terminal', args: { command: ['login', '--password', 123456, '--token', ['abc'], '--port', 8080] } }, true)
    expect((numeric.args as { command: unknown[] }).command).toEqual(['login', '--password', '***', '--token', ['***'], '--port', 8080])
    expect(JSON.stringify(numeric)).not.toMatch(/123456|abc/)
    expect(redactText(`['login', '--password', 123456, '--secret', ['x1y2'], '--port', 8080]`, true)).toBe(`['login', '--password', ***, '--secret', ***, '--port', 8080]`)
  })

  it('decodes JSON unicode escapes in a key name', () => {
    expect(redactText(String.raw`{"pass\u0077ord":"hunter2","user":"bob"}`, true)).not.toContain('hunter2')
    expect(JSON.stringify(publicToolFrame({ name: 'http', args: { body: String.raw`{"api\u005fkey": "opaque"}` } }, true))).not.toContain('opaque')
  })

  it('masks boolean credential leaves', () => {
    expect(publicToolFrame({ name: 'x', args: { password: true, cmd: ['login', '--password', false], h: { name: 'Authorization', value: true }, verbose: true } }, true).args)
      .toEqual({ password: '***', cmd: ['login', '--password', '***'], h: { name: 'Authorization', value: '***' }, verbose: true })
  })

  it('omits the target of a frame without args, so a completion keeps the target its start frame set', () => {
    expect(publicToolFrame({ name: 'terminal', tid: 't1', preview: 'ok' }, true)).toEqual({ name: 'terminal', tid: 't1', preview: 'ok', kind: 'shell' })
    expect(publicToolFrame({ name: 'terminal', tid: 't1', args: { command: 'ls' } }, true)).toMatchObject({ kind: 'shell', target: 'ls' })
    // Empty or non-displayable args (the sidecar sends `{}` for non-dict callback args) carry no target either.
    expect(publicToolFrame({ name: 'terminal', tid: 't1', args: {} }, true)).not.toHaveProperty('target')
  })
})

describe('target order', () => {
  it('derives a persisted target in the live order, capped before it is redacted', () => {
    const query = `token=${'c'.repeat(150)} find docs`
    // Live: the sidecar's snapshot capped the raw value at 120 before the server redacted it.
    const live = publicToolFrame({ name: 'web_search', args: { query: `${query.slice(0, 120)}...` } }, true)
    const persisted = redactSessionData({ messages: [{ role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'web_search', arguments: JSON.stringify({ query }) } }] }] }, true)
    const call = ((persisted.messages as Record<string, unknown>[])[0]!.tool_calls as Record<string, unknown>[])[0]!
    expect(call.target).toBe(live.target)
    expect(String(live.target)).not.toContain('ccc')
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

  it('masks object-valued function arguments by key', () => {
    const out = redactSessionData({ messages: [{ role: 'assistant', tool_calls: [{ id: 'a', type: 'function', function: { name: 'login', arguments: { user: 'bob', password: 'hunter2' } } }] }] }, true)
    expect(JSON.stringify(out)).not.toContain('hunter2')
    const call = ((out.messages as Record<string, unknown>[])[0]!.tool_calls as { function: { arguments: unknown } }[])[0]!
    expect(call.function.arguments).toEqual({ user: 'bob', password: '***' })
  })

  // TAL-1945: `hold_stream`: the user only ever got the rewritten reply, so nothing else of the turn leaves the server.
  it('ships a held turn\'s tool calls and rewritten reply, and none of its withheld text', () => {
    const commentary = (text: string) => ({ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text }] })
    const messages = withTurnIds([
      { role: 'user', content: 'Go', _turn_id: 'held' },
      { role: 'assistant', id: 1, content: 'HIDDEN-CONTENT', reasoning: 'HIDDEN-REASONING', reasoning_content: 'HIDDEN-RC', thinking: 'HIDDEN-THINK', _inline_thinking: 'HIDDEN-INLINE', reasoning_titles: ['HIDDEN-TITLE'], reasoning_details: [{ type: 'reasoning.text', text: 'HIDDEN-DETAIL' }], codex_reasoning_items: [{ type: 'reasoning', summary: [{ text: 'HIDDEN-SUMMARY' }] }], codex_message_items: [commentary('HIDDEN-COMMENTARY')], display_kind: 'hidden', tool_calls: [{ id: 'a', name: 'read_file', args: { path: 'one' } }], _turn_id: 'held' },
      { role: 'tool', tool_call_id: 'a', content: 'one', _turn_id: 'held' },
      { role: 'assistant', id: 2, content: [{ type: 'text', text: 'HIDDEN-BLOCK' }, { type: 'thinking', thinking: 'HIDDEN-BLOCK-THINK' }, { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'two' } }], display_kind: 'hidden', _turn_id: 'held' },
      { role: 'tool', tool_call_id: 'b', content: 'two', _turn_id: 'held' },
      { role: 'assistant', id: 3, content: 'Rewritten.', reasoning: 'Plan.\n\nWITHHELD-COMMENTARY', codex_message_items: [commentary('WITHHELD-COMMENTARY')], display_metadata: { commentary_withheld: true }, _turn_id: 'held' },
    ])
    const out = redactSessionData({ messages: hydrateAnchorActivityScenes(messages, {}) }, true)
    expect(JSON.stringify(out)).not.toMatch(/HIDDEN|WITHHELD/)
    const rows = out.messages as Record<string, unknown>[]
    expect(rows.every((row) => MessageSchema.safeParse(row).success)).toBe(true)
    expect(rows[1]).toMatchObject({ content: '', _display: 'hidden', tool_calls: [{ id: 'a', name: 'read_file' }] })
    expect(rows[3]).toMatchObject({ content: [{ type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'two' } }], _display: 'hidden' })
    expect(rows[3]!.content).toHaveLength(1)
    expect(rows[5]).toMatchObject({ content: 'Rewritten.', reasoning: 'Plan.', _display: 'row' })
    expect((rows[5]!._anchor_activity_scene as { activity_rows: { row_id: string }[] }).activity_rows.map((row) => row.row_id)).toEqual(['tool:a', 'tool:b', '3:reasoning'])
  })

  it.each<[string, Record<string, unknown>]>([
    ['a list', { reasoning: ['Plan.', 'WITHHELD-COMMENTARY'] }],
    ['the provider field', { reasoning_content: 'Plan.\n\nWITHHELD-COMMENTARY' }],
  ])('takes withheld commentary out of reasoning stored as %s (TAL-1945)', (_, reasoning) => {
    const items = [{ type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'WITHHELD-COMMENTARY' }] }]
    const out = redactSessionData({ messages: [{ role: 'assistant', content: 'Rewritten.', codex_message_items: items, display_metadata: { commentary_withheld: true }, ...reasoning }] }, true)
    expect(JSON.stringify(out)).not.toContain('WITHHELD')
    expect((out.messages as Record<string, unknown>[])[0]).toMatchObject({ content: 'Rewritten.', reasoning: 'Plan.' })
  })

  it.each<[string, Record<string, unknown>]>([
    ['a Codex row without the marker', { role: 'assistant', content: 'Reply.', reasoning: 'Plan.\n\nShown.', codex_message_items: [{ type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'Shown.' }] }] }],
    ['a Codex row whose marker is off', { role: 'assistant', content: 'Reply.', reasoning: 'Plan.\n\nShown.', codex_message_items: [{ type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'Shown.' }] }], display_metadata: { commentary_withheld: false } }],
    ['a hidden user row', { role: 'user', content: 'Wakeup prompt', display_kind: 'hidden' }],
  ])('leaves %s as it is (TAL-1945)', (_, row) => {
    expect(redactSessionData({ messages: [row] }, true).messages).toEqual([{ ...row, _display: row.display_kind === 'hidden' ? 'hidden' : 'row' }])
  })

  it('marks a user message longer than 20 lines or 2,000 characters collapsible (TAL-452)', () => {
    const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')
    const collapsible = (message: Record<string, unknown>): unknown => ((redactSessionData({ messages: [message] }, true).messages as Record<string, unknown>[])[0]!)._collapsible
    expect(collapsible({ role: 'user', content: lines(21) })).toBe(true)
    expect(collapsible({ role: 'user', content: 'x'.repeat(2001) })).toBe(true)
    expect(collapsible({ role: 'user', content: [{ type: 'text', text: lines(21) }] })).toBe(true)
    expect(collapsible({ role: 'user', content: lines(20) })).toBeUndefined()
    expect(collapsible({ role: 'user', content: 'x'.repeat(2000) })).toBeUndefined()
    // Measured on the text clients receive: a long credential redacted to `***` brings it under the limit.
    expect(collapsible({ role: 'user', content: `${'x'.repeat(1980)} API_KEY=${'a'.repeat(30)}` })).toBeUndefined()
    for (const role of ['assistant', 'tool', 'system']) expect(collapsible({ role, content: lines(40) })).toBeUndefined()
    expect(collapsible({ role: 'user', content: lines(40), _steer: { steer_id: 's1' } })).toBeUndefined()
    // Rows the Agent wrote in the user role are not prompts: background wakeups and compaction markers render their own way.
    expect(collapsible({ role: 'user', content: lines(40), _background_update: { kind: 'process' } })).toBeUndefined()
    expect(collapsible({ role: 'user', content: lines(40), _marker_kind: 'context_compaction' })).toBeUndefined()
    // Measured without the `[Attached files: ...]` line clients hide: a short prompt with many long paths stays whole.
    const attached = `\n\n[Attached files: ${Array.from({ length: 40 }, (_, i) => `/workspace/uploads/${'deep/'.repeat(10)}file-${i}.png`).join(', ')}]`
    expect(collapsible({ role: 'user', content: `Look at these${attached}` })).toBeUndefined()
    expect(collapsible({ role: 'user', content: `${lines(21)}${attached}` })).toBe(true)
    // The server's decision replaces any `_collapsible` a stored or imported row carries.
    expect(collapsible({ role: 'user', content: 'short', _collapsible: true })).toBeUndefined()
    expect(collapsible({ role: 'user', content: lines(40), _steer: { steer_id: 's2' }, _collapsible: true })).toBeUndefined()
  })

  it('stamps how every row shows: on its own, inside its turn\'s scene, or not at all (TAL-600)', () => {
    const display = (message: Record<string, unknown>): unknown => ((redactSessionData({ messages: [message] }, true).messages as Record<string, unknown>[])[0]!)._display
    const scene = { version: 'activity_scene_v1', activity_rows: [] }
    // Rows the turn's activity scene shows: tool results and consumed steers.
    expect(display({ role: 'tool', content: 'ok', tool_call_id: 'c1' })).toBe('in_scene')
    expect(display({ role: 'user', content: 'Use the staging DB', _steer: { steer_id: 's1' } })).toBe('in_scene')
    // Rows nothing shows: a silent background reply and rows without a role or anything to show.
    expect(display({ role: 'assistant', content: '[SILENT]', _background_reply: true, _background_silent: true })).toBe('hidden')
    expect(display({ content: 'orphan' })).toBe('hidden')
    expect(display({ role: 'assistant', content: '  ' })).toBe('hidden')
    expect(display({ role: 'user', content: '' })).toBe('hidden')
    expect(display({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] })).toBe('hidden')
    expect(display({ role: 'user', content: '', _source: 'process_wakeup' })).toBe('hidden')
    // Rows that show on their own.
    expect(display({ role: 'user', content: 'Plan the release' })).toBe('row')
    expect(display({ role: 'user', content: '', attachments: [{ name: 'a.png' }] })).toBe('row')
    expect(display({ role: 'user', content: 'Done', _source: 'process_wakeup', _background_update: { kind: 'process' } })).toBe('row')
    expect(display({ role: 'user', content: '', _marker_kind: 'context_compaction' })).toBe('row')
    expect(display({ role: 'assistant', content: 'Here is the plan.' })).toBe('row')
    expect(display({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }] })).toBe('row')
    expect(display({ role: 'assistant', content: '', reasoning: 'Thinking it through' })).toBe('row')
    expect(display({ role: 'assistant', content: '', _anchor_activity_scene: scene })).toBe('row')
    expect(display({ role: 'system', content: 'Model switched' })).toBe('row')
    // The server's decision replaces any `_display` a stored or imported row carries.
    expect(display({ role: 'tool', content: 'ok', _display: 'row' })).toBe('in_scene')
  })

  it('ships a stored row\'s turn stats, `_ts` and reasoning titles in their contract types (TAL-598)', () => {
    const stored = { role: 'assistant', content: 'Done.', _ts: '1700000001.5', _turnDuration: '4.25', _turnTps: 'fast', reasoning_titles: ['Plan', 7, '', 'Check'] }
    const [row] = redactSessionData({ messages: [stored] }, true).messages as Record<string, unknown>[]
    expect(MessageSchema.safeParse(row).success).toBe(true)
    expect(row).toMatchObject({ _ts: 1700000001.5, _turnDuration: 4.25, reasoning_titles: ['Plan', 'Check'] })
    expect(row).not.toHaveProperty('_turnTps')
  })

  it('ships a stored turn usage record only in its contract shape (TAL-1076)', () => {
    const usage = { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost: null, cache_hit_percent: null }
    const rows = redactSessionData({ messages: [{ role: 'assistant', content: 'a', _turnUsage: usage }, { role: 'assistant', content: 'b', _turnUsage: { input_tokens: '10' } }] }, true).messages as Record<string, unknown>[]
    expect(rows.every((row) => MessageSchema.safeParse(row).success)).toBe(true)
    expect(rows[0]?._turnUsage).toEqual(usage)
    expect(rows[1]).not.toHaveProperty('_turnUsage')
  })

  it('returns a user image part carrying a complete raster data URI byte-identical without scanning it (TAL-583)', () => {
    // Structurally complete images whose bytes carry an AWS-key-shaped base64 run: text redaction would rewrite them.
    const u32be = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
    const pngChunk = (type: string, data: Buffer): Buffer => Buffer.concat([u32be(data.length), Buffer.from(type, 'latin1'), data, u32be(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])))])
    const riff = (type: string, data: Buffer): Buffer => Buffer.concat([Buffer.from(type, 'latin1'), u32le(data.length), data, Buffer.alloc(data.length & 1)])
    const formats: Record<string, (body: Buffer) => Buffer> = {
      'image/png': (body) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', Buffer.from('00000001000000010800000000', 'hex')), pngChunk('IDAT', body), pngChunk('IEND', Buffer.alloc(0))]),
      'image/jpeg': jpeg,
      'image/gif': (body) => Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from('01000100000000', 'hex'), Buffer.from('2c000000000100010000', 'hex'), Buffer.from([2, body.length]), body, Buffer.from('003b', 'hex')]),
      'image/webp': (body) => { const chunks = riff('VP8L', Buffer.concat([Buffer.from('2f00000000', 'hex'), body])); return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(chunks.length + 4), Buffer.from('WEBP', 'latin1'), chunks]) },
      'image/bmp': (body) => { const dib = Buffer.concat([u32le(40), u32le(1), u32le(1), Buffer.from('01001800', 'hex'), Buffer.alloc(24)]); return Buffer.concat([Buffer.from('BM', 'latin1'), u32le(14 + dib.length + body.length), u32le(0), u32le(14 + dib.length), dib, body]) },
    }
    // The run sits at a 3-byte boundary so it survives base64 encoding intact.
    const image = (mime: string, filler = 0): Buffer => {
      const build = formats[mime]!
      for (let pad = 0; pad < 3; pad++) {
        const bytes = build(Buffer.concat([Buffer.alloc(pad), Buffer.from(AWS, 'base64'), Buffer.alloc(filler)]))
        if (bytes.toString('base64').includes(AWS)) return bytes
      }
      throw new Error(mime)
    }

    // Only the exempt path sees the 4 MB image: a full scan of it takes seconds on a CI runner.
    const url = dataUri('image/png', image('image/png', 4 * 1024 * 1024))
    const started = performance.now()
    expect(imageUrl(url) === url, '4 MB PNG data URI returned byte-identical').toBe(true)
    expect(performance.now() - started).toBeLessThan(150)
    // MIME and scheme are case-insensitive; the exemption covers every raster type the composer embeds.
    for (const [mime, bytes] of [['IMAGE/PNG', image('image/png')], ['image/jpg', image('image/jpeg')], ...Object.keys(formats).map((m) => [m, image(m)] as const)] as const) {
      const raster = dataUri(mime, bytes)
      expect(redactSensitive(raster) === raster, `${mime} fixture carries the run`).toBe(false)
      expect(imageUrl(raster) === raster, mime).toBe(true)
    }
    // Anything else stays on the fail-closed path: a valid header followed by arbitrary bytes, a truncated or extended
    // image, non-canonical base64, a mismatched or non-raster type, a non-user row.
    const small = image('image/png')
    const header = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1), Buffer.from(AWS, 'base64')])
    for (const other of [dataUri('image/png', header), dataUri('image/png', small.subarray(0, -1)), dataUri('image/png', Buffer.concat([small, Buffer.from(AWS, 'base64')])), `${dataUri('image/png', small)} ${AWS}`, dataUri('image/png', small).replace(/=+$/, ''), dataUri('image/jpeg', small), dataUri('image/svg+xml', small), dataUri('text/plain', small)]) {
      expect(imageUrl(other) === other, other.slice(0, 30)).toBe(false)
    }
    const smallUrl = dataUri('image/png', small)
    expect(imageUrl(smallUrl, 'assistant') === smallUrl, 'assistant row').toBe(false)
    const meta = redactSessionData({ messages: [{ role: 'user', content: 'x', meta: { image_url: { url: smallUrl } } }] }, true)
    expect(JSON.stringify(meta).includes(AWS), 'image-shaped metadata').toBe(false)
  }, 30_000)
})

describe('JPEG trailers in a raster data URI (TAL-1920)', () => {
  type SefEntry = [kind: number, offset: number, size: number]
  const sefBlock = (kind: number, name: string, payload = Buffer.alloc(0), declaredNameLength = name.length): Buffer => Buffer.concat([u16le(0), u16le(kind), u32le(declaredNameLength), Buffer.from(name, 'latin1'), payload])
  /** `SEFH`, version, count, entries, directory length, `SEFT`. */
  const sefDirectory = (entries: SefEntry[], count = entries.length): Buffer => Buffer.concat([
    Buffer.from('SEFH', 'latin1'), u32le(106), u32le(count),
    ...entries.flatMap(([kind, offset, size]) => [u16le(0), u16le(kind), u32le(offset), u32le(size)]),
    u32le(12 + 12 * entries.length), Buffer.from('SEFT', 'latin1'),
  ])
  /** The directory entries that tile `blocks` exactly, each offset counted back from `SEFH`. */
  const tiledEntries = (blocks: [kind: number, block: Buffer][]): SefEntry[] => {
    let offset = blocks.reduce((total, [, block]) => total + block.length, 0)
    return blocks.map(([kind, block]) => { const entry: SefEntry = [kind, offset, block.length]; offset -= block.length; return entry })
  }
  const first = sefBlock(0x0a01, 'Image_UTC_Data', Buffer.from('1700000000000'))
  const second = sefBlock(0x0ba1, 'MotionPhoto_Data', Buffer.from('motion'))
  const blocks: [number, Buffer][] = [[0x0a01, first], [0x0ba1, second]]
  const sef = Buffer.concat([first, second, sefDirectory(tiledEntries(blocks))])

  /** A picture directory (`II*\0` or `MM\0*` TIFF) in APP2, offsets relative to its header, which starts 10 bytes in. */
  const mpf = (scan: Buffer, subPictures: Buffer[], { trailer = Buffer.alloc(0), extraSize = 0, primaryExtra = 0, gap = 0, big = false } = {}): Buffer => {
    const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); if (big) b.writeUInt16BE(n); else b.writeUInt16LE(n); return b }
    const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); if (big) b.writeUInt32BE(n); else b.writeUInt32LE(n); return b }
    const images = 1 + subPictures.length
    const directoryOffset = 8 + 2 + 2 * 12 + 4
    const app2Length = 2 + 4 + directoryOffset + 16 * images
    const picture = jpeg(scan).subarray(2)
    const primarySize = 2 + 2 + app2Length + picture.length
    let relative = primarySize + gap - 10
    const entries = [Buffer.concat([u32(0), u32(primarySize + primaryExtra), u32(0), Buffer.alloc(4)]), ...subPictures.map((sub, index) => {
      const size = sub.length + (index === subPictures.length - 1 ? extraSize : 0)
      const entry = Buffer.concat([u32(0), u32(size), u32(relative), Buffer.alloc(4)])
      relative += sub.length
      return entry
    })]
    const tiff = Buffer.concat([
      Buffer.from(big ? '4d4d002a' : '49492a00', 'hex'), u32(8), u16(2),
      u16(0xb001), u16(4), u32(1), u32(images),
      u16(0xb002), u16(7), u32(16 * images), u32(directoryOffset),
      u32(0), ...entries,
    ])
    const app2Size = Buffer.alloc(2)
    app2Size.writeUInt16BE(app2Length)
    return Buffer.concat([Buffer.from('ffd8ffe2', 'hex'), app2Size, Buffer.from('MPF\0', 'latin1'), tiff, picture, Buffer.alloc(gap), ...subPictures, trailer])
  }

  /** Align the token-shaped run in the scan data so it survives base64 encoding of the whole file. */
  const withRun = (build: (scan: Buffer) => Buffer): Buffer => {
    for (let pad = 0; pad < 3; pad++) {
      const bytes = build(Buffer.concat([Buffer.alloc(pad), Buffer.from(AWS, 'base64')]))
      if (bytes.toString('base64').includes(AWS)) return bytes
    }
    throw new Error('no alignment carries the run')
  }
  const plain = jpeg(Buffer.from([1, 2, 3]))

  it.each<[string, (scan: Buffer) => Buffer]>([
    ['one SEF trailer', (scan) => Buffer.concat([jpeg(scan), sef])],
    ['a little-endian MPF directory with complete sub-pictures', (scan) => mpf(scan, [plain, plain])],
    ['a big-endian MPF directory', (scan) => mpf(scan, [plain], { big: true })],
    ['an MPF directory followed by one SEF trailer', (scan) => mpf(scan, [plain], { trailer: sef })],
  ])('returns a JPEG with %s byte-identical through session redaction', (_name, build) => {
    const url = dataUri('image/jpeg', withRun(build))
    expect(redactSensitive(url) === url, 'the fixture carries the run').toBe(false)
    expect(imageUrl(url) === url).toBe(true)
  })

  it.each<[string, (scan: Buffer) => Buffer]>([
    ['bytes after SEFT', (scan) => Buffer.concat([jpeg(scan), sef, Buffer.from('x')])],
    ['a gap before the first block', (scan) => Buffer.concat([jpeg(scan), Buffer.alloc(4), first, second, sefDirectory(tiledEntries(blocks))])],
    ['a gap between blocks', (scan) => Buffer.concat([jpeg(scan), first, Buffer.alloc(4), second, sefDirectory([[0x0a01, first.length + 4 + second.length, first.length], [0x0ba1, second.length, second.length]])])],
    ['a gap after the last block', (scan) => Buffer.concat([jpeg(scan), first, second, Buffer.alloc(4), sefDirectory([[0x0a01, first.length + second.length + 4, first.length], [0x0ba1, second.length + 4, second.length]])])],
    ['overlapping blocks', (scan) => Buffer.concat([jpeg(scan), first, second, sefDirectory([[0x0a01, first.length + second.length, first.length], [0x0a01, first.length + second.length, first.length + second.length]])])],
    ['a block header disagreeing with its directory entry', (scan) => Buffer.concat([jpeg(scan), first, second, sefDirectory(tiledEntries([[0x0a01, first], [0x0ba2, second]]))])],
    ['a block name outside printable ASCII', (scan) => { const block = sefBlock(1, 'a b'); return Buffer.concat([jpeg(scan), block, sefDirectory(tiledEntries([[1, block]]))]) }],
    ['a directory declaring more entries than it holds', (scan) => Buffer.concat([jpeg(scan), first, second, sefDirectory(tiledEntries(blocks), 3)])],
    ['a directory cut short of its declared length', (scan) => { const directory = sefDirectory(tiledEntries(blocks)); return Buffer.concat([jpeg(scan), first, second, directory.subarray(0, 12 + 12), directory.subarray(-8)]) }],
    ['SEF inside an MPF sub-picture', (scan) => mpf(scan, [Buffer.concat([plain, sef])])],
    ['an MPF primary range that does not end at its end marker', (scan) => mpf(scan, [plain], { primaryExtra: 1 })],
    ['a gap between MPF pictures', (scan) => mpf(scan, [plain], { gap: 4 })],
    ['an MPF range past the end', (scan) => mpf(scan, [plain], { extraSize: 1 })],
    ['an incomplete MPF sub-picture', (scan) => mpf(scan, [plain.subarray(0, -2)])],
    ['bytes after the last MPF range', (scan) => mpf(scan, [plain], { trailer: Buffer.from('x') })],
  ])('keeps a JPEG with %s on the text redaction path', (_name, build) => {
    const url = dataUri('image/jpeg', withRun(build))
    expect(isRasterDataUri(url)).toBe(false)
    expect(imageUrl(url) === url, 'redaction rewrites the run').toBe(false)
  })

  it('proves the SEF directory before reading any block name, so a malformed trailer costs linear time', () => {
    const size = 1024 * 1024
    const huge = sefBlock(1, 'n'.repeat(size))
    const nameBytesRead = (trailer: Buffer): number => {
      const toString = vi.spyOn(Buffer.prototype, 'toString')
      try {
        isRasterDataUri(dataUri('image/jpeg', Buffer.concat([plain, trailer])))
        return (toString.mock.calls as unknown as [encoding?: string, start?: number, end?: number][]).reduce((total, [encoding, start = 0, end = 0]) => total + (encoding === 'latin1' ? end - start : 0), 0)
      } finally {
        toString.mockRestore()
      }
    }
    expect(nameBytesRead(Buffer.concat([huge, sefDirectory(tiledEntries([[1, huge]]))])), 'a well-formed trailer reads its name once').toBe(size)
    const repeated = Array.from({ length: 64 }, (): SefEntry => [1, huge.length, huge.length])
    expect(nameBytesRead(Buffer.concat([huge, sefDirectory(repeated)])), 'entries overlapping one block read no name').toBe(0)
    const oversized = sefBlock(1, 'n', Buffer.alloc(0), size)
    expect(nameBytesRead(Buffer.concat([oversized, sefDirectory(tiledEntries([[1, oversized]]))])), 'a name longer than its block is not read').toBe(0)
  })
})

/**
 * Parity with the Agent's `redact_sensitive_text(text, force=True)` (Agent fef0bc56, its test vectors): each input with
 * the Agent's own output. Session detail and frames go through `redactText`'s prefilter; public shares always redact.
 */
/** A synthetic token from its prefix and body, so no token literal sits in the source; masked to its first 6 and last 4. */
const gitlab = ([prefix, body]: [string, string]): [string, string] => {
  const token = prefix + body
  return [token, `${token.slice(0, 6)}...${token.slice(-4)}`]
}
const CONTEXT7_KEY = `ctx7sk-${'0'.repeat(8)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(12)}`
/** The shape `secrets.token_urlsafe(32)` prints: 43 characters. */
const WEBAPP_CREDENTIAL = `Zq7_${'k3Lm'.repeat(9)}x9-`
const AGENT_PARITY: Record<string, [string, string][]> = {
  'v0.23 glued credential names': [
    ['PGPASSWORD=s3cretpw psql -h db', 'PGPASSWORD=*** psql -h db'],
    ['MYSQL_PWD=s3cretpw mysql', 'MYSQL_PWD=*** mysql'],
    ['SSHPASS=s3cretpw sshpass -e host', 'SSHPASS=*** sshpass -e host'],
    ['pgpassword="two words" next', 'pgpassword="***" next'],
    ['PWD=/home/app', 'PWD=/home/app'],
    ['PGPASSFILE=', 'PGPASSFILE='],
    ['PGPASSFILE=/home/app/.pgpass', 'PGPASSFILE=/home/app/.pgpass'],
    ['passwordless: true', 'passwordless: true'],
  ],
  'v0.23 strong credential name casing': [
    ['DBPASSWORD=s3cretpw', 'DBPASSWORD=***'],
    ['ROOTPASSWD=s3cretpw', 'ROOTPASSWD=***'],
    ['SECRETKEY=s3cretpw', 'SECRETKEY=***'],
    ['MYSECRETKEY=s3cretpw', 'MYSECRETKEY=***'],
  ],
  'v0.23 qualified and affixed keys': [
    ...['signing_key', 'encryption_key', 'encryptKey', 'master_key', 'hmac_key', 'symmetric_key', 'client-key-data', 'AccountKey', 'SharedAccessKey', 'dbpassword', 'rootpasswd', 'mySigningKey', 'my_api_key_value', 'secret_value', 'MY_API_KEY_B64', 'MYSECRETKEY'].map((key): [string, string] => [`{"${key}":"s3cretpw"}`, `{"${key}":"***"}`]),
  ],
  'v0.23 connection strings preserve shell value boundaries': [
    [String.raw`host=db; password="two\" secret words"; database=x`, 'host=db; password=***; database=x'],
    [String.raw`host=db; password='two words'\ and\ more; database=x`, 'host=db; password=***; database=x'],
    [String.raw`host=db; password=two\;secret; database=x`, 'host=db; password=***; database=x'],
    [String.raw`host=db; PWD="two\" secret words"; database=x`, 'host=db; PWD=***; database=x'],
  ],
  'v0.23 multiline connection strings': [
    ["host=db; password=$(printf 'two\nsecret words'); database=x", 'host=db; password=***'],
    ['host=db; PWD="two\nsecret words"; database=x', 'host=db; PWD="***"; database=x'],
    ["host=db; PWD=$(printf 'two\nsecret words'); database=x", 'host=db; PWD=***'],
  ],
  'v0.23 escaped Basic pairs': [
    [String.raw`proxy_password=user:hello\ world`, 'proxy_password=***'],
    [String.raw`MY_PROXY_BASIC=user:hello\ world`, 'MY_PROXY_BASIC=user:***'],
    [String.raw`MY_PROXY_BASIC="user:hello\" secret"`, 'MY_PROXY_BASIC="user:***"'],
    [String.raw`proxy_password="user:hello\" secret"`, 'proxy_password=***'],
    [String.raw`MY_PROXY_BASIC=user:hello\;secret`, 'MY_PROXY_BASIC=user:***'],
  ],
  'v0.23 connection strings': [
    ['Driver=ODBC;PWD={s3;cr}}et};Server=db', 'Driver=ODBC;PWD={***};Server=db'],
    ['Host=db;Password="two;words";Database=x', 'Host=db;Password="***";Database=x'],
    ["host=db password='two words' dbname=x", "host=db password='***' dbname=x"],
    ['host=db password=two\\ words dbname=x', 'host=db password=*** dbname=x'],
    ['AccountKey=s3cretpw;Endpoint=x', 'AccountKey=***;Endpoint=x'],
    ['SharedAccessKey=s3cretpw;Endpoint=x', 'SharedAccessKey=***;Endpoint=x'],
    ['https://x.test/?AccountKey=s3cretpw&x=1', 'https://x.test/?AccountKey=***&x=1'],
    ['https://x.test/?sv=1&sig=s3cretpw&x=1', 'https://x.test/?sv=1&sig=***&x=1'],
    ['SharedAccessSignature=sv=1&sig=s3cretpw;Endpoint=x', 'SharedAccessSignature=***;Endpoint=x'],
    ['https://x.test/?SharedAccessSignature=sv=1&sig=s3cretpw&foo=bar', 'https://x.test/?SharedAccessSignature=***&foo=bar'],
    ['Server=db;PWD=\"two\"\"words\";Database=x', 'Server=db;PWD=\"***\";Database=x'],
    ['Server=db;PWD={unterminated', 'Server=db;PWD={***'],
    ['Host=db;pwd = {s3;cr};Database=x', 'Host=db;pwd = {***};Database=x'],
  ],
  'v0.23 raw shell URL readings': [
    [String.raw`curl 'https://abcde\x40s3cretpw@github.com'`, "curl '***'"],
    [String.raw`curl 'https://abcde\u0040s3cretpw@github.com'`, "curl '***'"],
    [String.raw`curl 'https://abcde\x2fs3cretpw@github.com'`, "curl '***'"],
    [String.raw`curl "https://abcde\x40s3cretpw@github.com"`, 'curl "***"'],
    [String.raw`{'command': 'curl https://abcde\\x40s3cretpw@github.com'}`, "{'command': 'curl https://***@github.com'}"],
    [String.raw`curl 'https://example.com/search?q=abcde\x40value&mail=user@example.com'`, String.raw`curl 'https://example.com/search?q=abcde\x40value&mail=user@example.com'`],
    [String.raw`echo '{"@context":"https://schema.org","@type":"\u0041"}'`, String.raw`echo '{"@context":"https://schema.org","@type":"\u0041"}'`],
  ],
  'v0.23 credential arguments before inner rewrites': [
    [`sh -c 'curl --pass'word' "https://"TOKEN123456789"@github.com secret words"'`, "sh -c 'curl --pass'word' ***'"],
    [JSON.stringify({ command: 'curl --password "https://"TOKEN123456789"@github.com secret words"' }), JSON.stringify({ command: 'curl --password ***' })],
    [JSON.stringify({ command: 'curl -u "https://"TOKEN123456789"@github.com secret words"' }), JSON.stringify({ command: 'curl -u "https:***"' })],
    [JSON.stringify({ command: 'docker login -p "https://"TOKEN123456789"@github.com secret words"' }), JSON.stringify({ command: 'docker login -p ***' })],
    ['SharedAccessSignature=${VALUE:-hello world} next', 'SharedAccessSignature=*** next'],
    ['SharedAccessSignature=$(printf hello world) next', 'SharedAccessSignature=***'],
    [JSON.stringify({ password: 'two" secret words' }), JSON.stringify({ password: '***' })],
    ['curl --password "https://"TOKEN123456789"@github.com secret words"', 'curl --password ***'],
    ['curl -u "https://"TOKEN123456789"@github.com secret words"', 'curl -u "https:***"'],
    ['docker login -p "https://"TOKEN123456789"@github.com secret words"', 'docker login -p ***'],
    [String.raw`SharedAccessSignature=hello\ world`, 'SharedAccessSignature=***'],
    [String.raw`SharedAccessSignature=sv=1\&sig=hello\ world`, 'SharedAccessSignature=***'],
    ['SSHPASS="https://"TOKEN123456789"@github.com secret words"', 'SSHPASS=***'],
    ['AccountKey=-----BEGIN PRIVATE KEY-----\nsynthetic-private-42\n-----END PRIVATE KEY-----', 'AccountKey=***'],
    [JSON.stringify({ password: 'https://"TOKEN123456789"@github.com secret words' }), JSON.stringify({ password: '***' })],
  ],
  'v0.23 multiline shell groups': [
    ["{ echo ok\ncurl --'password' 's3cretpw'\n}", '{ echo ok\ncurl --password ***\n}'],
    ["( echo ok\ncurl --'password' 's3cretpw'\n)", '( echo ok\ncurl --password ***\n)'],
    ['{ echo ok\ncurl https://cor"recthorse42"@github.com\n}', '{ echo ok\ncurl https://***@github.com\n}'],
  ],
  'v0.23 standalone and shell-quoted serializations': [
    [JSON.stringify('curl https://"correcthorse42"@github.com'), JSON.stringify('curl https://***@github.com')],
    [`echo '${JSON.stringify({ command: 'curl https://"correcthorse42"@github.com' })}'`, "echo '***'"],
    [`echo ${JSON.stringify(JSON.stringify({ command: 'curl https://"correcthorse42"@github.com' }))}`, `echo ${JSON.stringify(JSON.stringify({ command: 'curl https://***@github.com' }))}`],
    [`don't log ${JSON.stringify({ command: 'curl https://"correcthorse42"@github.com' })}`, `don't log ${JSON.stringify({ command: 'curl https://***@github.com' })}`],
    [`'curl https://"correcthorse42"@github.com'`, "'curl https://***@github.com'"],
    [`echo '{"@context":"https://schema.org","@type":"X"}'`, `echo '{"@context":"https://schema.org","@type":"X"}'`],
  ],
  'v0.23 Python-repr URL credentials': [
    [String.raw`{'command': 'curl https://"\cA\cB\cC"@github.com'}`, `{'command': 'curl https://***@github.com'}`],
    [`{'command': 'curl https://"correcthorse42"@github.com'}`, `{'command': 'curl https://***@github.com'}`],
    [String.raw`{'command': 'curl https://\'correcthorse42\'@github.com "note"'}`, `{'command': 'curl https://***@github.com "note"'}`],
    [String.raw`{'command': 'echo \'note\'; curl https://"correcthorse42"@github.com'}`, String.raw`{'command': 'echo \'note\'; curl https://***@github.com'}`],
    [String.raw`{'command': 'echo note\n curl https://"correcthorse42"@github.com'}`, String.raw`{'command': 'echo note\n curl https://***@github.com'}`],
    [`{'payload': {'command': 'curl https://"correcthorse42"@github.com'}}`, `{'payload': {'command': 'curl https://***@github.com'}}`],
    [`{'command': 'curl https://example.com/search?q=user@example.com'}`, `{'command': 'curl https://example.com/search?q=user@example.com'}`],
  ],
  'v0.23 serialized shell URL credentials': [
    [`sh -c 'curl https://"correcthorse42"@github.com'""`, 'sh -c curl https://***@github.com'],
    [`sh -c ""'curl https://"correcthorse42"@github.com'`, 'sh -c curl https://***@github.com'],
    ...['>out', '<in'].map((redirect): [string, string] => [`sh -c 'curl https://"correcthorse42"@github.com'${redirect}`, `sh -c 'curl https://***@github.com'${redirect}`]),
    [`sh -c $'curl https://"correcthorse42"@github.com'`, "sh -c $'curl https://***@github.com'"],
    [String.raw`{"command":"curl https://\"correcthorse42\"@github.com...`, String.raw`{"command":"curl https://***@github.com...`],
    [JSON.stringify({ command: "curl https://'correcthorse42'@github.com" }), JSON.stringify({ command: 'curl https://***@github.com' })],
    [JSON.stringify({ command: 'curl https://"correcthorse42"@github.com' }), JSON.stringify({ command: 'curl https://***@github.com' })],
    [JSON.stringify({ command: "curl https://cor'recthorse'42@github.com" }), JSON.stringify({ command: 'curl https://***@github.com' })],
    [JSON.stringify({ output: JSON.stringify({ command: "curl https://'correcthorse42'@github.com" }) }), JSON.stringify({ output: JSON.stringify({ command: 'curl https://***@github.com' }) })],
    [`INFO: ${JSON.stringify({ command: "curl https://'correcthorse42'@github.com" })}`, `INFO: ${JSON.stringify({ command: 'curl https://***@github.com' })}`],
    [JSON.stringify({ command: 'curl https://example.com/search?q=user@example.com' }), JSON.stringify({ command: 'curl https://example.com/search?q=user@example.com' })],
  ],
  'v0.23 private key formats': [
    ['-----BEGIN PGP PRIVATE KEY BLOCK-----\nsynthetic\n-----END PGP PRIVATE KEY BLOCK-----', '[REDACTED PRIVATE KEY]'],
    [`AGE-SECRET-KEY-1${'A'.repeat(58)}`, '[REDACTED PRIVATE KEY]'],
    [Buffer.from('-----BEGIN PRIVATE KEY-----\nsynthetic-key-material\n-----END PRIVATE KEY-----').toString('base64'), '[REDACTED PRIVATE KEY]'],
    ['Private-Lines: 1\nQUJDREVGR0hJSktMTU5PUA==\nPrivate-MAC: abc', 'Private-Lines: 1\n[REDACTED PRIVATE KEY]\nPrivate-MAC: abc'],
    ['Private-Lines: 1\\r\\n  4|QUJDREVGR0hJSktMTU5PUA==\\r\\nPrivate-MAC: abc', 'Private-Lines: 1\\r\\n[REDACTED PRIVATE KEY]\\r\\nPrivate-MAC: abc'],
    [Buffer.from('-----BEGIN CERTIFICATE-----\nsynthetic-public-certificate\n-----END CERTIFICATE-----').toString('base64'), Buffer.from('-----BEGIN CERTIFICATE-----\nsynthetic-public-certificate\n-----END CERTIFICATE-----').toString('base64')],
  ],
  'v0.23 separator-glued tokens and network paths': [
    [`backup-sk-${'A'.repeat(20)}`, 'backup-sk-AAA...AAAA'],
    ['backup-sk-learn.txt', 'backup-sk-learn.txt'],
    ['mount -t cifs //user:pw@host/share', 'mount -t cifs //user:***@host/share'],
    ['MY_PROXY_BASIC=user:s3cretpw', 'MY_PROXY_BASIC=user:***'],
    ['MY_LOGIN=user:pw', 'MY_LOGIN=user:***'],
    ['MY_AUTH=user:pw', 'MY_AUTH=***'],
    ['BASIC_AUTH=user:pw', 'BASIC_AUTH=***'],
    ['MY_PROXY_BASIC="user:twoWords42"', 'MY_PROXY_BASIC="user:***"'],
    ['IMAGE=redis:7-alpine', 'IMAGE=redis:7-alpine'],
    ['{"@context":"https://schema.org","@type":"X"}', '{"@context":"https://schema.org","@type":"X"}'],
    ['https://TOKEN@github.com', 'https://***@github.com'],
    ['https://abcdef***@github.com', 'https://***@github.com'],
  ],
  'env names ending in _KEY, _PASS or _PW': [
    ['OPENAI_KEY=xyzzyplugh1234567890abcd', 'OPENAI_KEY=xyzzyp...abcd'],
    ['MYSQL_PASS=ghi789', 'MYSQL_PASS=***'],
    ['DB_PW=jkl012', 'DB_PW=***'],
    ['openai_key=xyzzyplugh1234567890abcd', 'openai_key=xyzzyp...abcd'],
    ['db_pass=hunter2', 'db_pass=***'],
    ['redis_pw=hunter3', 'redis_pw=***'],
    ['KEYBOARD=notsecret', 'KEYBOARD=notsecret'],
    ['PASSAGE=notsecret', 'PASSAGE=notsecret'],
    ['SORT_KEY=name', 'SORT_KEY=name'],
  ],
  'all-caps env names, by whole keyword and value shape': [
    ['AUTHOR_KEY=name', 'AUTHOR_KEY=name'],
    ['MAX_TOKENS=100', 'MAX_TOKENS=100'],
    ['GITHUB_TOKEN=abc', 'GITHUB_TOKEN=abc'],
    ['MYTOKEN=abc123def456ghi', 'MYTOKEN=abc123def456ghi'],
    ['TOKENIZER=cl100k', 'TOKENIZER=cl100k'],
    ['SECRETARY=bob', 'SECRETARY=bob'],
    ['AUTH_TOKEN=abc', 'AUTH_TOKEN=***'],
    ['DB_PASSWORD=x', 'DB_PASSWORD=***'],
    ['CLIENT_SECRET=short', 'CLIENT_SECRET=***'],
    ['API_KEY=abc', 'API_KEY=***'],
    ['PASSWORD_POLICY=strict', 'PASSWORD_POLICY=***'],
    ['MY_CREDENTIAL=abc', 'MY_CREDENTIAL=***'],
  ],
  'Telegram bot tokens and phone numbers': [
    ['bot123456789:ABCDEfghij-KLMNopqrst_UVWXyz12345', 'bot123456789:***'],
    ['12345678901:ABCDEfghijKLMNopqrstUVWXyz1234567890', '12345678901:***'],
    ['call +15551234567 now', 'call +155****4567 now'],
    ['sms +4479460 ok', 'sms +4****60 ok'],
  ],
  'vendor prefixes': [
    ['key xai-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstu', 'key xai-AB...rstu'],
    ['ntn_AbCdEfGhIjKlMnOpQrSt012', 'ntn_Ab...t012'],
    [`fw-${'A'.repeat(40)}`, 'fw-AAA...AAAA'],
    [`fw_${'B'.repeat(40)}`, 'fw_BBB...BBBB'],
    [`fpk_${'C'.repeat(40)}`, 'fpk_CC...CCCC'],
    ['pk-lf-abcdef12-3456', 'pk-lf-...3456'],
    ['xapp-1-A0123456789-abcdefghijklmnop', 'xapp-1...mnop'],
    ['fw-tooshort xai-tooshort glpat-short', 'fw-tooshort xai-tooshort glpat-short'],
  ],
  'Context7 keys': [
    [`key is ${CONTEXT7_KEY}`, 'key is ctx7sk...0000'],
    [`["${CONTEXT7_KEY}"]`, '["ctx7sk...0000"]'],
    ['the glossary explains context7 keys', 'the glossary explains context7 keys'],
    ['ctx7sk-short', 'ctx7sk-short'],
    [`myctx7sk-${'A'.repeat(20)}`, `myctx7sk-${'A'.repeat(20)}`],
  ],
  'Hermes Webapp sign-in links': [
    [`Open this link in your browser:\n  http://127.0.0.1:9120/?profile=work#hermes-session=${WEBAPP_CREDENTIAL}`, 'Open this link in your browser:\n  http://127.0.0.1:9120/?profile=work#hermes-session=***'],
    [`http://127.0.0.1:9120/webapp/launch#ticket=${WEBAPP_CREDENTIAL}&query=%3Fprofile%3Dwork`, 'http://127.0.0.1:9120/webapp/launch#ticket=***&query=%3Fprofile%3Dwork'],
    // No URL scheme or other marker: the prefilter has to pass these on the credential's own name.
    [`hermes-session=${WEBAPP_CREDENTIAL}`, 'hermes-session=***'],
    [`/webapp/launch#query=%3Fprofile&ticket=${WEBAPP_CREDENTIAL}`, '/webapp/launch#query=%3Fprofile&ticket=***'],
    // The 20-character floor leaves placeholders and code that builds such a link.
    [`hermes-session=${'a'.repeat(20)}`, 'hermes-session=***'],
    [`hermes-session=${'a'.repeat(19)}`, `hermes-session=${'a'.repeat(19)}`],
    [`/webapp/launch#ticket=${'a'.repeat(19)}`, `/webapp/launch#ticket=${'a'.repeat(19)}`],
    ["target.hash = `hermes-session=${token}`\nconst FRAGMENT_KEY = 'hermes-session'", "target.hash = `hermes-session=${token}`\nconst FRAGMENT_KEY = 'hermes-session'"],
    [`xhermes-session=${WEBAPP_CREDENTIAL}`, `xhermes-session=${WEBAPP_CREDENTIAL}`],
  ],
  'GitLab tokens': ([
    ['glpat-', 'Zx9AbCdEfGhIjKlMnOpQ'], ['gloas-', 'a'.repeat(64)], ['gldt-', 'AbCdEfGhIjKlMnOpQrSt'], ['glrt-', 't1_AbCdEfGhIjKlMnOpQrSt'],
    ['glrt-', `${'A'.repeat(27)}.01.${'a'.repeat(9)}`], ['glrtr-', `${'B'.repeat(27)}.01.${'b'.repeat(9)}`], ['glcbt-', 'a1B2_AbCdEfGhIjKlMnOpQ'],
    ['glptt-', 'c'.repeat(40)], ['glft-', 'AbCdEfGhIjKlMnOp'], ['glimt-', 'AbCdEfGhIjKlMnOpQrStUvWxY'], ['glagent-', 'd'.repeat(50)],
    ['glsoat-', 'AbCdEfGhIjKlMnOpQrSt'], ['glffct-', 'AbCdEfGhIjKlMnOpQrSt'], ['glwt-', 'AbCdEfGhIjKlMnOpQrSt'], ['GR1348941', 'E'.repeat(20)],
  ] as [string, string][]).map(gitlab),
  'bare-token URL userinfo': [
    ['git remote set-url origin https://MYPASSWORDWASDISLAYEDHERE@github.com/unclehowell/FCUK.git', 'git remote set-url origin https://MYPASS...HERE@github.com/unclehowell/FCUK.git'],
    ['ssh://longtoken1234567@gitlab.com/project.git', 'ssh://***@gitlab.com/project.git'],
    ['ftp://ftptoken123456@ftp.example.com/files', 'ftp://***@ftp.example.com/files'],
    ['https://git@github.com/user/repo.git', 'https://git@github.com/user/repo.git'],
    ['https://example.com/search?q=user@example.com', 'https://example.com/search?q=user@example.com'],
  ],
  'header-only and two-part JWTs': [
    ['token eyJhbGciOiJIUzI1NiJ9 end', 'token eyJhbG...NiJ9 end'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'eyJhbG...wIn0'],
  ],
  'tokens split by control or zero-width characters': [
    ['ghp_abcdef\n1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
    ['ghp_abcdef\x1b1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
    ['ghp_abcdef​1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
    [`sk-${'a'.repeat(15)}\x1b${'b'.repeat(25)}`, 'sk-aaa...bbbb'],
    [`copied ghp_${'F'.repeat(29)}\nbutton [ref=e3]: Copy`, 'copied ghp_FF...FFFF\nbutton [ref=e3]: Copy'],
  ],
}

describe('Agent redactor parity', () => {
  it.each(['complete', 'truncated'])('v0.23 masks Python-repr non-string snapshots when %s', (shape) => {
    const host = shape === 'complete' ? 'github.com' : 'h'.repeat(200)
    const frame = publicToolFrame({ name: 'search', args: { query: { command: `curl https://"correcthorse42"@${host}` } } }, true)
    expect(frame.args).toEqual({ query: { command: `curl https://***@${host}` } })
    expect(frame.target).toContain('curl https://***@')
    expect(frame.target).not.toContain('correcthorse42')
  })
  it.each(['signing_key', 'encryption_key', 'master_key', 'hmac_key', 'PGPASSWORD', 'MYSQL_PWD', 'SSHPASS', 'AccountKey', 'dbpassword', 'MYSECRETKEY'])('masks object credential %s in live and persisted tool arguments', (key) => {
    const call = { name: 'terminal', args: { [key]: 's3cretpw', passwordless: true } }
    expect(publicToolFrame(call, true).args).toEqual({ [key]: '***', passwordless: true })
    const row = redactSessionData({ messages: [{ role: 'assistant', tool_calls: [call] }] }, true)
    expect(JSON.parse(JSON.stringify(row)) as unknown).toMatchObject({ messages: [{ tool_calls: [{ args: { [key]: '***', passwordless: true } }] }] })
  })
  for (const [family, cases] of Object.entries(AGENT_PARITY)) {
    it.each(cases)(`masks ${family}: %j`, (input, expected) => {
      expect(redactText(input, true)).toBe(expected)
      expect(sanitizeShareMessage({ role: 'assistant', content: input }, [], [], '/nonexistent-home')?.content).toBe(expected)
      if (family.startsWith('v0.23')) {
        const frame = publicToolFrame({ name: 'terminal', args: { command: input } }, true)
        expect(frame.args).toEqual({ command: expected })
        expect(frame.target).toBe(expected.trim().split('\n')[0]!.replace(/\s+/g, ' ').trim().slice(0, 120))
        const row = redactSessionData({ messages: [{ role: 'assistant', content: input }] }, true)
        expect(JSON.parse(JSON.stringify(row)) as unknown).toMatchObject({ messages: [{ content: expected }] })
      }
    })
  }
  it('masks a lowercase env name beside a URL, and a prefix split by a control character, through the prefilter', () => {
    expect(redactText('db_pass=hunter2\nsee https://example.com', true)).toBe('db_pass=***\nsee https://example.com')
    expect(redactText(`x\u200bai-${'A'.repeat(40)}`, true)).toBe('xai-AA...AAAA')
    expect(redactText(`gh\x1bp_${'B'.repeat(36)}`, true)).toBe('ghp_BB...BBBB')
  })

  it('masks a whole quoted env value, and a split token whose next line is an assignment', () => {
    expect(redactText('DB_PASS="correct horse battery staple" next', true)).toBe('DB_PASS="***" next')
    expect(redactText(`db_pass='two words' x`, true)).toBe(`db_pass='***' x`)
    expect(redactText('DB_PW="unterminated pass phrase', true)).toBe('DB_PW=***')
    expect(redactText('ghp_abcdef\n1234567890ABCDEF1234567890abcdef\nSECOND=ok', true)).toBe('ghp_ab...cdef\nSECOND=ok')
    expect(redactText('ghp_abcdef\n1234567890ABCDEF1234567890abcdef\nSECOND = ok', true)).toBe('ghp_ab...cdef\nSECOND = ok')
  })

  it('masks a whole escaped or ANSI-C env value, and a punctuation-only password', () => {
    expect(redactText('db_pass=correct\\ horse\\ battery next', true)).toBe('db_pass=*** next')
    expect(redactText(`DB_PW=$'correct horse\\x21' next`, true)).toBe(`DB_PW=$'***' next`)
    expect(redactText(`db_pass='!@#$%^&*' next`, true)).toBe(`db_pass='***' next`)
    expect(redactText('MYSQL_PASS=!@#% next', true)).toBe('MYSQL_PASS=*** next')
    expect(redactText('openai_key=xyzzy\\ plugh1234567890abcd next', true)).toBe('openai_key=*** next')
  })

  it('masks a split token after a line of text, and leaves an @ in a root URL query or fragment', () => {
    expect(redactText('note\nghp_abcdef\n1234567890ABCDEF1234567890abcdef', true)).toBe('note\nghp_ab...cdef')
    expect(redactText('note\u200bghp_abcdef\u200b1234567890ABCDEF1234567890abcdef', true)).toBe('note\u200bghp_ab...cdef')
    expect(redactText('xghp_abcdef\n1234567890ABCDEF1234567890abcdef', true)).toBe('xghp_abcdef\n1234567890ABCDEF1234567890abcdef')
    for (const url of ['https://example.com?q=user@example.com', 'https://example.com#contact=someone@example.com'])
      expect(redactText(url, true)).toBe(url)
  })

  it('masks a split token after a whole one, and stops a URL query value at its fragment', () => {
    expect(redactText('sk-aaaaaaaaaa\nsk-bbbbb\nbbbbbbbbbb', true)).toBe('***\nsk-bbb...bbbb')
    expect(redactText(`ghp_${'a'.repeat(36)}\nghp_abcdef\n1234567890ABCDEF1234567890abcdef`, true)).toBe('ghp_aa...aaaa\nghp_ab...cdef')
    expect(redactText('https://x.test/?db_pass=hunter2#long-fragment-name', true)).toBe('https://x.test/?db_pass=***#long-fragment-name')
    expect(redactText('https://x.test/?a=1&db_pass=hunter2&b=2', true)).toBe('https://x.test/?a=1&db_pass=***&b=2')
  })

  it('masks a split token before a line it cannot join, and keeps env names that only contain a strong word', () => {
    expect(redactText('ghp_abcdef\n1234567890ABCDEF1234567890abcdef\nfoo-bar', true)).toBe('ghp_ab...cdef\nfoo-bar')
    expect(redactText('ghp_abcdef\x1b1234567890ABCDEF1234567890abcdef\x1b-x', true)).toBe('ghp_ab...cdef\x1b-x')
    for (const text of ['author_key=name', 'COMPASS_KEY=north', 'PASSAGE_KEY=title', 'compass_key=north']) expect(redactText(text, true)).toBe(text)
    expect(redactText('DB_PASS=north', true)).toBe('DB_PASS=***')
  })

  it('masks a token split by an ANSI escape sequence, and keeps the sequences around a whole one', () => {
    for (const [input, expected] of [
      ['ghp_abcdef\x1b[31m1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      // The single-code-point C1 forms of CSI and OSC.
      ['ghp_abcdef\x9b31m1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['ghp_abcdef\x9d8;;https://x.test\x9c1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      // The other ECMA-48 families: character-set selection, single-character escapes, and DCS, SOS, PM and APC strings.
      ['gh\x1b(Bp_abcdef1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['ghp_abcdef\x1b7123456\x1b=7890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['ghp_abcdef\x1bP1;2|x\x1b\\123456\x1b_app\x1b\\7890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['ghp_abcdef\x1bXsos\x1b\\123456\x1b^pm\x1b\\7890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['ghp_abcdef\x90dcs\x9c123456\x9fapc\x9c7890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['gh\x85p_abcdef1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      // Only OSC ends at BEL; the other strings run to ST.
      ['ghp_ab\x1bPx\x07.\x1b\\cdef1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      // A C0 control inside a sequence runs without ending it; CAN or SUB cancels it, and ESC or a C1 control interrupts it.
      ['ghp_abcdef\x1b[31\x07m1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      // A parameter after an intermediate makes a terminal ignore the CSI through its final byte.
      ['ghp_abcdef\x1b[1 2m1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['ghp_abcdef\x1b\x07(B123456\x1b(\nB7890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['ghp_abcdef\x1b[31\x18123456\x1b]0;t\x1a7890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['ghp_abcdef\x1b[31\x1b[0m123456\x1b]0;t\x9b1m7890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['ghp_abcdef\x84123456\x8f7890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      // The piece before the sequence is a whole token by itself.
      ['ghp_abcdefghij\x1b[31m1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['ghp_abcdef\x1b[1;38;5;196m1234567890ABCDEF1234567890abcdef\x1b[0m done', 'ghp_ab...cdef\x1b[0m done'],
      ['ghp_abcdef\x1b]8;;https://x.test\x07123456\x1b]8;;\x1b\\7890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['gh\x1b[1mp_abcdef1234567890ABCDEF1234567890abcdef', 'ghp_ab...cdef'],
      ['ghp_abcdef1234567890ABCDEF1234567890abcdef\x1b[0m\nnext', 'ghp_ab...cdef\x1b[0m\nnext'],
      ['\x1b[32mghp_abcdef1234567890ABCDEF1234567890abcdef\x1b[0m', '\x1b[32mghp_ab...cdef\x1b[0m'],
      // A token inside an OSC payload (a terminal title) is masked there, whole or split by a control character.
      ['\x1b]0;ghp_abcdef1234567890ABCDEF1234567890abcdef\x07', '\x1b]0;ghp_ab...cdef\x07'],
      ['\x1b]0;ghp_abcdef\x011234567890ABCDEF1234567890abcdef\x07', '\x1b]0;ghp_ab...cdef\x07'],
      // A payload token split by another sequence or string, and a token whose rest is a hidden payload.
      ['\x1b]0;ghp_abcdef\x1b[31m1234567890ABCDEF1234567890abcdef\x07', '\x1b]0;ghp_ab...cdef\x07'],
      ['\x1b]0;ghp_abcdef\x1b]0;junk\x071234567890ABCDEF1234567890abcdef\x07', '\x1b]0;ghp_ab...cdef\x07'],
      ['\x1b]0;ghp_abcdef\x1b]0;junk_name\x071234567890ABCDEF1234567890abcdef\x07', '\x1b]0;ghp_ab...cdef\x07'],
      // A prefix-like name in a hyperlink is no hidden token: an OSC's command number is not its payload.
      ['\x1b]8;;file:///tmp/ghp_tools\x1b\\ghp_tools\x1b]8;;\x1b\\', '\x1b]8;;file:///tmp/ghp_tools\x1b\\ghp_tools\x1b]8;;\x1b\\'],
      ['\x1b]0;ghp_abc\x07\x1b]0;junk\x07\x1b_def1234567890ABCDEF1234567890abcdef\x1b\\', '\x1b]0;ghp_ab...cdef\x1b\\'],
      ['ghp_abcdefghij\x1b_1234567890ABCDEF1234567890abcdef\x1b\\', 'ghp_ab...cdef\x1b\\'],
      // A prefix split across string payloads, with junk payloads between its pieces, is in no view: the run is masked whole.
      ['g\x1b]0;x\x07h\x1b]0;p_\x07abcdef1234567890ABCDEF1234567890abcdef', 'gxhp_a...cdef'],
      ['\x1b]0;t;g\x07\x1b]0;x\x07hp_abcdef1234567890ABCDEF1234567890abcdef', '\x1b]0;t;gxhp_a...cdef'],
      // A prefix with punctuation (`SG.`) split across payloads, and its body after the dot.
      ['S\x1b]0;x\x07\x1b]0;G\x07.abcdefghij1234567890', 'SxG.ab...7890'],
      // An equals sign inside a `gAAAA` body continues the run.
      ['g\x1b]0;x\x07AA\x1b]0;AA\x07=abcdefghijklmnopqrst', 'gxAAAA...qrst'],
      // A period is a credential boundary, on the display and inside a payload's trailing run.
      ['foo.g\x1b]0;x\x07h\x1b]0;p_\x07abcdef1234567890ABCDEF1234567890abcdef', 'foo.gxhp_a...cdef'],
      ['\x1b]0;x.g\x07\x1b]0;y\x07hp_abcdef1234567890ABCDEF1234567890abcdef', '\x1b]0;x.gyhp_a...cdef'],
      // A hyperlinked name with no prefix across payloads is no hidden token.
      ['\x1b]8;;file:///tmp/notes\x1b\\notes\x1b]8;;\x1b\\', '\x1b]8;;file:///tmp/notes\x1b\\notes\x1b]8;;\x1b\\'],
      // A JWT split by a sequence, in its prefix or body, or across string payloads; `-` is a JWT boundary, a word character is not.
      ['ey\x1b[1mJhbGciOiJIUzI1NiJ9abcdef', 'eyJhbG...cdef'],
      ['eyJhbGci\x1b[1mOiJIUzI1NiJ9abcdef', 'eyJhbG...cdef'],
      ['eyJhb\x1b]0;x\x07GciOiJIUzI1NiJ9abcdef', 'eyJhbx...cdef'],
      ['e\x1b]0;x\x07y\x1b]0;z\x07\x1b]0;J\x07abcdefghij1234567890', 'exyzJa...7890'],
      ['-e\x1b]0;x\x07y\x1b]0;J\x07abcdefghij1234567890', '-exyJab...7890'],
      ['te\x1b]0;x\x07y\x1b]0;J\x07abcdefghij1234567890', 'te\x1b]0;x\x07y\x1b]0;J\x07abcdefghij1234567890'],
      ['a-g\x1b]0;x\x07h\x1b]0;p_\x07abcdef1234567890ABCDEF1234567890abcdef', 'a-g\x1b]0;x\x07h\x1b]0;p_\x07abcdef1234567890ABCDEF1234567890abcdef'],
      ['theyJump', 'theyJump'],
    ]) {
      expect(redactText(input, true)).toBe(expected)
      expect(sanitizeShareMessage({ role: 'assistant', content: input }, [], [], '/nonexistent-home')?.content).toBe(expected)
    }
  })

  it('does not skip a prefix split across string payloads', () => {
    expect(mightContainSensitiveText('g\x1b]0;x\x07h\x1b]0;p_\x07abcdef1234567890ABCDEF1234567890abcdef')).toBe(true)
    expect(mightContainSensitiveText('S\x1b]0;x\x07\x1b]0;G\x07.abcdefghij')).toBe(true)
    expect(mightContainSensitiveText('foo.g\x1b]0;x\x07h\x1b]0;p_\x07abcdef1234567890ABCDEF1234567890abcdef')).toBe(true)
    expect(mightContainSensitiveText('\x1b]0;x.g\x07\x1b]0;y\x07hp_abcdef1234567890ABCDEF1234567890abcdef')).toBe(true)
    for (const text of ['ey\x1b[1mJhbGciOiJIUzI1NiJ9abcdef', 'eyJhbGci\x1b[1mOiJIUzI1NiJ9abcdef', 'eyJhb\x1b]0;x\x07GciOiJIUzI1NiJ9abcdef', 'e\x1b]0;x\x07y\x1b]0;z\x07\x1b]0;J\x07abcdefghij1234567890'])
      expect(mightContainSensitiveText(text)).toBe(true)
  })

  it('masks a private key whose markers an escape sequence splits, and keeps one only named in prose', () => {
    for (const [input, expected] of [
      ['-----BE\x1b[1mGIN PRIVATE KEY-----\nMIIEabc\n-----END PRIVATE KEY-----', '[REDACTED PRIVATE KEY]'],
      ['-----BEGIN PRI\x1b[1mVATE KEY-----\nMIIEabc\n-----END PRIVATE KEY-----', '[REDACTED PRIVATE KEY]'],
      ['-----B\x1b]0;x\x07E\x1b]0;GIN\x07 PRIVATE KEY-----\nMIIEabc\n-----END PRIVATE KEY-----', '[REDACTED PRIVATE KEY]'],
      ['-----END PRIVATE KEY-----\x1b[0m done', '-----END PRIVATE KEY-----\x1b[0m done'],
      // A block whose end marker is missing (a display cap cut it off) is masked to the end of the text.
      ['key: -----BE\x1b[1mGIN RSA PRIVATE KEY-----\nMIIEabc', 'key: [REDACTED PRIVATE KEY]'],
      ['key: -----B\x1b]0;x\x07E\x1b]0;GIN\x07 PRIVATE KEY-----\nMIIEabc', 'key: [REDACTED PRIVATE KEY]'],
      ['-----BE\x1b[1mGIN PRIVATE KEY-----\nMIIEabc\n-----END PRIVATE KEY-----\x1b[0m\nnext', '[REDACTED PRIVATE KEY]\x1b[0m\nnext'],
      // A split end marker that any view joins ends the block there, so the text after it is kept.
      ['-----BE\x1b[1mGIN PRIVATE KEY-----\nsecret-body\n-----END PRI\x1b[1mVATE KEY----- suffix', '[REDACTED PRIVATE KEY] suffix'],
      ['-----BEGIN PRIVATE KEY-----\nsecret-body\n-----END PRI\x1b[1mVATE KEY----- suffix', '[REDACTED PRIVATE KEY] suffix'],
      ['-----B\x1b]0;x\x07E\x1b]0;GIN\x07 PRIVATE KEY-----\nMIIEabc\n-----E\x1b[1mND PRIVATE KEY----- suffix', '[REDACTED PRIVATE KEY] suffix'],
      // Prose that only names the markers is unchanged.
      ['\x1b[1mBEGIN\x1b[0m the PRIVATE KEY section', '\x1b[1mBEGIN\x1b[0m the PRIVATE KEY section'],
      ['-----B\x1b]0;x\x07E\x1b]0;GIN\x07 notes about a private key', '-----B\x1b]0;x\x07E\x1b]0;GIN\x07 notes about a private key'],
    ]) {
      expect(redactText(input, true)).toBe(expected)
      expect(sanitizeShareMessage({ role: 'assistant', content: input }, [], [], '/nonexistent-home')?.content).toBe(expected)
    }
  })

  it('masks a split token before a sentence period, and a spaced URL query value up to its fragment', () => {
    expect(redactText('ghp_abcdef\n1234567890ABCDEF1234567890abcdef.', true)).toBe('ghp_ab...cdef.')
    expect(redactText('https://x.test/?db_pass= hunter2#long-fragment-name', true)).toBe('https://x.test/?db_pass= ***#long-fragment-name')
  })
})

describe('keyword credentials in ANSI-coloured output (TAL-714)', () => {
  const S = 'Zq7xK2mN9pL4vB8cR1tY6wE3uI5oA0sD2fG4hJ'
  const T = 'AAHsynthetic0198765432abcdefghijklmnop'
  const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  const leaks = (text: string, secret: string): boolean => Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8)).some((run) => stripAnsi(text).includes(run))
  const share = (text: string): unknown => sanitizeShareMessage({ role: 'assistant', content: text }, [], [], '/nonexistent-home')?.content

  it('masks a value whose key, separator or token an escape sequence colours or splits, through the prefilter', () => {
    for (const [input, secret] of [
      // grep --color=always (ugrep and GNU grep), a match inside a flag, and jq -C.
      [`\x1b[1;31mAPI_KEY\x1b[m=${S}\x1b[m`, S],
      [`DB_\x1b[m\x1b[1;31mPASSWORD\x1b[m=${S}\x1b[m`, S],
      [`\x1b[01;31m\x1b[KAPI_KEY\x1b[m\x1b[K=${S}`, S],
      [`curl --\x1b[01;31m\x1b[Kpassword\x1b[m\x1b[K ${S}`, S],
      [`\x1b[1;34m"api_key"\x1b[0m\x1b[1;39m:\x1b[0m \x1b[0;32m"${S}"\x1b[0m`, S],
      [`\x1b[1;34m"password"\x1b[0m\x1b[1;39m:\x1b[0m \x1b[0;32m"${S}"\x1b[0m`, S],
      [`\x1b[34;1m"token"\x1b[0m: "${S}"`, S],
      [`\x1b[36mpassword\x1b[0m: ${S}`, S],
      // A key split by a sequence.
      [`API_\x1b[1mKEY=${S}`, S],
      [`--pass\x1b[1mword ${S}`, S],
      [`Bear\x1b[1mer ${S}`, S],
      // A Telegram bot token split by a sequence.
      [`bot123456789:AAHsynthetic01\x1b[1m98765432abcdefghijklmnop`, T],
      [`123456789\x1b[0m:\x1b[1m${T}`, T],
    ]) {
      expect.soft(mightContainSensitiveText(input!), JSON.stringify(input)).toBe(true)
      expect.soft(leaks(redactText(input, true) as string, secret!), JSON.stringify(redactText(input, true))).toBe(false)
      expect.soft(leaks(share(input!) as string, secret!), JSON.stringify(share(input!))).toBe(false)
    }
  })

  it('masks a value of delimiters only behind a coloured or split key, returning the view without its sequences', () => {
    for (const [input, expected] of [
      [`--pass\x1b[31mword '$$$$$$$$'`, `--password '***'`],
      ['Bear\x1b[31mer $$$$$$$$', 'Bearer ***'],
      ['\x1b[1;34m"password"\x1b[0m: "$$$$$$$$"', '"password": "***"'],
      ['\x1b[1mpassword\x1b[0m=$$$$$$$$', 'password=***'],
      [`--pass\x1b[31mword '********'`, `--password '***'`],
      ['Bear\x1b[31mer ********', 'Bearer ***'],
      // A later credential stays masked when the fallback runs (`--password …` after a coloured key's value).
      ['{"pass\x1b[31mword":" x"}--password finalSecret987', '{"password":*** ***'],
      // So does an earlier credential whose value swallows the split key (`…999;API_\x1b[31mKEY:`).
      ['API_KEY=otherSecret999;API_\x1b[31mKEY: $$$$$$$$', '***=*** ***'],
      [`\x1b[36mpassword\x1b[0m: @@@@@@@@ and ghp_abcdef1234567890ABCDEF1234567890abcdef\n\x1b[1;31mAPI_KEY\x1b[m=${S}\x1b[m`, 'password: *** and ghp_ab...cdef\nAPI_KEY=***'],
    ]) {
      expect(mightContainSensitiveText(input!)).toBe(true)
      expect(redactText(input, true)).toBe(expected)
      expect(share(input!)).toBe(expected)
    }
  })

  it('masks a split key\'s passphrase whole, and values on separate lines apart', () => {
    expect(redactText(`--pass\x1b[31mword 'correct horse battery staple'`, true)).toBe(`--pass\x1b[31mword '***'`)
    expect(redactText(`\x1b[1mAPI_KEY\x1b[m=${S}\n\x1b[1mDB_PASSWORD\x1b[m=${S}x`, true)).toBe('\x1b[1mAPI_KEY\x1b[m=***\n\x1b[1mDB_PASSWORD\x1b[m=***')
  })

  it('masks a value everywhere when either redaction masks one of its occurrences', () => {
    const input = 'foo\x1b[31m"password":"SECRETX123" pass\x1b[31mword=SECRETX123'
    expect(redactText(input, true)).toBe('foo\x1b[31m"password":"***" pass\x1b[31mword=***')
    expect(share(input)).toBe('foo\x1b[31m"password":"***" pass\x1b[31mword=***')
  })

  it('masks a split key\'s value that equals a mask the redaction makes elsewhere', () => {
    const input = 'ghp_abcdef1234567890ABCDEF1234567890abcdef pass\x1b[31mword=ghp_ab...cdef'
    expect(redactText(input, true)).toBe('*** pass\x1b[31mword=***')
    expect(share(input)).toBe('*** pass\x1b[31mword=***')
    expect(redactText('pass\x1b[31mword=[REDACTED PRIVATE KEY]', true)).toBe('pass\x1b[31mword=***')
    expect(share('pass\x1b[31mword=[REDACTED PRIVATE KEY]')).toBe('pass\x1b[31mword=***')
  })

  it('keeps every escape sequence outside a masked value', () => {
    const ugrep = redactText(`\x1b[1;31mAPI_KEY\x1b[m=${S}\x1b[m`, true) as string
    expect(ugrep.startsWith('\x1b[1;31mAPI_KEY\x1b[m=')).toBe(true)
    expect(ugrep.endsWith('\x1b[m')).toBe(true)
    const jq = redactText(`\x1b[1;34m"api_key"\x1b[0m\x1b[1;39m:\x1b[0m \x1b[0;32m"${S}"\x1b[0m`, true) as string
    expect(jq.startsWith('\x1b[1;34m"api_key"\x1b[0m\x1b[1;39m:\x1b[0m \x1b[0;32m"')).toBe(true)
    expect(jq.endsWith('"\x1b[0m')).toBe(true)
  })

  it('keeps coloured text with no credential, and the output of values the raw text already masks', () => {
    for (const [input, expected] of [
      ['\x1b[1;34m"name"\x1b[0m: "\x1b[0;32m"alice"\x1b[0m"', '\x1b[1;34m"name"\x1b[0m: "\x1b[0;32m"alice"\x1b[0m"'],
      ['\x1b[0m\x1b[01;34mdir\x1b[0m  \x1b[01;32mrun.sh\x1b[0m\n\x1b[01;34mtoken_store\x1b[0m', '\x1b[0m\x1b[01;34mdir\x1b[0m  \x1b[01;32mrun.sh\x1b[0m\n\x1b[01;34mtoken_store\x1b[0m'],
      ['\x1b]8;;file:///tmp/notes\x1b\\notes\x1b]8;;\x1b\\', '\x1b]8;;file:///tmp/notes\x1b\\notes\x1b]8;;\x1b\\'],
      [`API_KEY=\x1b[32m${S}\x1b[0m`, 'API_KEY=***'],
      [`--password \x1b[1m${S}`, '--password ***'],
      [`\x1b[1;31mAuthorization\x1b[m: Bearer ${S}`, '\x1b[1;31mAuthorization\x1b[m: Bearer Zq7xK2...G4hJ'],
      [`\x1b[34mhttps://bob:${S}@x.test\x1b[0m`, '\x1b[34mhttps://bob:Zq7xK2...G4hJ@x.test\x1b[0m'],
      [`aws_secret_access_key = \x1b[32m${S}`, 'aws_secret_access_key = ***'],
      [`\x1b[32m+API_KEY=${S}\x1b[m`, '\x1b[32m+API_KEY=***'],
    ]) {
      expect(redactText(input, true)).toBe(expected)
      expect(share(input!)).toBe(expected)
    }
  })
})
