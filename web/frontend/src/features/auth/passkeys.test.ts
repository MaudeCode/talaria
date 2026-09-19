import { describe, expect, it } from 'vitest'
import { b64uToBytes, bytesToB64u } from './passkeys'

describe('base64url codec', () => {
  it('round-trips bytes without padding', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const enc = bytesToB64u(bytes)
    expect(enc).not.toMatch(/[+/=]/)
    expect([...b64uToBytes(enc)]).toEqual([...bytes])
  })
  it('decodes unpadded input', () => {
    expect([...b64uToBytes('AQI')]).toEqual([1, 2])
  })
})
