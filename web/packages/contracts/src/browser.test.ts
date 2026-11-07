import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as browser from './browser.js'
import * as full from './index.js'

const src = import.meta.dirname

/** Every local module an entry reaches, following both `import` and re-export specifiers. */
function moduleGraph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen
  seen.add(entry)
  for (const [, specifier] of readFileSync(entry, 'utf8').matchAll(/from '(\.[^']+)\.js'/g)) moduleGraph(resolve(dirname(entry), `${specifier}.ts`), seen)
  return seen
}

describe('browser entry', () => {
  it('reaches no module under sidecar/', () => {
    const graph = [...moduleGraph(resolve(src, 'browser.ts'))].map((file) => relative(src, file))
    expect(graph).toContain('views.ts')
    expect(graph.filter((file) => file.startsWith('sidecar/'))).toEqual([])
  })

  it('exports what the frontend uses and none of the sidecar RPC', () => {
    for (const name of ['SessionEnvelopeSchema', 'ChatEventSchema', 'TOKEN_NAMES', 'routeContract']) expect(browser, name).toHaveProperty(name)
    for (const name of ['SIDECAR_RPC_VERSION', 'SIDECAR_METHODS', 'RpcRequestSchema', 'RuntimeDescribeSchema', 'generateOpenApiDocument']) {
      expect(full, name).toHaveProperty(name)
      expect(browser, name).not.toHaveProperty(name)
    }
  })
})
