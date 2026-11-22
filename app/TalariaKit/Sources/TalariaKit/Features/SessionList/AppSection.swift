import Foundation

/// The part of the app the drawer opened. At regular width (iPad, the iPhone Duo inner display)
/// its root and inner pages are shared with compact width.
public enum AppSection: Hashable, Sendable {
    case chats
    case archived
    case scheduled
    case webhook
    case memory
    case skills
    case tasks
    case kanban
    case insights
    /// TAL-1966: the profile's decision reviews.
    case decisions

    public var title: String {
        switch self {
        case .chats: String(localized: "Chats")
        case .archived: String(localized: "Archived Chats")
        case .scheduled: String(localized: "Scheduled sessions")
        case .webhook: String(localized: "Webhook sessions")
        case .memory: String(localized: "Memory")
        case .skills: String(localized: "Skills")
        case .tasks: String(localized: "Tasks")
        case .kanban: String(localized: "Kanban")
        case .insights: String(localized: "Insights")
        case .decisions: String(localized: "Decisions")
        }
    }

    public init?(_ utility: SessionListUtilityDestination) {
        switch utility {
        case .settings, .providerQuotaWidgetSettings, .providers, .decisionReview, .kanbanCard: return nil
        case .decisions: self = .decisions
        case .insights: self = .insights
        case .tasks: self = .tasks
        case .kanban: self = .kanban
        case .skills: self = .skills
        case .memory: self = .memory
        case .archived: self = .archived
        case .scheduled: self = .scheduled
        case .webhook: self = .webhook
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

    /// TAL-1541: a pane's share of a two-pane split of `width`, clamped so each pane keeps `detailMinWidth`. A split too
    /// narrow for two such panes halves.
    public static func clampedSplitShare(_ share: CGFloat, width: CGFloat) -> CGFloat {
        guard width > 0 else { return 0.5 }
        let minimum = min(detailMinWidth, width / 2) / width
        return min(1 - minimum, max(minimum, share))
    }

    /// Whether the chat's companion page fits beside it only with the sidebar column hidden: the iPhone Duo inner
    /// display and iPad in landscape.
    public static func hidesSidebarForCompanionPage(splitWidth: CGFloat, splitHeight: CGFloat) -> Bool {
        splitsCompanionPage(width: splitWidth, height: splitHeight)
            && !splitsCompanionPage(width: splitWidth - sidebarIdealWidth(splitWidth: splitWidth), height: splitHeight)
    }
}

/// One device-local decision for the split column, drawer and toolbar ownership.
public struct SidebarPresentation: Equatable, Sendable {
    public enum ToggleTarget: Equatable, Sendable { case column, drawer }

    /// The chat's companion page where it shows only with the sidebar column hidden (TAL-1540).
    public enum CompanionPage: Equatable, Sendable {
        /// No page there, or one the reader hid with its own button: the column leaves it alone.
        case none
        /// The page shows beside the chat in the column's room.
        case shown
        /// The column took the page's room; hiding the column brings it back.
        case suspended
    }

    public let isLandscape: Bool
    public let tiled: Bool
    public let showsColumn: Bool
    public let columnIsForced: Bool
    public let drawerEnabled: Bool
    public let overlaysContent: Bool
    public let hostsSidebarActionsInDetail: Bool
    /// The Duo's vertical bar carries the chat's New Chat, so the sidebar offers its own only without one.
    public let sidebarShowsNewChat: Bool
    public let toggleTarget: ToggleTarget
    /// Whether the Files inspector can sit beside the chat at all: regular width, no fold through the split, and
    /// room for the chat. A Files tap opens the inspector only when this holds; otherwise it pushes the browser.
    public let filesInspectorFits: Bool
    public let showsFilesInspector: Bool
    public let dismissesFilesInspector: Bool
    public let companionPage: CompanionPage
    /// The column the reader's toggle asks for: a page in the column's room gives way to it.
    public let toggleShowsColumn: Bool

    /// `hidesSidebarColumn`: a chat beside this one needs the column's room.
    public init(isRegularWidth: Bool, splitSize: CGSize, hasVerticalBar: Bool, storedChoice: Bool,
                drawerIsPresented: Bool = false, columnIsVisible: Bool = false,
                hidesSidebarColumn: Bool = false, hasVerticalDivision: Bool = false, hasSecondaryChat: Bool = false,
                companionPage: CompanionPage = .none,
                filesInspectorPresented: Bool = false, filesInspectorIsEligible: Bool = true,
                filesInspectorOpeningIsLandscape: Bool? = nil) {
        self.companionPage = companionPage
        toggleShowsColumn = companionPage == .shown || !storedChoice
        isLandscape = Self.isLandscape(splitSize)
        columnIsForced = isRegularWidth && hasVerticalDivision && !hasSecondaryChat
        tiled = isRegularWidth && (columnIsForced || (isLandscape && splitSize.width >= 900))
        // Rotation consumes this explicit presentation; a Files tap can reopen it in the new layout.
        filesInspectorFits = isRegularWidth && !hasVerticalDivision
            && splitSize.width >= RegularSplitLayout.filesInspectorChatWidth
        showsFilesInspector = filesInspectorPresented && filesInspectorIsEligible && filesInspectorFits
            && (filesInspectorOpeningIsLandscape == nil || filesInspectorOpeningIsLandscape == isLandscape)
        dismissesFilesInspector = filesInspectorPresented && !showsFilesInspector
        let filesNeedsRoom = showsFilesInspector && RegularSplitLayout.hidesSidebarForFilesInspector(splitWidth: splitSize.width)
        showsColumn = columnIsForced || (tiled && storedChoice && !hidesSidebarColumn && companionPage != .shown
            && !filesNeedsRoom && !drawerIsPresented)
        let secondaryUsesDrawer = hasSecondaryChat && hidesSidebarColumn
        drawerEnabled = secondaryUsesDrawer || (!tiled && !columnIsVisible)
        overlaysContent = isRegularWidth
        hostsSidebarActionsInDetail = tiled && hasVerticalBar
        sidebarShowsNewChat = !hasVerticalBar
        toggleTarget = secondaryUsesDrawer ? .drawer : (tiled ? .column : .drawer)
    }

    public static func isLandscape(_ size: CGSize) -> Bool {
        size.height > 0 && size.width > size.height
    }

    /// The page once the reader shows or hides the column: showing it suspends a page in its room, and hiding it brings
    /// back only a suspended page, so one the reader hid stays hidden.
    public func companionPage(showingColumn: Bool) -> CompanionPage {
        switch (companionPage, showingColumn) {
        case (.shown, true): .suspended
        case (.suspended, false): .shown
        default: companionPage
        }
    }

    /// Leaving a tiled layout consumes its native primary column, including a late UIKit visibility report.
    public func requiresColumnCollapse(previouslyTiled: Bool, nativeColumnIsVisible: Bool) -> Bool {
        !tiled && (previouslyTiled || nativeColumnIsVisible)
    }
}

/// A page pushed within the current section root at either width. Device-local UI state.
public enum SectionItem: Hashable, Sendable {
    case memory(MemoryFile)
    case skill(id: String)
    case task(id: String)
    /// A provider quota account opened from the Insights Quotas tab (TAL-1750).
    case quotaSource(id: String)
    /// TAL-1966: a decision review opened from the Decisions list or its push alert.
    case decisionReview(id: String)
    /// TAL-2327: a Kanban card a transcript row opened, on its board (the current one without).
    case kanbanCard(id: String, board: String?)
}

/// A row of the Settings root list.
public enum SettingsPane: Hashable, Sendable {
    case indexed(SettingsScrollAnchor)
    case userProfile
    case appleAccount
    case providerQuotaWidget
    case sidebarQuotas
    case widgetProfiles
    /// TAL-2341: Settings › Chats › Tool Calls.
    case toolCalls
    case category(SettingsCategory)

    public var category: SettingsCategory {
        switch self {
        case .category(let category): category
        case .indexed(let anchor): anchor.category
        case .sidebarQuotas: .navigation
        case .toolCalls: .chats
        case .providerQuotaWidget, .widgetProfiles: .liveActivitiesAndWidgets
        case .userProfile: .appearance
        case .appleAccount: .servers
        }
    }
}

/// A Memory document: the three editable sections and the read-only project context.
public enum MemoryFile: Hashable, Sendable {
    case section(MemorySection)
    case projectContext
}
