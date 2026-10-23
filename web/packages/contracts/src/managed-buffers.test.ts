import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { DirListingSchema, FileContentSchema } from './views.js'

it('publishes explicit managed identity, permissions and unconditional write semantics', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/managed-buffers.json', import.meta.url), 'utf8')) as { listing: unknown; content: unknown; unavailable: unknown }
  expect(DirListingSchema.parse(fixture.listing)).toMatchObject({ source: 'managed', write_semantics: 'unconditional', entries: [{ read_only: false }] })
  expect(FileContentSchema.parse(fixture.content)).toMatchObject({ source: 'managed', read_only: false, content: 'original', preview: 'text' })
  expect(DirListingSchema.parse(fixture.unavailable)).toMatchObject({ source: 'managed', unavailable: true })
})
