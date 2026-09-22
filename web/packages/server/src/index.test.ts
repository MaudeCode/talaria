import { describe, expect, it } from 'vitest'
import { SIDECAR_RPC_VERSION } from '@maudecode/talaria-web-contracts'
import { SERVER_SIDECAR_RPC_VERSION } from './index.js'

describe('server package', () => {
  it('speaks the contracts package sidecar RPC version', () => {
    expect(SERVER_SIDECAR_RPC_VERSION).toBe(SIDECAR_RPC_VERSION)
  })
})
