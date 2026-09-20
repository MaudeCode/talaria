import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIDECAR_METHODS, type SidecarMethodName } from './methods.js'
import { SIDECAR_RPC_VERSION } from './version.js'

const fixtureDir = resolve(import.meta.dirname, '../../fixtures/sidecar')

describe('sidecar method fixtures', () => {
  const files = readdirSync(fixtureDir).filter((name) => name.endsWith('.json'))

  it.each(files)('%s parses with its method schemas', (file) => {
    const method = file.replace(/\.json$/, '') as SidecarMethodName
    expect(SIDECAR_METHODS).toHaveProperty(method)
    const fixture = JSON.parse(readFileSync(resolve(fixtureDir, file), 'utf8')) as { params: unknown; result: unknown }
    expect(SIDECAR_METHODS[method].params.parse(fixture.params)).toBeTruthy()
    expect(SIDECAR_METHODS[method].result.parse(fixture.result)).toBeTruthy()
  })

  it('pins the RPC version the Python package declares', () => {
    const init = readFileSync(resolve(import.meta.dirname, '../../../../sidecar/talaria_sidecar/__init__.py'), 'utf8')
    expect(init).toMatch(new RegExp(`^SIDECAR_RPC_VERSION = ${SIDECAR_RPC_VERSION}$`, 'm'))
  })
})
