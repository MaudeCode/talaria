import SwiftUI

enum SettingsCategory: String, Identifiable {
    case appearance
    case notificationsAndHaptics
    case chats
    case liveActivitiesAndWidgets
    case siriAndShortcuts
    case servers
    case providers
    case dataAndStorage
    case about
    case developer

    var id: String { rawValue }

    static var rootCategories: [Self] {
        var categories: [Self] = [
            .appearance,
            .notificationsAndHaptics,
            .chats,
            .liveActivitiesAndWidgets,
            .siriAndShortcuts,
            .servers,
            .providers,
            .dataAndStorage,
            .about
        ]
        #if DEBUG
        categories.append(.developer)
        #endif
        return categories
    }

    var title: String {
        switch self {
        case .appearance: String(localized: "Appearance")
        case .notificationsAndHaptics: String(localized: "Notifications & Haptics")
        case .chats: String(localized: "Chats")
        case .liveActivitiesAndWidgets: String(localized: "Live Activities & Widgets")
        case .siriAndShortcuts: String(localized: "Siri & Shortcuts")
        case .servers: String(localized: "Servers")
        case .providers: String(localized: "Providers")
        case .dataAndStorage: String(localized: "Data & Storage")
        case .about: String(localized: "About")
        case .developer: String(localized: "Developer")
        }
    }

    var systemImage: String {
        switch self {
        case .appearance: "paintbrush"
        case .notificationsAndHaptics: "bell.badge"
        case .chats: "bubble.left.and.text.bubble.right"
        case .liveActivitiesAndWidgets: "bolt.horizontal.circle"
        case .siriAndShortcuts: "sparkles"
        case .servers: "server.rack"
        case .providers: "key.horizontal"
        case .dataAndStorage: "internaldrive"
        case .about: "info.circle"
        case .developer: "hammer"
        }
    }
}

enum SettingsDestination: Hashable {
    case servers
    case providerQuotas
}

struct SettingsCategoryPage<Content: View>: View {
    let category: SettingsCategory
    @ViewBuilder let content: Content

    init(category: SettingsCategory, @ViewBuilder content: () -> Content) {
        self.category = category
        self.content = content()
    }

    var body: some View {
        SettingsPage(title: category.title) {
            content
        }
    }
}

struct SettingsPage<Content: View>: View {
    @ScaledMetric(relativeTo: .body) private var cardSpacing: CGFloat = 18

    let title: String
    @ViewBuilder let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(spacing: cardSpacing) {
                content
            }
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 36)
            .adaptiveReadableContent(maxWidth: AdaptiveReadableContentWidth.secondaryDestination)
        }
        .background(Color(.systemBackground))
        .navigationTitle(title)
    }
}
