import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ShowBlockRefSchema, ShowBlockSchema } from './show.js'

it('pins the shared show fixture both clients render (TAL-1968)', () => {
  const { ref, ...blocks } = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/show.json'), 'utf8')) as Record<string, unknown>
  expect(ShowBlockRefSchema.parse(ref)).toEqual(ref)
  for (const block of Object.values(blocks)) expect(ShowBlockSchema.parse(block)).toEqual(block)
  expect(Object.values(blocks).map((block) => (block as { kind: string }).kind).sort()).toEqual(['chart', 'chart', 'file', 'file', 'file', 'html', 'table'])
})
