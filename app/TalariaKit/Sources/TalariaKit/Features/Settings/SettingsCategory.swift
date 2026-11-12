import Foundation

public enum SettingsCategory: String, Identifiable, Sendable {
    case appearance
    case notificationsAndHaptics = "notifications"
    case chats = "chat"
    case navigation
    case speech
    case models
    case tools
    case profiles
    case workspaces
    case system
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
            .appearance, .chats, .navigation, .notificationsAndHaptics, .speech,
            .models, .providers, .tools, .profiles, .workspaces, .system,
            .servers, .liveActivitiesAndWidgets, .siriAndShortcuts, .dataAndStorage, .about
        ]
        #if DEBUG
        categories.append(.developer)
        #endif
        return categories
    }

    public enum Group: String, CaseIterable, Identifiable, Sendable {
        case interface, profile, server, device

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .interface: String(localized: "Interface")
            case .profile: String(localized: "Profile")
            case .server: String(localized: "Server")
            case .device: String(localized: "This iPhone")
            }
        }
    }

    public var group: Group {
        switch self {
        case .appearance, .chats, .navigation, .notificationsAndHaptics, .speech: .interface
        case .models, .providers, .tools: .profile
        case .profiles, .workspaces, .system: .server
        case .servers, .liveActivitiesAndWidgets, .siriAndShortcuts, .dataAndStorage, .about, .developer: .device
        }
    }

    public var title: String {
        switch self {
        case .navigation: String(localized: "Navigation")
        case .speech: String(localized: "Speech")
        case .tools: String(localized: "Tools")
        case .models: String(localized: "Models")
        case .profiles: String(localized: "Profiles")
        case .workspaces: String(localized: "Workspaces")
        case .system: String(localized: "System")
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
        case .navigation: "sidebar.left"
        case .speech: "mic"
        case .tools: "wrench.and.screwdriver"
        case .models: "cpu"
        case .profiles: "person.crop.circle"
        case .workspaces: "folder"
        case .system: "gearshape"
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
