import { describe, expect, it } from 'vitest'
import { pluginListing } from './plugin-listing.js'

// One bundled row per group, two installed rows, and categories the groups do not name.
const row = (key: string, extra: { name?: string; description?: string; category?: string; source?: 'installed' | 'bundled'; enabled?: boolean; update?: { available: boolean } } = {}) => ({ key, category: key.includes('/') ? key.split('/')[0] : '', source: 'bundled' as const, enabled: true, ...extra })
interface Group { id: string; plugin_keys: string[]; enabled_count: number; total_count: number; enabled_percent: number }
const shape = (groups: Group[] = []) => groups.map((g) => [g.id, g.plugin_keys, g.enabled_count, g.total_count, g.enabled_percent])
const rows = [
  row('zeta-notes', { name: 'zeta-notes', source: 'installed', enabled: false, description: 'Shared notes' }),
  row('image_gen/meshy', { name: 'meshy', source: 'installed', update: { available: true } }),
  row('platforms/slack', { name: 'slack' }),
  row('platforms/discord', { name: 'discord', enabled: false }),
  row('web/brave', { name: 'brave' }),
  row('image_gen/fal', { name: 'fal', description: 'flux and nano-banana' }),
  row('video_gen/fal', { name: 'fal' }),
  row('browser/camofox', { name: 'camofox' }),
  row('dashboard-auth/basic', { name: 'basic' }),
  row('memory/honcho', { name: 'honcho' }),
  row('model-providers/openrouter', { name: 'openrouter' }),
  row('context_engine/lcm', { name: 'lcm', enabled: false }),
  row('standalone-tool', { name: 'standalone-tool' }),
  row('installed/odd', { name: 'odd' }),
]

describe('pluginListing groups and summary (TAL-2132)', () => {
  it('puts installed rows first, each bundled row in the group its category names, and the rest in other', () => {
    const { groups } = pluginListing(rows)
    expect(shape(groups)).toEqual([
      ['installed', ['image_gen/meshy', 'zeta-notes'], 1, 2, 50],
      ['platforms', ['platforms/discord', 'platforms/slack'], 1, 2, 50],
      ['web', ['web/brave'], 1, 1, 100],
      ['image_gen', ['image_gen/fal'], 1, 1, 100],
      ['video_gen', ['video_gen/fal'], 1, 1, 100],
      ['browser', ['browser/camofox'], 1, 1, 100],
      ['dashboard_auth', ['dashboard-auth/basic'], 1, 1, 100],
      ['memory', ['memory/honcho'], 1, 1, 100],
      ['model_providers', ['model-providers/openrouter'], 1, 1, 100],
      ['other', ['context_engine/lcm', 'installed/odd', 'standalone-tool'], 2, 3, 200 / 3],
    ])
  })

  it('counts the whole install in the summary', () => {
    expect(pluginListing(rows).summary).toEqual({ installed: 2, bundled: 12, enabled: 11, total: 14, updates: 1, updates_tone: 'warning' })
  })

  it('with q lists only the groups and keys that match; counts and summary describe the whole install', () => {
    const listing = pluginListing(rows, ' FAL ')
    expect(shape(listing.groups)).toEqual([
      ['image_gen', ['image_gen/fal'], 1, 1, 100],
      ['video_gen', ['video_gen/fal'], 1, 1, 100],
    ])
    expect(listing.summary).toEqual(pluginListing(rows).summary)
    expect(listing.plugins.map((p) => p.key)).toEqual(['image_gen/fal', 'video_gen/fal'])
    expect(listing.total).toBe(14)
    expect(shape(pluginListing(rows, 'slack').groups)).toEqual([['platforms', ['platforms/slack'], 1, 2, 50]])
  })

  it('omits empty groups but keeps installed, and reads a row without a source as bundled', () => {
    const { groups, summary } = pluginListing([{ key: 'web/brave', name: 'brave', category: 'web' }])
    expect(groups).toEqual([
      { id: 'installed', plugin_keys: [], enabled_count: 0, total_count: 0, enabled_percent: 0 },
      { id: 'web', plugin_keys: ['web/brave'], enabled_count: 1, total_count: 1, enabled_percent: 100 },
    ])
    expect(summary).toEqual({ installed: 0, bundled: 1, enabled: 1, total: 1, updates: 0, updates_tone: null })
  })
})
