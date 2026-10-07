import Foundation

/// The part of the app the drawer opened. At regular width (iPad, the iPhone Duo inner display)
/// it decides what each split-view column shows; compact width pushes the same lists (TAL-643).
public enum AppSection: Hashable {
    case chats
    case archived
    case scheduled
    case webhook
    case settings
    case memory
    case skills
    case tasks
    case kanban
    case insights

    public init(_ utility: SessionListUtilityDestination) {
        switch utility {
        case .settings, .providerQuotaWidgetSettings: self = .settings
        case .providers, .insights: self = .insights
        case .tasks: self = .tasks
        case .kanban: self = .kanban
        case .skills: self = .skills
        case .memory: self = .memory
        case .archived: self = .archived
        case .scheduled: self = .scheduled
        case .webhook: self = .webhook
        }
    }

    /// Kanban and Insights have no list of their own, so they hide the sidebar column.
    public var isFullWidth: Bool {
        self == .kanban || self == .insights
    }

    /// The chat lists other than Chats. Their sidebar leads back to Chats, and a chat opened from
    /// one keeps that list beside it.
    public var chatList: SessionListUtilityDestination? {
        switch self {
        case .archived: .archived
        case .scheduled: .scheduled
        case .webhook: .webhook
        default: nil
        }
    }

    /// The item the regular-width detail column shows before the user picks one.
    public var defaultItem: SectionItem? {
        switch self {
        case .settings: SettingsCategory.rootCategories.first.map { .settings(.category($0)) }
        case .memory: .memory(.section(.memory))
        default: nil
        }
    }
}

/// An item a section's list selects. Its page shows beside the list at regular width and is
/// pushed over it at compact width. Device-local UI state, never sent to the server.
public enum SectionItem: Hashable {
    case settings(SettingsPane)
    case memory(MemoryFile)
    case skill(id: String)
    case task(id: String)

    init?(entering utility: SessionListUtilityDestination) {
        switch utility {
        case .settings(let anchor?): self = .settings(.category(anchor.category))
        case .providerQuotaWidgetSettings: self = .settings(.category(.liveActivitiesAndWidgets))
        default: return nil
        }
    }
}

/// A row of the Settings root list.
public enum SettingsPane: Hashable {
    case userProfile
    case appleAccount
    case category(SettingsCategory)
}

/// A Memory document: the three editable sections and the read-only project context.
public enum MemoryFile: Hashable {
    case section(MemorySection)
    case projectContext
}
