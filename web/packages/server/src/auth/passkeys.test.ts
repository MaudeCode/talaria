import { describe, expect, it } from 'vitest'
import { cborDecode, PasskeyError } from './passkeys.js'

describe('cborDecode', () => {
  it('rejects deep nesting and oversized container lengths as PasskeyError', () => {
    expect(() => cborDecode(Buffer.alloc(200_000, 0x81))).toThrow(PasskeyError)
    expect(() => cborDecode(Buffer.from('9bffffffffffffffff', 'hex'))).toThrow(PasskeyError)
    expect(() => cborDecode(Buffer.from('bbffffffffffffffff', 'hex'))).toThrow(PasskeyError)
  })

  it('accepts nesting up to the limit', () => {
    expect(cborDecode(Buffer.concat([Buffer.alloc(15, 0x81), Buffer.from([0x00])]))).toBeDefined()
    expect(() => cborDecode(Buffer.concat([Buffer.alloc(16, 0x81), Buffer.from([0x00])]))).toThrow(PasskeyError)
  })
})
