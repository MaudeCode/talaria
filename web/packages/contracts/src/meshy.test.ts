import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DisplayMediaSchema } from './views.js'
import { MeshyCardSchema, MeshyDetailsSchema, MeshyOverviewSchema, MeshySaveResultSchema } from './meshy.js'

const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/meshy.json', import.meta.url), 'utf8')) as Record<string, unknown>

describe('Meshy model media (TAL-1514)', () => {
  it('carries a model case with an opaque server reference', () => {
    const item = { url: '', name: 'Robot', mime: 'model/gltf-binary', kind: 'model', model: { ref: 'opaque-ref' } }
    expect(DisplayMediaSchema.safeParse(item).success).toBe(true)
    expect(DisplayMediaSchema.parse(fixture.media)).toMatchObject({ kind: 'model', url: '' })
  })

  it('publishes explicit availability, progress, unknown credits, drafts and partial downloads', () => {
    expect(MeshyCardSchema.parse(fixture.card).item?.model?.url).toMatch(/^\.\/api\/meshy\/asset\?grant=/)
    expect(MeshyCardSchema.parse(fixture.running)).toMatchObject({ item: null, task: { terminal: false, progress: 38 } })
    expect(MeshyOverviewSchema.parse(fixture.overview)).toMatchObject({ availability: 'missing_key', balance: null, local: [{ download_incomplete: true }] })
    expect(MeshyDetailsSchema.parse(fixture.details).actions[0]?.draft).toContain('5 credits')
    expect(MeshySaveResultSchema.parse(fixture.partial_images)).toMatchObject({ complete: false, saved: ['image-1.png'] })
    expect(MeshyCardSchema.safeParse({ ...(fixture.card as object), availability: 'maybe' }).success).toBe(false)
  })
})
