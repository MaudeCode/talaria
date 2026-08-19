# iOS 26 Liquid Glass navigation research

Research date: 2026-08-19

## Bottom line for Talaria

Talaria already uses the right foundation: a semantic SwiftUI `TabView` with
`Tab` children and native `NavigationStack` / `NavigationSplitView` containers.
Those standard components acquire the current Liquid Glass appearance when the
app is built with the latest SDK. The missing iPhone behavior is tab-bar
minimization, which Apple makes an explicit opt-in.

The smallest current-feeling navigation update is:

1. Add `.tabBarMinimizeBehavior(.onScrollDown)` to the root `TabView` on iOS 26
   and newer. It minimizes rather than fully hiding the bar, then expands when
   scrolling reverses, a tab is tapped, or the scroll view returns to the top.
2. Keep Chats, Tasks, Kanban, and More as the four top-level destinations.
3. Keep each tab's navigation state while switching tabs. Apple describes this
   as a core tab-bar behavior, so an open chat should remain open when someone
   visits another tab and returns.
4. Do not paint a custom glass background behind the tab bar. Let SwiftUI own
   its material, contrast, and scroll-edge treatment.

Apple's [`TabBarMinimizeBehavior`](https://developer.apple.com/documentation/swiftui/tabbarminimizebehavior)
documentation says minimization is supported only on iPhone. Its `automatic`
behavior does **not** minimize on iOS, so Talaria must choose `onScrollDown`
explicitly. Apple demonstrates this exact modifier in
[Build a SwiftUI app with the new design](https://developer.apple.com/videos/play/wwdc2025/323/?time=181).

## What arrives automatically

Apple recommends starting with standard framework components. When an existing
app is rebuilt with the latest SDK, standard SwiftUI controls and structures
pick up the new shapes, sizing, materials, and system behaviors. `TabView`,
`NavigationSplitView`, sheets, and toolbars are specifically called out as
refined structures in iOS 26. See
[Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)
and the [WWDC25 SwiftUI walkthrough](https://developer.apple.com/videos/play/wwdc2025/323/?time=168).

Talaria's root in `HermesMobile/ContentView.swift` already uses the modern
`Tab("Chats", systemImage:value:)` form. No custom tab-bar implementation or
manual `.glassEffect` is needed. The local project targets iOS 18, so any iOS 26
modifier needs an availability branch even though the current development
toolchain is newer.

## Tab-bar behavior and semantics

Apple's [Tab bars HIG](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
defines tabs as persistent navigation between top-level sections, not actions.
It also says switching sections preserves the current navigation state within
each section. This supports Talaria's current behavior:

- Chats list -> another tab -> Chats returns to the list.
- Open chat -> another tab -> Chats returns to that chat.
- New Chat remains an action, not a fifth tab.

On iPhone, the iOS 26 bar floats over content. With `onScrollDown`, it contracts
as someone scrolls down and re-expands in the opposite direction. This is the
native replacement for custom show/hide-on-scroll logic.

## Search

Apple presents two distinct patterns in
[Build a SwiftUI app with the new design](https://developer.apple.com/videos/play/wwdc2025/323/?time=670):

- For search scoped to a page or hierarchy, apply `.searchable` to that native
  navigation container. On iPhone, iOS 26 places the search experience near the
  bottom; iPad and Mac adapt it to the top trailing area.
- For search that is genuinely a top-level app destination, use
  `Tab(role: .search)` and place `.searchable` on the `TabView`. The Search tab
  appears separately and morphs into the search field. The
  [`TabRole.search`](https://developer.apple.com/documentation/swiftui/tabrole/search)
  documentation describes how the search role is selected.

Talaria's current search filters chat sessions, so it should remain scoped to
Chats. Replacing the custom expanding search capsule in
`HermesMobile/Features/SessionList/SessionListView.swift` with native
`.searchable` would be the more current follow-up. A dedicated Search tab only
makes sense if Talaria later searches across sessions, tasks, memory, and other
top-level content.

## Sidebar-adaptable tabs and split navigation

The [sidebar-adaptable tab style](https://developer.apple.com/documentation/swiftui/tabviewstyle/sidebaradaptable)
keeps a bottom tab bar on iPhone, but becomes a top tab bar that can adapt into
a sidebar on iPad. Apple's
[tab-navigation sample](https://developer.apple.com/documentation/swiftui/enhancing-your-app-content-with-tab-navigation)
positions it as a cross-platform navigation tool for richer hierarchies.

Talaria is currently an iPhone app, so `.sidebarAdaptable` adds no immediate
iPhone benefit and is not required for Liquid Glass or minimization. Adopt it
when iPad becomes a supported product surface, not merely for visual novelty.

The existing navigation-container choice is also current:

- [`NavigationStack`](https://developer.apple.com/documentation/swiftui/navigationstack)
  is the native single-column push model used on compact iPhone layouts.
- [`NavigationSplitView`](https://developer.apple.com/documentation/swiftui/navigationsplitview)
  is the native list/detail model for regular widths and can collapse to a stack
  in narrow layouts.

There is no Liquid Glass reason to replace either container or introduce a
custom router.

## Toolbars and actions

System toolbar items automatically receive Liquid Glass, grouping, and a scroll
edge effect. Apple advises removing custom backgrounds or darkening behind bars
because they interfere with that effect. Related actions should be represented
as native toolbar items and separated into meaningful groups; iOS 26 adds
[`ToolbarSpacer`](https://developer.apple.com/documentation/swiftui/toolbarspacer)
for explicit breaks. Apple also recommends monochrome toolbar symbols by
default, with tint reserved for a meaningful primary action. See the
[Toolbars HIG](https://developer.apple.com/design/human-interface-guidelines/toolbars)
and [WWDC25 toolbar guidance](https://developer.apple.com/videos/play/wwdc2025/323/?time=469).

For Talaria:

- New Chat is contextual to Chats, so it belongs in Chat content or a standard
  compose toolbar item. It should not become a tab-bar item or bottom accessory.
- The chat detail's custom action cluster already avoids a second glass capsule
  on iOS 26. A later cleanup can expose its actions as separate toolbar items so
  SwiftUI, rather than an `HStack`, owns their grouping.
- [`tabViewBottomAccessory`](https://developer.apple.com/documentation/swiftui/view/tabviewbottomaccessory%28content%3A%29)
  is intended for persistent, app-wide controls such as media playback. Talaria
  has no current feature that needs it.

## Recommended order

1. **Now:** opt the root tab view into `.onScrollDown` minimization and verify
   Chats, Tasks, Kanban, and More each trigger it from their primary scroll view.
2. **Next:** replace the custom Chats search chrome with native `.searchable`.
3. **Then:** audit custom toolbar grouping/backgrounds, especially chat-detail
   actions, and let iOS 26 own the glass surfaces.
4. **Later, only with iPad scope:** adopt `.sidebarAdaptable` and validate the
   list/detail experience at regular widths.

This order gains the recognizably current iOS 26 navigation behavior without a
navigation rewrite or a custom Liquid Glass layer.
