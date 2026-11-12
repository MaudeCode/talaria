import SwiftUI
import TalariaKit

struct SettingsCategoryPage<Content: View>: View {
    @Environment(ServerSettingsStore.self) private var settingsStore: ServerSettingsStore?
    let category: SettingsCategory
    @ViewBuilder let content: Content

    init(category: SettingsCategory, @ViewBuilder content: () -> Content) {
        self.category = category
        self.content = content()
    }

    var body: some View {
        SettingsPage(title: category.title, indexPage: .category(category)) {
            content
            if let error = settingsStore?.errorMessage { SettingsErrorFootnote(SettingsErrorText(error)) }
        }
    }
}

struct SettingsPage<Content: View>: View {
    let title: String
    let indexPage: SettingsPane?
    @ViewBuilder let content: Content
    @Environment(\.settingsScrollAnchor) private var scrollAnchor
    @State private var revealedTarget: String?

    init(title: String, indexPage: SettingsPane? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.indexPage = indexPage
        self.content = content()
    }

    var body: some View {
        ScrollViewReader { proxy in
            SidebarList {
                content
            }
            .environment(\.settingsIndexPage, indexPage)
            .environment(\.settingsIndexSection, nil)
            .task(id: scrollAnchor) {
                guard let identifier = scrollAnchor?.identifier else { return }
                await Task.yield()
                proxy.scrollTo(identifier, anchor: .center)
            }
            .onPreferenceChange(SettingsIndexedRowsKey.self) { identifiers in
                guard let entry = scrollAnchor?.entry, revealedTarget != entry.id,
                      let target = identifiers.contains(entry.id) ? entry.id : identifiers.first(where: entry.owns(identifier:)) else { return }
                proxy.scrollTo(target, anchor: .center)
                revealedTarget = entry.id
            }
        }
        .navigationTitle(title)
        .adaptiveSecondaryNavigationTitle(title: title)
    }
}

extension EnvironmentValues {
    @Entry var settingsIndexPage: SettingsPane?
    @Entry var settingsIndexSection: String?
    @Entry var settingsScrollAnchor: SettingsScrollAnchor?
}

private struct SettingsIndexedRowsKey: PreferenceKey {
    static let defaultValue: Set<String> = []
    static func reduce(value: inout Set<String>, nextValue: () -> Set<String>) { value.formUnion(nextValue()) }
}

/// Adds search anchors to the existing row kit, including unindexed rows for the hosted drift guard.
private struct IndexedSettingsRow: ViewModifier {
    let title: String
    let identifier: String?
    @Environment(\.settingsIndexPage) private var page
    @Environment(\.settingsIndexSection) private var section

    func body(content: Content) -> some View {
        if let page {
            let entry = identifier.flatMap { id in SettingsIndex.allCases.first { $0.page == page && $0.owns(identifier: id) } }
                ?? SettingsIndex.row(title: title, page: page, section: section)
            let id = identifier ?? entry?.id ?? "settings-unindexed-\(title)"
            content
                .id(id)
                .accessibilityIdentifier(id)
                .preference(key: SettingsIndexedRowsKey.self, value: [id])
        } else if let identifier {
            content.accessibilityIdentifier(identifier)
        } else {
            content
        }
    }
}

extension View {
    func indexedSettingsRow(title: String, identifier: String? = nil) -> some View {
        modifier(IndexedSettingsRow(title: title, identifier: identifier))
    }
}
