import Foundation

public enum SettingsCategory: String, Identifiable {
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

    public var id: String { rawValue }

    public static var rootCategories: [Self] {
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

    public var title: String {
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

    public var systemImage: String {
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

public enum SettingsDestination: Hashable {
    case servers
    case providerQuotas
}
