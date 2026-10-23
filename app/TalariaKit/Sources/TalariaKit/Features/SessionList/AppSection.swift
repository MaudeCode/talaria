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

/// The regular-width split view's sizes, from the split view's own width rather than the device (TAL-1453).
public enum RegularSplitLayout {
    /// Every section's sidebar shares this one column width. 340pt is the narrowest width where "Scheduled
    /// sessions", a "200+" count and the chevron fit at default Dynamic Type.
    public static let sidebarMinWidth: CGFloat = 340
    public static let sidebarMaxWidth: CGFloat = 440
    /// The narrowest chat the app is tested at.
    public static let detailMinWidth: CGFloat = 320
    /// The narrowest chat that keeps the Files inspector beside it (TAL-479).
    public static let filesInspectorChatWidth: CGFloat = 740

    /// 380pt, less where that would leave the chat narrower than it is tested at (the iPhone Duo inner display).
    public static func sidebarIdealWidth(splitWidth: CGFloat) -> CGFloat {
        max(sidebarMinWidth, min(380, splitWidth - detailMinWidth))
    }

    /// Whether the chat reaches the Files inspector's width only with the sidebar column hidden, so opening Files
    /// hides it rather than pushing the browser over the chat.
    public static func hidesSidebarForFilesInspector(splitWidth: CGFloat) -> Bool {
        splitWidth >= filesInspectorChatWidth
            && splitWidth - sidebarIdealWidth(splitWidth: splitWidth) < filesInspectorChatWidth
    }

    /// TAL-1458: an `ArrangementView` split puts the companion page beside the chat only while it is at least as wide as
    /// it is tall. Measured on iOS 27.1: 700×700 pt splits, 700×720 pt does not.
    // ponytail: measured rule, not a documented one; revisit if SwiftUI exposes whether the arrangement can split.
    public static func splitsCompanionPage(width: CGFloat, height: CGFloat) -> Bool {
        width > 0 && width >= height
    }

    /// Whether the chat's companion page fits beside it only with the sidebar column hidden: the iPhone Duo inner
    /// display and iPad in landscape.
    public static func hidesSidebarForCompanionPage(splitWidth: CGFloat, splitHeight: CGFloat) -> Bool {
        splitsCompanionPage(width: splitWidth, height: splitHeight)
            && !splitsCompanionPage(width: splitWidth - sidebarIdealWidth(splitWidth: splitWidth), height: splitHeight)
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
