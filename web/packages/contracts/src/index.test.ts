import { describe, expect, it } from 'vitest'
import { SIDECAR_RPC_VERSION } from './index.js'

describe('contracts package', () => {
  it('exports an integer sidecar RPC version', () => {
    expect(Number.isInteger(SIDECAR_RPC_VERSION)).toBe(true)
    expect(SIDECAR_RPC_VERSION).toBeGreaterThan(0)
  })
})
