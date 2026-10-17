import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto'
type Json = Record<string, unknown>
export const b64u = (value: Buffer): string => value.toString('base64url')

export function cborEncode(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n])
    if (n < 256) return Buffer.from([(major << 5) | 24, n])
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') { const b = Buffer.from(value, 'utf8'); return Buffer.concat([head(3, b.length), b]) }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value.entries()].flatMap(([k, v]) => [cborEncode(k), cborEncode(v)])])
  throw new Error('unsupported')
}

export class FakeAuthenticator {
  constructor(readonly key: { publicKey: KeyObject; privateKey: KeyObject } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), readonly credentialId: Buffer = randomBytes(16)) {}
  counter = 0
  private authData(rpId: string, flags: number, extra: Buffer): Buffer {
    const head = Buffer.alloc(37)
    createHash('sha256').update(rpId, 'ascii').digest().copy(head, 0)
    head[32] = flags
    head.writeUInt32BE(this.counter, 33)
    return Buffer.concat([head, extra])
  }
  register(options: Json, origin: string): Json {
    const rp = options.rp as Json
    const pub = this.key.publicKey.export({ format: 'jwk' })
    const cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(String(pub.x), 'base64url')], [-3, Buffer.from(String(pub.y), 'base64url')]])
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.credentialId.length)
    const credData = Buffer.concat([Buffer.alloc(16), idLen, this.credentialId, cborEncode(cose)])
    const authData = this.authData(String(rp.id), 0x41, credData)
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }))
    const attestation = cborEncode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
    return { id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: 'public-key', response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestation) } }
  }
  assert(options: Json, origin: string, opts: { advance?: boolean } = {}): Json {
    if (opts.advance !== false) this.counter += 1
    const authData = this.authData(String(options.rpId), 0x01, Buffer.alloc(0))
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }))
    const signature = cryptoSign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), this.key.privateKey)
    return { id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: 'public-key', response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) } }
  }
}
