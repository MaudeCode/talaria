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

  it('masks curl proxy credentials (-U, --proxy-user), through the public prefilter', () => {
    expect(redactText('curl --proxy-user bob:hunter2 https://x', true)).toBe('curl --proxy-user bob:*** https://x')
    expect(redactText('curl -U bob:hunter2 https://x', true)).toBe('curl -U bob:*** https://x')
    expect(redactText(`curl -U'bob:two words' https://x`, true)).toBe(`curl -U'bob:***' https://x`)
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
    for (const kept of ['D=/a; false && D=/b; cat $D/x.txt', 'A=1; A=2; seq $A']) expect(redactText(kept, true)).toBe(kept)
    // A value built from other assigned names.
    for (const text of ['OPT=-u; ARG=$OPT; curl $ARG bob:hunter2 x', 'U=bob; SEP=:; CRED="${U}${SEP}"; curl -u ${CRED}hunter2 x']) expect(redactText(text, true)).not.toContain('hunter2')
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
  it('stays linear on long runs of scheme and identifier characters', () => {
    // A quadratic scan takes seconds on these inputs; a linear one takes milliseconds.
    // Unquoted runs, and many credential keys inside one long quoted argument.
    for (const text of [...['abcdefghij-', 'a.b+c-', 'token_', '--password ', 'aB', 'aBcD_', 'ABCd', 'AB'].map((seg) => seg.repeat(Math.ceil(200_000 / seg.length))),
      ...['Authorization: x ', 'Authorization: *** ', 'secret sauce ', 'password=*** '].map((seg) => `"${seg.repeat(Math.ceil(200_000 / seg.length))}"`),
      // One huge identifier that does name a credential, and many long ones that are followed by a separator.
      `--${'aB'.repeat(100_000)}Password=x`, `${'a'.repeat(1_000)}= `.repeat(200), `${'a'.repeat(1_000)}://x:`.repeat(200),
      // Shell-composed identifiers: unclosed and alternating quote and escape pieces.
      ...[`a'`, `a"b'c\\d`, `a'b'`, `pass$'`, `a$(b`, 'a`b ', `a\${b`, `a$b`, `x://b:c'd`, `a$(b$(`, `?token=a&`, `Bearer a'`, `a{b,`, `a{b`, `a{,}`, `a$'\\`, `--$'\\x`, `a'='`, `a'b `, `x:'@'`, `%41`, `a%4`, `a:b`, `'--a', '`, `"-u", "x`].map((seg) => `--${seg.repeat(Math.ceil(200_000 / seg.length))}`),
      // Inline assignments: long chains, prefix chains, many substitutions, and a secret substituted many times.
      ...['A=x; ', 'A=x B=y ', 'export A=x ', '; ', ';A', `A='x `, 'A="x ', 'A=${ ', 'A=$( ', `A=n'x `, 'A=@; $A ', 'A=!; $A '].map((seg) => seg.repeat(Math.ceil(200_000 / seg.length))),
      `A=x; ${'$A ${A} '.repeat(30_000)}`, Array.from({ length: 20_000 }, (_, i) => `A=${i}; $A `).join(''), `${'A=$(x); '.repeat(20_000)}${'A=1; $A '.repeat(20_000)}`,
      Array.from({ length: 5 }, (_, i) => `A=${i}; `).join('') + '$A '.repeat(50_000), `A=${'x'.repeat(10_000)}; ${'B=$A; '.repeat(30_000)}`, `A=x; ${'A=$A$A; '.repeat(25_000)}curl -u bob:$A`,
      `P=hunter2; ${'Q="${P}x"; curl -u bob:$Q '.repeat(8_000)}`, `A=1; A=2; B=1; B=2; C=1; C=2; ${'curl -u bob:$A$B$C '.repeat(12_000)}`, `P=hunter2; ${'curl -u bob:$P '.repeat(15_000)}`, `A=${'x'.repeat(10_000)}; ${'$A'.repeat(50_000)}`]) {
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
})
