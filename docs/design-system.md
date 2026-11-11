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
| Settings page | Pending the App sync (TAL-1695) | `web/packages/frontend/src/features/settings/ChatSection.tsx` |
| Menu | Pending the App sync (TAL-1695) | `web/packages/frontend/src/features/composer/chips.tsx` (`ReasoningChip`) |

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
On the Web, `HubPage` gives the header, toolbar and body one horizontal
gutter (`HUB_GUTTER`), so each part starts at the heading's edge; content
inside them adds no horizontal inset of its own.

| Part | App | Web |
| --- | --- | --- |
| Title | `navigationTitle`; `.inline` display on detail screens | `HubPage` `title` (`shell/AppShell.tsx`) |
| Tabs | Segmented `Picker` in `safeAreaInset(edge: .top)` on the system background, identifier `<feature>-tabs`; the tab is device-local `@State`, a deep link selects its tab | `TabStrip` (`ui/TabStrip.tsx`): a `role="tablist"` of `role="tab"` buttons in the `HubPage` toolbar, `aria-selected`, `aria-controls="<feature>-<tab>"`. Underlined text: idle `text-muted`, selected `text-strong` over a 2px accent line, a hairline under the strip, which scrolls sideways when its tabs do not fit. A page with its own tablist (Kanban pins, the panel tabs) uses `TAB_STRIP` and `tabClass`. The tab is a `?tab=` search param |
| Toolbar | Trailing `ToolbarItem`s: refresh (`RefreshToolbarButton`), then a `Menu` behind `ellipsis.circle` for secondary actions and pickers, then a tinted warning button that opens a popover when the server reports a notice | Selects in `<label className="ml-auto flex items-center gap-2 text-xs text-muted">`, each with an `aria-label`; the primary action is a `Button` at the right of the section heading |
| Body | `List { … }.listStyle(.plain)` on `Color(.systemBackground)`; content that is not a row hides its separator | `<section data-section="<feature>">` containing `h2` + `ul`, or a `<dl>`, or a `<figure>`; the page body scrolls, not the section |
| Background | `Color(.systemBackground)` everywhere, including behind the tabs | `bg-bg` from the shell; no `bg-surface` behind lists |
| Detail | A push into the navigation stack or the split view's detail column (`SectionItem` case), never a sheet for content | A route or search param, never a modal for content; `BackButton` (`ui/Button.tsx`) in the page actions returns to the list |
| Footnote or notice | `.caption` secondary text in its own `Section`, separator hidden | `<p role="status" className="text-xs text-muted">` above the list for a server notice; no footnote yet |

Sheets, popovers, menus and dialogs remain for interactions (pick a value,
confirm, enter text). They do not hold content a user reads for its own sake.

### Sidebar

Both clients have one left sidebar. On the App it is a drawer at compact widths
and a tiled column in landscape. On Web it is `shell/Sidebar.tsx`, on every page:

| State | Web |
| --- | --- |
| Expanded | Default 300px, 180..480 resizable. Brand row, New chat, then `text-sm` rows for Tasks, Kanban, Skills, Memory and Insights in that order, then a `More` disclosure (Discussions, Todos, Decisions, enabled extensions and the dashboard), a Quotas group for up to two pinned provider quota sources (the server's `sidebar_source_ids`, absent when none is pinned or listed), the Chats panel, and a footer with the Settings row and icon-only Feedback and Notifications. Above the footer, when the server has no password and the session can manage it, a `No password` row in the error colour links to Settings › Access; once `auth_disabled_acknowledged` is on it is a warning-coloured icon with a tooltip, and it stays while auth is off. The panel scrolls; everything above it stays put |
| Collapsed | A 64px icon rail, each icon over its caption, in the expanded order: brand, Chat, Tasks, Kanban, Skills, Memory, Insights, then Discussions, Todos, Decisions, extensions and the dashboard, with the no-password warning, Feedback, Alerts and Settings pinned at the bottom. It never collapses to nothing. The panel stays mounted, hidden and out of the tab order, so it keeps its state |
| Toggles | The edge tab and ⌘B write `hermes-webui-sidebar-collapsed`, the one stored choice, which applies on every page, Settings included. No page collapses it by itself |
| Chats heading | A §4 `h3` with the selected project's name as its trailing detail, then the search symbol and one `SessionFilterMenu` trigger at its right, the App's `SessionFilterControls`: source (when CLI sessions exist), projects with New project, the selected project's actions in a submenu, Show archived and Import session. The icon takes the accent state and its `aria-label` says so when a filter differs from its default. It is built from `FilterMenu` (`web/packages/frontend/src/shell/FilterMenu.tsx`), the one filter control every Web page uses, Kanban's toolbar included |
| Search | A `search` symbol on the Chats and Settings title rows opens the field in that row: it grows from the symbol across the row, with an `x` that closes it, on the column's own surface with no box behind it. The title and the symbol hide while it is open; the Chats filter trigger stays visible and usable. The `x`, Escape on an empty field or focus leaving the empty field clear and close it. It is `PanelSearch` (`web/packages/frontend/src/shell/PanelSearch.tsx`), the one component for a panel head's search. Neither rail has a search control |
| Motion | One set of rows morphs between both states, never a crossfade of two layouts: width, padding and row height run together on one 200ms linear clock, icons stay in place, labels and captions trade places, and rows only one state has close to nothing. The chat list holds its width and fades, so it never squeezes. Applies from 641px; reduced motion is instant |
| 641–900px | The rail stays tiled. Its hamburger and ⌘B open the expanded panel over the page with a scrim, without touching the stored choice. Esc, the scrim and choosing a row close it |
| 640px and below | The expanded content in a full-width drawer, no icon strip; the bottom `Tabbar` stays |
| Settings | Swaps the column's content to a Back row and the section list, in place of the brand, New chat, destinations, chat list and footer. Back returns to the last location outside Settings, or `/` after a direct load. The edge tab and ⌘B collapse it by the same stored choice to a rail of Back and the sections, each icon over its caption, with a separator between groups; three captions are short forms (Appear., Notifs, Nav) because the labels do not fit, and each row's accessible name stays the full label. The section rows are sidebar rows, so they morph like every other page's; the head with its search and the group headers fold away on the rail. Tiled from 641px, expanded at 641–900px; the same content in the drawer at 640px and below. A panel rather than the App's modal, because the page has room and `/settings/$section` deep links stay. The list falls into three groups, each under a `SectionHeader`, in the order and membership the contract's `SETTINGS_SECTION_GROUPS` gives: Interface (this interface's preferences), Profile (the active profile's configuration, the header naming that profile as its detail, a link to that profile's page in Profiles) and Server (what applies to the whole server: Profiles, Spaces, Extensions, Access, System, Logs and About). Profiles, Spaces and Logs are hub pages shown as Server sections: the section heading replaces the page header and carries the page's help and actions, and `/profiles`, `/workspaces` and `/logs` redirect to `/settings/<id>` |
| Surface | One surface on `--rail-bg`, with `--rail-active-*` on the active row in both states and one pair of corner seams against the page. Destinations live in `SIDEBAR_PRIMARY` and `SIDEBAR_MORE` (`shell/nav.ts`); `hidden_tabs` filters them all |

## 3. Lists and rows

| Rule | App | Web |
| --- | --- | --- |
| List | `.listStyle(.plain)`; `SidebarList` (`Features/Shared/SidebarKit.swift`) for section lists that need row-height 0 | `RowList` (`ui/List.tsx`): `<ul className="flex flex-col">` |
| Row insets | `.listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 10, trailing: 20))`; compact rows 8/20 | `Row` (`ui/List.tsx`): `<li className="flex flex-col gap-4 border-t border-border py-4 first:border-t-0">`; `Row compact`: `border-border-subtle py-2 text-xs` |
| Separator | The list's own hairline; hidden on non-row content | `border-t border-border` between items, `border-border-subtle` inside an item |
| Row header line | `HStack(alignment: .firstTextBaseline, spacing: 8)`: icon 20pt, name `.headline`, chips, `Spacer`, progress or chevron `.footnote.weight(.semibold)` tertiary | `flex flex-wrap items-baseline gap-x-2 gap-y-1`: name `text-sm font-semibold text-text`, chips, status text |
| Row body | `VStack(alignment: .leading, spacing: 12)` of blocks, 14 between repeated items (windows); inside a block `spacing: 6` | `flex flex-col gap-1.5` per block |
| Tappable row | `Button(action:)` with `.buttonStyle(.plain)` and `.contentShape(Rectangle())`; identifier `<entity>-row-<id>` (`provider-quota-row-<id>`) | A plain `li` with `data-<entity>-<thing>="<id>"` (`data-quota-source`); when a Web row opens a detail, the row header is the link |
| Item actions | `.swipeActions(edge: .trailing)` for the destructive or hide action (`.tint(.orange)` for hide), `.contextMenu` with every action | `ContextMenu` (`ui/Menu.tsx`) with every action once a row has any (`web/docs/UIUX-GUIDE.md`, "Context menus"); the visible trigger shows the same items. Insights rows have no Web actions yet |
| Reordering | `.onMove` under an edit mode the toolbar toggles; order is a device setting | Not shipped; when added, a drag handle per row and the order kept per browser through `lib/persisted` |
| Grouping | A second `Section("…")` for items without data ("No quota data"), compact rows | A second `<section data-section="<feature>-unavailable">` with an `h3` header, compact rows |

Settings rows follow §12.

## 4. Section headers

| App | Web |
| --- | --- |
| `Text(title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)`, optional trailing detail `.footnote` secondary, optional small `ProgressView`; `.padding(.horizontal, 20).padding(.vertical, 6)`, `listRowInsets(EdgeInsets())`, system background (`PlainSectionHeader` in `Features/Shared/PlainSectionList.swift`; the detail screen and the "No quota data" section retain their default `Section` headers) | `SectionHeader` (`ui/List.tsx`), whose `SECTION_HEADER` is the only definition of the style: `<h3 className="text-sm font-semibold text-strong">` in sentence case, no uppercase or tracking, so it reads above the rows under it; optional trailing `detail` `text-xs font-normal text-muted tabular-nums`, optional `action` at the right (a `ghost` `IconButton`, §12). On a Settings page 30px separate one group from the next header (`SETTINGS_PAGE`). The page section title is `<h2 className="text-base font-semibold text-text">` with the primary action beside it |

The trailing detail is live data (a peak, a count), never an explanation.

## 5. Figures, meters and cells

| Element | App | Web |
| --- | --- | --- |
| Headline figure | `.font(.title2.weight(.semibold).monospacedDigit())`, mode word `.caption` secondary beside it, `.lastTextBaseline` aligned | `text-lg font-semibold tabular-nums text-strong`, mode word `text-xs text-muted`, `items-baseline` |
| Stat grid | `InsightsStatGrid`: `.adaptive(minimum: 140)` columns, title `.caption` secondary, value `.title3.weight(.semibold)` | `<dl className="grid grid-cols-2 sm:grid-cols-4">`, `StatLabel` (`ui/List.tsx`) `dt text-xs uppercase tracking-wider text-muted`, `dd text-lg font-semibold text-strong` with the exact value in `title` |
| Page figures | Pending the App sync (TAL-1695) | `SettingsStats` (`features/settings/SettingsGroup.tsx`), the stat grid for a Settings page: two columns, four once its column is 521px wide; each value a `Figure` with an optional mode word, `tone="warning"` or `"error"` when the server marks it. Every value is a server field the page only formats |
| Row figure | `.title3.weight(.semibold).monospacedDigit()` at the row's trailing edge | `Figure` (`ui/List.tsx`) at the end of a row: one headline figure and its mode word ("21% left"), the classes of the headline figure above |
| Metric cell | `ProviderQuotaMetricCell(title:value:)` (`Models/ProviderQuotaForecastView.swift`): title `.caption2` secondary, value `.caption.weight(.semibold).monospacedDigit()`, padding 8/6, `.secondary.opacity(0.1)` fill, radius 9, one accessibility element "title, value" | `MetricCell` (`ui/List.tsx`): `rounded-md bg-hover px-2 py-1.5`, label `text-[11px] text-muted`, value `text-xs font-semibold tabular-nums text-text` |
| Meter | `ProgressRailView(percent:markerPercent:tint:height:)` (`Models/ProgressRailView.swift`): height 3 default, 8 for a window, 4 for a share; track `.secondary.opacity(0.18)`; marker 1.5pt primary | `QuotaMeter` (`features/insights/QuotaMeter.tsx`): `<div role="meter" aria-valuemin aria-valuemax aria-valuenow aria-label>` `relative h-2 overflow-hidden rounded-full bg-border`, fill `h-full rounded-full` + level class, marker `absolute inset-y-0 w-px bg-text` |
| Meter tint | The server level through `ProviderQuotaWidgetPalette.arcColor` (healthy accent, warning orange, critical red, user-overridable); stale and unavailable orange | `LEVEL_FILL`: `healthy bg-accent`, `warning bg-warning`, `critical bg-error`, `stale`/`unavailable bg-muted` |
| Forecast line | Reset label left (`.caption` secondary), forecast `Label` right tinted `ProviderQuotaForecastOutcome.tint` (safe green, warning orange) | Reset left, forecast right, `text-warning` only when warning, `data-forecast` |
| Share rail | `ModelBreakdownRow`: `ProgressRailView(height: 4)` under the row | `QuotaMeter thin` (`METER_RAIL_THIN`): 4px tall and 84px wide at the end of a row, beside its figure |

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
| Plan or kind chip | `.caption2.weight(.medium)` secondary in a row, `.caption.weight(.medium)` in a detail header, padding 7/3, `Capsule().fill(Color(.tertiarySystemFill))` | `Badge tone="border-border text-muted"`, outside Settings, Profiles, Spaces, Logs and Connectors; there the word leads the row's second line instead |
| Active or selected mark | `checkmark.circle.fill` `.caption.weight(.semibold)` green with an accessibility label in a row; a `Label` with the same icon in a detail header | `Mark` (`ui/Badge.tsx`): a 13px check and one or two words in `text-accent-text`, no border, no fill; without words, the bare check on a control whose `aria-pressed` already names the choice (a theme tile, a skin row) |
| Status text | `.footnote` secondary beside a 7pt dot (green available, orange stale, red failed); retry notes `.caption` orange | `StatusDot` (`ui/Badge.tsx`): a 7px dot (`ok`, `warning`, `error`, `idle`, `changed`) and its words in `text-xs text-muted`; the dot alone takes the state colour. Words truncate to one line; `wrap` keeps words that must be read whole (what an extension can access) on more lines. Green text is never a state (`success-text` rule). `Dot` is the dot alone, before words that keep their own colour. The System update timeline is not `StatusDot`: its nodes are its own 11px ring marks on an accent or neutral path line, and its newest node's status line takes the node's colour (`accent-text` for an update, `warning` for a warning or failed check); leave both as they are (TAL-2182) |
| Second line | `.footnote` secondary under the name | `text-xs text-muted`, one truncated line with the full text in `title`; a state leads it as a `StatusDot`. No `text-[11px]` and no coloured state text without a dot in Settings, Profiles, Spaces, Logs and Connectors |
| Freshness | "Updated 3 min ago" `.caption2` secondary, clamped so a future timestamp reads as now | `As of … · Last checked …` `text-xs text-muted`, `text-warning` when stale |

Chips carry one or two words. A chip never carries a sentence or a number
that belongs in a figure.
A chip never squeezes a row's name: in a row narrower than 641px the chip
text moves to the start of the description line (`SkillRow`).

## 8. States

| State | App | Web |
| --- | --- | --- |
| Loading | A small `ProgressView` in the section header or toolbar; existing rows stay | `LoadingState` (`compact` when a heading is already on screen); existing rows stay |
| Refreshing | `ProgressView().controlSize(.small)` in the row header of the item being refreshed | The section's refresh `Button` is disabled and reads "Refreshing…" |
| Empty | A `ContentUnavailableView` or one caption row with the server's reason | `EmptyState` with the server's reason; inside a Settings group `EmptyState compact`, one muted line with no frame and an optional trailing `action` |
| Error | `ContentUnavailableView` with the server's message and "Try Again" when nothing loaded; a tinted toolbar button with a popover when rows exist | `ErrorState` with `onRetry`, or with an alert's own wording and actions as `children`; an alert that asks for nothing is plain text with its `role`; never a blank pane |
| Unavailable items | Grouped below the data rows under a header, one line each: name and reason | The `-unavailable` section with compact rows |

`EmptyState` and `ErrorState` keep their dashed or alert frame because they
ask for an action. No other state wears a frame; `EmptyState compact` has none.


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
| Time and locale | `Date.FormatStyle(locale:timeZone:)` from the `\.locale` and `\.timeZone` environment so tests pin UTC and `en_US` (the daily chart's axis and values still use bare `.dateTime`, see §15) | `Intl` with the viewer's locale from `useLocale` |

## 11. Where things go

Decide an item's home before building it:

| Rule | Reason |
| --- | --- |
| A top-level destination is content the user works in: Chat, Tasks, Kanban, Skills, Memory, Insights, Discussions, Todos, Decisions. Configuration, credentials and diagnostics are Settings sections | The sidebar lists places to work; setup and diagnostics are visited rarely and belong together |
| Settings sections are grouped by scope, and the grouping is a contract (`SETTINGS_SECTION_GROUPS` in `web/packages/contracts/src/settings-sections.ts`): **Interface** is how Talaria looks and behaves (the server's `settings.json` or the browser); **Profile** is read from or written to the active profile's home (its `config.yaml`, `.env`, or a per-profile setting); **Server** applies to every profile on the server | The group says what a change affects before the user makes it, and both clients read the same grouping |
| A setting has exactly one home. The same control never appears on two pages | Two copies drift apart and leave the user unsure which one wins |
| A group is titled for what its rows control ("Theme", "When a reply finishes", "Voice on this device"); where a setting is stored is its `scope` in `settingsIndex.ts` | The approved Settings designs (TAL-2146) group by subject; storage follows the §11 section group |
| A per-chat composer control whose default is configurable has that default in Settings (Chat when it is an interface setting, the Profile group when it is profile configuration), never only in the composer | The composer changes one chat; the default needs a home that outlasts it |
| A new setting goes in an existing group of an existing section. A new group needs at least two rows. A new section needs at least five rows that fit no existing section, and is added to `SettingsSectionSchema` with its group | Small groups and sections fragment Settings into pages that hold one switch |
| A group holds at most eight rows; a longer one is split by what the rows affect | A long group hides the row the user came for |
| A page over about 20 rows moves its rarely changed rows to a named sub-page (`settings/<section>/<page>`) behind a `SettingLink` row that counts them; the sub-page has the back link and title of a provider's own page | A long page buries the settings people change behind the ones they never touch |
| A set of show/hide switches for one visible component (the composer's controls, the sidebar's items) is edited on a drawing of that component, each part a `PreviewToggle` (`features/settings/PreviewToggle.tsx`) with `aria-pressed`, which owns the hidden style | The user sees what each switch hides instead of picturing a control from its name |

## 12. Settings and forms

A Settings page is the section heading (`SettingsSection`) and a column of
`SettingsGroup`s (`SETTINGS_PAGE`); every row is inside a group. Pages import their rows from
`web/packages/frontend/src/features/settings/SettingsRows.tsx` (or, for a page
that reads no server setting, `SettingsGroup.tsx`) and write no layout classes.
The content column is 640px wide at most, so a label stays near its control;
Logs keeps the wider column its lines need.

| Need | App | Web |
| --- | --- | --- |
| A titled group of rows | Pending the App sync (TAL-1695) | `SettingsGroup` (title is a noun; optional live `detail`, optional `action`) |
| On or off, server setting | Pending the App sync (TAL-1695) | `SettingToggle` |
| One of two to four values with short labels | Pending the App sync (TAL-1695) | `SettingSegmented` (`ui/Segmented.tsx`: a `radiogroup`, one Tab stop, arrow keys move the selection, the selected option filled; it moves under its label when the column is too narrow for both); a browser-stored choice is a `Segmented` in a `SettingRow`. An option may be drawn (`display`, "Aa" at a font size) with its words as its name |
| One of a few named values | Pending the App sync (TAL-1695) | `SettingSelect` |
| An integer in a range | Pending the App sync (TAL-1695) | `SettingNumber` |
| Free text or a list of lines | Pending the App sync (TAL-1695) | `SettingText` (the only row with a Save button, shown while the draft differs); a rarely edited list is closed behind its count (`summary`, TAL-2143) and opens in place |
| A control stored in this browser | Pending the App sync (TAL-1695) | `SettingRow` wrapping the control |
| A row whose control is a button | Pending the App sync (TAL-1695) | `SettingAction` (danger styling on the button, never on the row) |
| A row that opens a page or dialog | Pending the App sync (TAL-1695) | `SettingLink` (external pages open in a new tab; a sub-page row names its row count in `detail`) |
| Installed versions | Pending the App sync (TAL-1695) | `SettingsStats` figures |
| Read-only values (keyboard shortcuts) | Pending the App sync (TAL-1695) | `SettingValue` rows with an `icon` in one `SettingValues` list; keys as `Keys` (`ui/Keys.tsx`) keycaps, the modifier ⌘ on Apple platforms and Ctrl elsewhere |
| A continuous value | Pending the App sync (TAL-1695) | `Slider` in a `SettingRow`, with its value shown in tabular digits |
| A visual choice (theme) | Pending the App sync (TAL-1695) | Preview tiles, the selected one with the accent border and a bare `Mark`; these tiles are the only bordered shapes on a Settings page |
| One of many named looks (skins) | Pending the App sync (TAL-1695) | Rows in a column grid (three columns from 601px, two below): colour dots, name, a bare `Mark` on the selected one |
| A list of things with their own actions (providers, plugins, profiles) | Pending the App sync (TAL-1695) | `RowList` and `Row` (`ui/List.tsx`) with a `ContextMenu`, per §3 |
| More than twelve list items | Pending the App sync (TAL-1695) | One filter input above the list; the filter is device-local state |
| A provider or profile in a row or header | Pending the App sync (TAL-1695) | `Monogram` (`ui/Monogram.tsx`): its first letter on a 30px square (24px `sm`) on `bg-hover` |
| The one choice a page is about (the main model) | Pending the App sync (TAL-1695) | `SettingHeadline`: the provider's `Monogram`, the name in `text-xl font-semibold text-strong`, a muted second line, and its change action (a `default` `IconButton`) at the right |
| Many items that share one setting (task models) | Pending the App sync (TAL-1695) | A two-column `<table>` (Insights' model table): one line per item, the name led by a `Dot` (`changed` accent when set apart from its default, else `idle`), the value right-aligned and truncating first; the item's button in the first cell carries `aria-expanded` and its editor opens in the table row under it |

- A label names the thing controlled (§9).
- An explanation goes in `hint`, which renders a `HelpTip`, never as text
  under the row. A row's state (a permission, a subscription) is its
  `detail`, the one-line second line, led by a `StatusDot` (§7).
- A row may take an `icon` (a lucide component), drawn 18px in `text-muted`
  before its label; every kit row accepts it.
- A sub-option that applies only while the row above is on is a `SettingToggle`
  with `indent` directly under that row: no icon, its label under the row's
  label, disabled while the row above is off (TAL-2159).
- Every write is optimistic with rollback through `useSettingField`; no page
  has a page-level Save.
- A row the server did not send a field for is not rendered.
- An owner-only control is disabled for others through the existing
  `can_manage_server` gate.
- No `<h2>` to `<h6>`, no raw `FieldRow` and no card container on a Settings
  page.
- Every Web row has one entry in
  `web/packages/frontend/src/features/settings/settingsIndex.ts` (its control
  id, label and group message functions, and storage scope), which the
  sidebar search lists. `settingsIndex.test.tsx` fails when a row has no entry,
  or when its scope does not match the section's §11 group.

### Buttons are symbols

In Settings, Profiles, Spaces, Logs and Connectors a button shows a lucide
symbol and no words. Words stay only on a dialog's confirm and cancel buttons,
inside a `DialogFooter` (`ui/Dialog.tsx`), and inside segmented controls. The
`word-button` UI rule fails on any other `<Button>` there.

| Variant | Web (`IconButton`, `ui/Button.tsx`) | Use |
| --- | --- | --- |
| `default` | 32px square, hairline border | A row's or form's action |
| `primary` | Accent fill | The one main action of a page, in its header |
| `ghost` | No border, muted | Header and group-header actions, row menus |
| `danger` | No border, error colour | Remove, delete, uninstall, disconnect |

Every icon button has an `aria-label` and the shared `Tooltip` with the same
words, and grows to a 44px target under a coarse pointer. A row's actions use
`RowActionButtons` (`ui/RowActionsMenu.tsx`) over the same `RowAction` list
its `RowContextMenu` shows with words. A link that looks like one (Open,
Authorize) uses `iconButtonClass` inside the `Tooltip`. The action's words are
its accessible name and tooltip; its symbol comes from this table, and an
action not in it gets a row here in the same change:

| Action | Icon | Action | Icon |
| --- | --- | --- | --- |
| Add, new, register | `plus` | Refresh, check now, retry | `refresh-cw` |
| Update, update all, apply an update | `circle-arrow-up` | Install, import | `download` |
| Edit, change, replace, choose | `pencil` | Remove, delete, uninstall | `trash-2` |
| Save, set, submit, approve | `check` | Copy | `copy` |
| Settings of an item | `settings-2` | More actions | `ellipsis` |
| Open | `arrow-up-right` | Set key | `key-round` |
| Sign in, authorize | `log-in` | Set up | `wrench` |
| Use this profile | `arrow-left-right` | Restart | `rotate-cw` |
| Stop, shut down | `power` | Reset, restore the default | `rotate-ccw` |
| Play, preview | `play` | Back, previous page | `chevron-left` |
| Sign out, log out | `log-out` | Clear, unset, cancel an inline form | `x` |
| Set as default | `circle-check` | Search | `search` |
| Browse the catalog | `store` | Details | `info` |
| First page | `chevrons-left` | Next page | `chevron-right` |
| Connect | `plug` | Disconnect | `unplug` |
| Continue | `arrow-right` | Skip | `skip-forward` |
| Summarize | `sparkles` | Attach | `paperclip` |
| Show more | `chevron-down` | Show less | `chevron-up` |
| Stop playing | `square` | Close a docked panel | `x` |
| Collapse a docked panel to its header | `chevron-down` | Expand a collapsed panel | `chevron-up` |

## 13. Menus


Menus are interaction surfaces (§14); every Web menu is built with `Menu` from
`web/packages/frontend/src/ui/Menu.tsx`.

| Rule | App | Web |
| --- | --- | --- |
| Row style | Pending the App sync (TAL-1695) | `MENU_ROW`; choices use `MenuChoiceItem` and `MenuChoiceCheckbox` |
| First row | Pending the App sync (TAL-1695) | A `MenuGroupLabel` naming what the menu sets |
| Choose one | Pending the App sync (TAL-1695) | `MenuChoiceItem` in a `MenuRadioGroup`; selecting applies at once and closes |
| Choose several | Pending the App sync (TAL-1695) | `MenuChoiceCheckbox`; toggling applies at once and the menu stays open |
| Selected mark | Pending the App sync (TAL-1695) | A trailing check from the shared row; colour alone never carries the state |
| Unavailable option | Pending the App sync (TAL-1695) | Disabled, with the server's reason in muted text at the right |
| Grouping | Pending the App sync (TAL-1695) | `MenuGroup` with a `MenuGroupLabel`, by a server field |
| Long lists | Pending the App sync (TAL-1695) | A pinned search header above twelve items |
| Destructive item | Pending the App sync (TAL-1695) | Last, after a `MenuSeparator`, in `text-error` |
| Never in a menu | Pending the App sync (TAL-1695) | A form, a Save button, a native checkbox or radio, explanatory sub-text |
| Composer menus | Pending the App sync (TAL-1695) | `ComposerMenu` (`features/composer/chips.tsx`): open upward at one width; at 640px and below span the composer's width |

## 14. Exceptions

| Surface | Rule | Owner |
| --- | --- | --- |
| Chat transcript (bubbles, tool and thinking rows, worklog) | Keeps its conversation hierarchy | `web/DESIGN.md`, `web/docs/UIUX-GUIDE.md`; the App mirrors Web's transcript |
| Composer | The one floating card | `web/docs/UIUX-GUIDE.md`, "Composer and controls" |
| Kanban | Cards stay because it is a board; their chrome (type, chips, spacing, colours) follows this document | TAL-1769 |
| Dialogs, menus, popovers, sheets | Interaction surfaces, not content containers. Web motion comes only from `ui/popupMotion.ts`: every Base UI popup and backdrop uses its shared classes, opens slower than it closes, takes clicks from the first frame, and only fades under reduced motion | Platform defaults |
| Widgets and Live Activities | System layouts with the shared meter and palette | `app/Talaria/Models/ProviderQuotaWidget*.swift` |
| Paged dialogs (What's New) | Four items a page, every page the height of the tallest. One centred line between the items and the primary action holds a `chevron-left` arrow, one dot per page (an indicator, never a control, the current one in the accent) and a `chevron-right` arrow; an arrow at either end stays focusable but does nothing. The primary action keeps its label, turns the page and closes on the last page. A one-line muted text skip action under it closes the dialog from every earlier page; the last page keeps its space empty | App `WhatsNewSheet`; Web `WhatsNewDialog` (`features/whats-new/WhatsNew.tsx`) |

## 15. Known deviations

The rules win; these spots still differ and are owned.
`web/packages/frontend/scripts/ui-rules-baseline.json` is the machine-readable
list of the Web violations that remain.

| Deviation | Owner |
| --- | --- |
| The App detail screen and the "No quota data" section use default `Section` headers instead of the uppercase header | TAL-1765 |
| The App daily chart formats dates with bare `.dateTime`, not the environment locale and zone | TAL-1765 |
| Stale and unavailable meters are orange on the App (palette default) and muted on Web | Decide with TAL-1533 (server-owned presentation state) |
| Web Settings pages not yet on the kit (§12) | TAL-2077 (Providers), TAL-2079 (Notifications, Speech), TAL-2082 (Plugins) |
| The App Settings root is not grouped by scope (§11, §12) | TAL-1695 |

## 16. Checklist for a UI change

1. Decide the item's home with §11 before building.
2. Find the Insights row or section that shows the same kind of thing and
   start from its structure and components.
3. No new container: if the design needs a box, it needs a section header or a
   metric cell instead.
4. Build Web Settings rows only from `SettingsRows.tsx` or `SettingsGroup.tsx`
   and menus only from `ui/Menu.tsx`.
5. Every value shown is a contract field; every colour is a server level.
6. Headline figure, label, unit; tabular digits; exact value reachable.
7. Actions on the item (swipe, context menu) and in the toolbar; nothing waits
   for the server to reflect a choice (root `AGENTS.md`, "Optimistic writes").
8. Identifiers and `data-*` hooks follow the naming above; a hosted test or
   component test reads them.
9. Screenshots at phone width (390pt) and desktop in the PR; status copy on
   one line.
10. For a Web change, run `npm run lint -w packages/frontend` from `web/` (it
    ends with the UI rules check) and attach the demo tour's screenshots
    (`web/TESTING.md`) of each touched page at desktop and 390px, at the five
    iPhone Duo viewports (outer portrait 382×580, outer landscape 594×368,
    inner portrait 669×867, inner landscape 951×585, inner split 385×571),
    and in the light theme at desktop and 390px.
