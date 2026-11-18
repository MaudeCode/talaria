import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = import.meta.dirname

/** Every local module an entry reaches, following both `import` and re-export specifiers. */
function moduleGraph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen
  seen.add(entry)
  for (const [, specifier] of readFileSync(entry, 'utf8').matchAll(/from '(\.[^']+)\.js'/g)) moduleGraph(resolve(dirname(entry), `${specifier}.ts`), seen)
  return seen
}

describe('browser entry', () => {
  it('reaches no module under sidecar/ and not the OpenAPI generator', () => {
    const graph = [...moduleGraph(resolve(src, 'browser.ts'))].map((file) => relative(src, file))
    expect(graph).toContain('views.ts')
    expect(graph.filter((file) => file.startsWith('sidecar/') || file === 'openapi.ts')).toEqual([])
  })
})
