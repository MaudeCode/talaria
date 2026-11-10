import { PluginGroupIdSchema, type PluginGroupId } from '@maudecode/talaria-web-contracts'

interface ListedPlugin { key: string; name?: string | undefined; description?: string | undefined; category?: string | undefined; source?: 'installed' | 'bundled' | undefined; enabled?: boolean | undefined; update?: { available: boolean } | undefined }

const GROUP_IDS = PluginGroupIdSchema.options
const BUNDLED_GROUPS = new Set<string>(GROUP_IDS.filter((id) => id !== 'installed' && id !== 'other'))

/** TAL-2132: an installed row's group is `installed`; a bundled row's is its category with `-` read as `_`, else `other`. */
function groupOf(row: ListedPlugin): PluginGroupId {
  if (row.source === 'installed') return 'installed'
  const id = (row.category ?? '').replaceAll('-', '_')
  return BUNDLED_GROUPS.has(id) ? id as PluginGroupId : 'other'
}

const label = (row: ListedPlugin) => row.name || row.key
const byName = (a: ListedPlugin, b: ListedPlugin) => label(a).localeCompare(label(b), 'en', { sensitivity: 'base' }) || a.key.localeCompare(b.key, 'en')
// The page shows a row without `enabled` as on.
const on = (row: ListedPlugin) => row.enabled !== false

/**
 * TAL-2129: Settings › Tools › Plugins' filter keeps rows whose name (else key) or description contains `q`, case-insensitively;
 * `total` and `empty` describe every row. TAL-2132: `groups` and `summary` (see `PluginGroupSchema`, `PluginsSummarySchema`).
 */
export function pluginListing<T extends ListedPlugin>(rows: T[], q = '') {
  const needle = q.trim().toLowerCase()
  const matches = (row: T) => !needle || [label(row), row.description ?? ''].some((text) => text.toLowerCase().includes(needle))
  const plugins = needle ? rows.filter(matches) : rows
  const members = new Map<PluginGroupId, T[]>(GROUP_IDS.map((id) => [id, []]))
  for (const row of rows) members.get(groupOf(row))?.push(row)
  const groups = GROUP_IDS.flatMap((id) => {
    const all = (members.get(id) ?? []).sort(byName)
    const enabled = all.filter(on).length
    return id === 'installed' || all.length ? [{ id, plugin_keys: all.filter(matches).map((row) => row.key), enabled_count: enabled, total_count: all.length, enabled_percent: all.length ? 100 * enabled / all.length : 0 }] : []
  })
  const installed = members.get('installed')?.length ?? 0
  const updates = rows.filter((row) => row.update?.available === true).length
  const summary = { installed, bundled: rows.length - installed, enabled: rows.filter(on).length, total: rows.length, updates, updates_tone: updates > 0 ? 'warning' as const : null }
  return { plugins, total: rows.length, empty: rows.length === 0, groups, summary }
}
