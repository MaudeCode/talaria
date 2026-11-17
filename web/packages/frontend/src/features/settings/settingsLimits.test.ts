import { expect, it } from 'vitest'
import { SETTINGS_INDEX, type SettingsIndexEntry } from './settingsIndex'

/**
 * TAL-2343: `docs/design-system.md` §11's limits over `SETTINGS_INDEX`: a group holds at most eight rows and a page at most
 * twenty. A page is a section, a Tools tab or a sub-page; a drawing of a component's switches counts as one row.
 */
function limitViolations(index: readonly SettingsIndexEntry[]): string[] {
  const pages = new Map<string, Map<string, Set<string>>>()
  // A row on a listed item's own page (a provider's) is not a row of the page that lists it.
  for (const entry of index.filter((e) => !e.item)) {
    const page = `${entry.section}${entry.page ? `/${entry.page}` : ''}${entry.tab ? `#${entry.tab}` : ''}`
    const groups = pages.get(page) ?? pages.set(page, new Map()).get(page)!
    const group = entry.group()
    const rows = groups.get(group) ?? groups.set(group, new Set()).get(group)!
    rows.add(entry.drawing ? `drawing:${entry.drawing}` : entry.id)
  }
  return [...pages].flatMap(([page, groups]) => {
    const total = [...groups.values()].reduce((sum, rows) => sum + rows.size, 0)
    return [
      ...[...groups].filter(([, rows]) => rows.size > 8).map(([group, rows]) => `Settings › ${page} › ${group} has ${rows.size} rows (max 8): split it by what the rows affect`),
      ...total > 20 ? [`Settings › ${page} has ${total} rows (max 20): move rarely changed rows to a sub-page (design-system §11)`] : [],
    ]
  })
}

it('keeps every Settings group within eight rows and every page within twenty (TAL-2343)', () => {
  expect(limitViolations(SETTINGS_INDEX)).toEqual([])
})

const row = (id: string, group = 'Group', extra: Partial<SettingsIndexEntry> = {}): SettingsIndexEntry => ({ section: 'chat', group: () => group, id, label: () => id, scope: 'interface', ...extra })

it('names the group and page over a limit, counting a drawing once (TAL-2343)', () => {
  const eight = Array.from({ length: 8 }, (_, i) => row(`r${i}`))
  expect(limitViolations(eight)).toEqual([])
  expect(limitViolations([...eight, row('r8')])).toEqual(['Settings › chat › Group has 9 rows (max 8): split it by what the rows affect'])
  // Ten switches drawn on one picture are one row.
  expect(limitViolations([...Array.from({ length: 10 }, (_, i) => row(`c${i}`, 'Group', { drawing: 'composer' })), ...eight.slice(1)])).toEqual([])
  const page = ['A', 'B', 'C'].flatMap((group) => Array.from({ length: 7 }, (_, i) => row(`${group}${i}`, group)))
  expect(limitViolations(page.slice(1))).toEqual([])
  expect(limitViolations(page)).toEqual(['Settings › chat has 21 rows (max 20): move rarely changed rows to a sub-page (design-system §11)'])
  // A sub-page and a listed item's rows count apart from the page.
  expect(limitViolations([...page.slice(1), row('sub', 'A', { page: 'advanced' }), row('item', 'A', { item: true })])).toEqual([])
})
