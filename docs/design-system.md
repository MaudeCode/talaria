# Talaria design system

The shared rulebook for every screen in the Apple app (`app/`) and Talaria Web
(`web/`). Read it before building, changing or reviewing UI on either client.
Component docs that go deeper: `web/DESIGN.md` (tokens, chat transcript,
composer), `web/docs/UIUX-GUIDE.md` (chat hierarchy, context menus, evidence),
`app/docs/ios-26-liquid-glass-navigation.md` (native navigation containers).
Where those documents and this one disagree about a hub, list, settings or
detail page, this document wins; the chat transcript and the composer keep
their own rules (see Exceptions).

The reference implementation is Insights (TAL-1750, TAL-1782):

| Surface | App | Web |
| --- | --- | --- |
| Page with tabs and a plain list | `app/Talaria/Features/Insights/InsightsView.swift` | `web/packages/frontend/src/features/insights/InsightsPage.tsx` |
| Item row with figures | `ProviderQuotaAccountRow.swift`, `ProviderQuotaDetailView.swift` (`ProviderQuotaWindowsView`) | `web/packages/frontend/src/features/insights/ProviderQuotaRows.tsx` |
| Stat grid, charts, share rows | `InsightsStatGrid.swift`, `InsightsDailyChart.swift`, `InsightsActivityCharts.swift`, `ModelBreakdownRow.swift` | `InsightsPage.tsx` (`<dl>` stats, models table), `BarChart.tsx` |
| Detail screen | `ProviderQuotaDetailView.swift` | the Insights tab routes (`routes/_app.insights.tsx`) |

A new page starts by copying the structure of the matching row above, not by
inventing a layout. A rule below that names a component means that component,
extended if it lacks something; a second copy of its layout is a review finding.

## 1. Principles

1. **Content on the page, not in boxes.** Rows sit directly on the page
   background, separated by hairlines and spacing. No cards, tiles, bento
   grids, grouped inset backgrounds or bordered panels around content.
2. **Hierarchy by type, not by chrome.** A screen reads through type size,
   weight and colour: one headline figure per item, labels in small muted
   type, everything else body size.
3. **Figures are figures.** Numbers use tabular (monospaced) digits, carry
   their unit or mode word beside them, and have the exact value available
   (tooltip, VoiceOver value or a values list).
4. **One accent, state colours for state.** The accent marks the healthy or
   selected state. Warning, error and success colours appear only when the
   server says so. Nothing is coloured for decoration.
5. **The server decides, the client formats.** Every shown value, level,
   ordering, grouping and classification is a contract field. The client
   formats numbers, dates and units, localises wording, and keeps device-local
   UI state (root `AGENTS.md`, "Server-owned state").
6. **Actions beside their content.** An item's actions live on the item: swipe
   and context menu on the App, a context menu and inline controls on Web.
   Page-level actions live in the toolbar.
7. **No filler.** No subtitles that explain a heading, no introductions to a
   list, no reassurance copy. Status, errors, counts and data are the only
   sub-text.

## 2. Page anatomy

A page is, top to bottom: the title, an optional segmented control or tab
strip, an optional toolbar row, the list body, an optional footnote.

| Part | App | Web |
| --- | --- | --- |
| Title | `navigationTitle`; `.inline` display on detail screens | `HubPage` `title` (`shell/AppShell.tsx`) |
| Tabs | Segmented `Picker` in `safeAreaInset(edge: .top)` on the system background, identifier `<feature>-tabs`; the tab is device-local `@State`, a deep link selects its tab | `role="tablist"` of `role="tab"` buttons in the `HubPage` toolbar, `aria-selected`, `aria-controls="<feature>-<tab>"`, active `bg-accent-bg text-accent-text`, idle `text-muted hover:bg-hover hover:text-text`; the tab is a `?tab=` search param |
| Toolbar | Trailing `ToolbarItem`s: refresh (`RefreshToolbarButton`), then a `Menu` behind `ellipsis.circle` for secondary actions and pickers, then a tinted warning button that opens a popover when the server reports a notice | Selects in `<label className="ml-auto flex items-center gap-2 text-xs text-muted">`, each with an `aria-label`; the primary action is a `Button` at the right of the section heading |
| Body | `List { … }.listStyle(.plain)` on `Color(.systemBackground)`; content that is not a row hides its separator | `<section data-section="<feature>">` containing `h2` + `ul`, or a `<dl>`, or a `<figure>`; the page body scrolls, not the section |
| Background | `Color(.systemBackground)` everywhere, including behind the tabs | `bg-bg` from the shell; no `bg-surface` behind lists |
| Detail | A push into the navigation stack or the split view's detail column (`SectionItem` case), never a sheet for content | A route or search param, never a modal for content |
| Footnote or notice | `.caption` secondary text in its own `Section`, separator hidden | `<p role="status" className="text-xs text-muted">` above the list for a server notice; no footnote yet |

Sheets, popovers, menus and dialogs remain for interactions (pick a value,
confirm, enter text). They do not hold content a user reads for its own sake.

## 3. Lists and rows

| Rule | App | Web |
| --- | --- | --- |
| List | `.listStyle(.plain)`; `SidebarList` (`Features/Shared/SidebarKit.swift`) for section lists that need row-height 0 | `<ul className="flex flex-col">` |
| Row insets | `.listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 10, trailing: 20))`; compact rows 8/20 | `<li className="flex flex-col gap-4 border-t border-border py-4 first:border-t-0">`; compact rows `border-border-subtle py-2 text-xs` |
| Separator | The list's own hairline; hidden on non-row content | `border-t border-border` between items, `border-border-subtle` inside an item |
| Row header line | `HStack(alignment: .firstTextBaseline, spacing: 8)`: icon 20pt, name `.headline`, chips, `Spacer`, progress or chevron `.footnote.weight(.semibold)` tertiary | `flex flex-wrap items-baseline gap-x-2 gap-y-1`: name `text-sm font-semibold text-text`, chips, status text |
| Row body | `VStack(alignment: .leading, spacing: 12)` of blocks, 14 between repeated items (windows); inside a block `spacing: 6` | `flex flex-col gap-1.5` per block |
| Tappable row | `Button(action:)` with `.buttonStyle(.plain)` and `.contentShape(Rectangle())`; identifier `<entity>-row-<id>` (`provider-quota-row-<id>`) | A plain `li` with `data-<entity>-<thing>="<id>"` (`data-quota-source`); when a Web row opens a detail, the row header is the link |
| Item actions | `.swipeActions(edge: .trailing)` for the destructive or hide action (`.tint(.orange)` for hide), `.contextMenu` with every action | `ContextMenu` (`ui/Menu.tsx`) with every action once a row has any (`web/docs/UIUX-GUIDE.md`, "Context menus"); the visible trigger shows the same items. Insights rows have no Web actions yet |
| Reordering | `.onMove` under an edit mode the toolbar toggles; order is a device setting | Not shipped; when added, a drag handle per row and the order kept per browser through `lib/persisted` |
| Grouping | A second `Section("…")` for items without data ("No quota data"), compact rows | A second `<section data-section="<feature>-unavailable">` with an `h3` header, compact rows |

## 4. Section headers

| App | Web |
| --- | --- |
| `Text(title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)`, optional trailing detail `.footnote` secondary, optional small `ProgressView`; `.padding(.horizontal, 20).padding(.vertical, 6)`, `listRowInsets(EdgeInsets())`, system background (`InsightsView.usageHeader`; TAL-1765 moves it to a shared header and puts it on the detail screen and the "No quota data" section, which still use the default `Section` header) | `<h3 className="text-xs font-medium uppercase tracking-wider text-muted">`; the page section title is `<h2 className="text-base font-semibold text-text">` with the primary action beside it |

The trailing detail is live data (a peak, a count), never an explanation.

## 5. Figures, meters and cells

| Element | App | Web |
| --- | --- | --- |
| Headline figure | `.font(.title2.weight(.semibold).monospacedDigit())`, mode word `.caption` secondary beside it, `.lastTextBaseline` aligned | `text-lg font-semibold tabular-nums text-strong`, mode word `text-xs text-muted`, `items-baseline` |
| Stat grid | `InsightsStatGrid`: `.adaptive(minimum: 140)` columns, title `.caption` secondary, value `.title3.weight(.semibold)` | `<dl className="grid grid-cols-2 sm:grid-cols-4">`, `dt text-xs uppercase tracking-wider text-muted`, `dd text-lg font-semibold text-strong` with the exact value in `title` |
| Metric cell | `ProviderQuotaMetricCell(title:value:)` (`Models/ProviderQuotaForecastView.swift`): title `.caption2` secondary, value `.caption.weight(.semibold).monospacedDigit()`, padding 8/6, `.secondary.opacity(0.1)` fill, radius 9, one accessibility element "title, value" | `MetricCell` in `ProviderQuotaRows.tsx`: `rounded-md bg-hover px-2 py-1.5`, label `text-[11px] text-muted`, value `text-xs font-semibold tabular-nums text-text` |
| Meter | `ProgressRailView(percent:markerPercent:tint:height:)` (`Models/ProgressRailView.swift`): height 3 default, 8 for a window, 4 for a share; track `.secondary.opacity(0.18)`; marker 1.5pt primary | `<div role="meter" aria-valuemin aria-valuemax aria-valuenow aria-label>` `relative h-2 overflow-hidden rounded-full bg-border`, fill `h-full rounded-full` + level class, marker `absolute inset-y-0 w-px bg-text` |
| Meter tint | The server level through `ProviderQuotaWidgetPalette.arcColor` (healthy accent, warning orange, critical red, user-overridable); stale and unavailable orange | `LEVEL_FILL`: `healthy bg-accent`, `warning bg-warning`, `critical bg-error`, `stale`/`unavailable bg-muted` |
| Forecast line | Reset label left (`.caption` secondary), forecast `Label` right tinted `ProviderQuotaForecastOutcome.tint` (safe green, warning orange) | Reset left, forecast right, `text-warning` only when warning, `data-forecast` |
| Share rail | `ModelBreakdownRow`: `ProgressRailView(height: 4)` under the row | A right-aligned `tabular-nums` column; the rail follows when a Web share row is added |

Metric cells are the one filled shape inside a list. They hold a label and a
figure, never prose, never an action, and never nest.

## 6. Charts

Both clients follow the same chart contract (the `dataviz` rules):

- One hue (the accent); a selected bar keeps it and the others dim to 35%.
- A baseline, a y-max label, x labels thinned to a readable count, a light
  grid (0.5pt lines on the App, one mid line on Web).
- A direct readout: the App daily chart reads a day on drag, Web reads a bar
  on hover.
- Every point reachable: a "Values" disclosure (App daily), the chart's
  accessibility value (App activity), a toggled table twin (Web).
- One accessibility element per chart with a summary: count, peak and when.

| App | Web |
| --- | --- |
| Swift Charts `BarMark` with `clipShape(RoundedRectangle(cornerRadius: 2))`, `InsightsChartAxis` grid and trailing y axis, heights 170 (daily) and 120 (activity), metric `Picker` segmented above the daily chart, `DisclosureGroup("Values")` below it | `BarChart` (`features/insights/BarChart.tsx`): `<figure>` with `figcaption`, `controls` slot for a `Select`, `role="img"` summary, `sr-only` table twin |

## 7. Chips, badges and status marks

| Element | App | Web |
| --- | --- | --- |
| Plan or kind chip | `.caption2.weight(.medium)` secondary in a row, `.caption.weight(.medium)` in a detail header, padding 7/3, `Capsule().fill(Color(.tertiarySystemFill))` | `Badge tone="border-border text-muted"` |
| Active or selected mark | `checkmark.circle.fill` `.caption.weight(.semibold)` green with an accessibility label in a row; a `Label` with the same icon in a detail header | `Badge tone="border-accent text-accent-text"` |
| Status text | `.footnote` secondary beside a 7pt dot (green available, orange stale, red failed); retry notes `.caption` orange | `text-xs`; `text-warning` for stale, `text-error` for failures |
| Freshness | "Updated 3 min ago" `.caption2` secondary, clamped so a future timestamp reads as now | `As of … · Last checked …` `text-xs text-muted`, `text-warning` when stale |

Chips carry one or two words. A chip never carries a sentence or a number
that belongs in a figure.

## 8. States

| State | App | Web |
| --- | --- | --- |
| Loading | A small `ProgressView` in the section header or toolbar; existing rows stay | `LoadingState` (`compact` when a heading is already on screen); existing rows stay |
| Refreshing | `ProgressView().controlSize(.small)` in the row header of the item being refreshed | The section's refresh `Button` is disabled and reads "Refreshing…" |
| Empty | A `ContentUnavailableView` or one caption row with the server's reason | `EmptyState` with the server's reason |
| Error | `ContentUnavailableView` with the server's message and "Try Again" when nothing loaded; a tinted toolbar button with a popover when rows exist | `ErrorState` with `onRetry`; never a blank pane |
| Unavailable items | Grouped below the data rows under a header, one line each: name and reason | The `-unavailable` section with compact rows |

`EmptyState` and `ErrorState` keep their dashed or alert frame because they
ask for an action. No other state wears a frame.

## 9. Copy

- Headings are nouns ("Quotas", "Reset schedule"); buttons are verbs ("Refresh
  quotas", "Reorder Accounts"); toggles are the thing they control.
- No explanatory sub-text under a heading, switch or row. Web puts an
  explanation in a `HelpTip` (`ui/Field.tsx`); the App puts it in the docs or
  nowhere.
- Status copy fits one line at 390pt width. Shorten before wrapping.
- Figures keep their unit or mode word in the locale's form: "25% used",
  "0.62×", "25%/hr", "2d 12h". Formatters are shared: `i18n/units.ts` on Web,
  `insightsFormattedPercent`, `insightsCompactNumber` and `formatTokens` in
  TalariaKit on the App.
- The server's wording for a reason, notice or detail is shown as sent.
- Every string is localised (`m.*` Paraglide messages on Web, `String(localized:)`
  on the App).

## 10. Accessibility and test hooks

| Rule | App | Web |
| --- | --- | --- |
| Identifiers | `<feature>-<thing>` for page regions (`insights-tabs`, `insights-daily-chart`), `<entity>-section`, `<entity>-row-<id>` and `<entity>-<thing>-<id>` for item regions (`provider-quota-row-<id>`, `provider-quota-windows-<id>`) | `data-section="<feature>"` on the section, `data-<entity>-<thing>="<id>"` on items (`data-quota-source`, `data-quota-window`), `data-<state>` attributes for levels and outcomes (`data-level`, `data-forecast`, `data-metric`), `data-testid` only for grids and tables |
| Rows | `.accessibilityElement(children: .contain)` with a hint naming the destination for a multi-block row; `.combine` for a one-line row | Semantic markup (`ul/li`, `dl`, `table` with `caption`, `figure`) |
| Figures | Combined labels "title, value"; percent read with its mode word | The meter's `aria-label` carries label, percent and mode |
| Charts | One element with label and value summary; a values list for every point | `role="img"` summary and the table twin |
| Dynamic Type | System text styles only; `lineLimit` relaxes at accessibility sizes; cell values use `minimumScaleFactor(0.8)`; rail heights are fixed points | The token scale (`--text-xs/sm/md`); a bracket size only where no token exists (11px cell labels, 13px state text, 20px hub title) |
| Motion | Countdowns move on a shared `TimelineView(.everyMinute)`; reorder animates with `withAnimation` | Shimmer and pulse respect `prefers-reduced-motion` |
| Time and locale | `Date.FormatStyle(locale:timeZone:)` from the `\.locale` and `\.timeZone` environment so tests pin UTC and `en_US` (the daily chart's axis and values still use bare `.dateTime`, see §12) | `Intl` with the viewer's locale from `useLocale` |

## 11. Exceptions

| Surface | Rule | Owner |
| --- | --- | --- |
| Chat transcript (bubbles, tool and thinking rows, worklog) | Keeps its conversation hierarchy | `web/DESIGN.md`, `web/docs/UIUX-GUIDE.md`; the App mirrors Web's transcript |
| Composer | The one floating card | `web/docs/UIUX-GUIDE.md`, "Composer and controls" |
| Kanban | Cards stay because it is a board; their chrome (type, chips, spacing, colours) follows this document | TAL-1769 |
| Dialogs, menus, popovers, sheets | Interaction surfaces, not content containers | Platform defaults |
| Widgets and Live Activities | System layouts with the shared meter and palette | `app/Talaria/Models/ProviderQuotaWidget*.swift` |

## 12. Known deviations in the reference

The reference is the rule; these spots in Insights still differ and are owned:

| Deviation | Owner |
| --- | --- |
| The App detail screen and the "No quota data" section use default `Section` headers instead of the uppercase header | TAL-1765 |
| The App daily chart formats dates with bare `.dateTime`, not the environment locale and zone | TAL-1765 |
| The Web Period select has no `aria-label` | TAL-1786 |
| Stale and unavailable meters are orange on the App (palette default) and muted on Web | Decide with TAL-1533 (server-owned presentation state) |

## 13. Checklist for a UI change

1. Find the Insights row or section that shows the same kind of thing and
   start from its structure and components.
2. No new container: if the design needs a box, it needs a section header or a
   metric cell instead.
3. Every value shown is a contract field; every colour is a server level.
4. Headline figure, label, unit; tabular digits; exact value reachable.
5. Actions on the item (swipe, context menu) and in the toolbar; nothing waits
   for the server to reflect a choice (root `AGENTS.md`, "Optimistic writes").
6. Identifiers and `data-*` hooks follow the naming above; a hosted test or
   component test reads them.
7. Screenshots at phone width (390pt) and desktop in the PR; status copy on
   one line.
