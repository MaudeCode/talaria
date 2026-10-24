import Foundation

/// The part of the app the drawer opened. At regular width (iPad, the iPhone Duo inner display)
/// its root and inner pages are shared with compact width.
public enum AppSection: Hashable {
    case chats
    case archived
    case scheduled
    case webhook
    case memory
    case skills
    case tasks
    case kanban
    case insights

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
        }
    }

    public init?(_ utility: SessionListUtilityDestination) {
        switch utility {
        case .settings, .providerQuotaWidgetSettings: return nil
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

/// One device-local decision for the split column, drawer and toolbar ownership.
public struct SidebarPresentation: Equatable {
    public enum ToggleTarget: Equatable { case column, drawer }

    public let isLandscape: Bool
    public let tiled: Bool
    public let showsColumn: Bool
    public let columnIsForced: Bool
    public let drawerEnabled: Bool
    public let overlaysContent: Bool
    public let hostsSidebarActionsInDetail: Bool
    public let toggleTarget: ToggleTarget
    public let showsFilesInspector: Bool
    public let dismissesFilesInspector: Bool

    public init(isRegularWidth: Bool, splitSize: CGSize, hasVerticalBar: Bool, storedChoice: Bool,
                drawerIsPresented: Bool = false, columnIsVisible: Bool = false,
                hidesSidebarColumn: Bool = false, hasVerticalDivision: Bool = false,
                filesInspectorPresented: Bool = false, filesInspectorIsEligible: Bool = true,
                filesInspectorOpeningIsLandscape: Bool? = nil) {
        isLandscape = Self.isLandscape(splitSize)
        columnIsForced = isRegularWidth && hasVerticalDivision
        tiled = isRegularWidth && (columnIsForced || (isLandscape && splitSize.width >= 900))
        // Rotation consumes this explicit presentation; a Files tap can reopen it in the new layout.
        showsFilesInspector = filesInspectorPresented && filesInspectorIsEligible && isRegularWidth
            && !hasVerticalDivision && splitSize.width >= RegularSplitLayout.filesInspectorChatWidth
            && (filesInspectorOpeningIsLandscape == nil || filesInspectorOpeningIsLandscape == isLandscape)
        dismissesFilesInspector = filesInspectorPresented && !showsFilesInspector
        let filesNeedsRoom = showsFilesInspector && RegularSplitLayout.hidesSidebarForFilesInspector(splitWidth: splitSize.width)
        showsColumn = columnIsForced || (tiled && storedChoice && !hidesSidebarColumn && !filesNeedsRoom && !drawerIsPresented)
        drawerEnabled = !tiled && !columnIsVisible
        overlaysContent = isRegularWidth
        hostsSidebarActionsInDetail = tiled && hasVerticalBar
        toggleTarget = tiled ? .column : .drawer
    }

    public static func isLandscape(_ size: CGSize) -> Bool {
        size.height > 0 && size.width > size.height
    }

    /// Leaving a tiled layout consumes its native primary column, including a late UIKit visibility report.
    public func requiresColumnCollapse(previouslyTiled: Bool, nativeColumnIsVisible: Bool) -> Bool {
        !tiled && (previouslyTiled || nativeColumnIsVisible)
    }
}

/// A page pushed within the current section root at either width. Device-local UI state.
public enum SectionItem: Hashable {
    case memory(MemoryFile)
    case skill(id: String)
    case task(id: String)
}

/// A row of the Settings root list.
public enum SettingsPane: Hashable {
    case userProfile
    case appleAccount
    case providerQuotaWidget
    case category(SettingsCategory)
}

/// A Memory document: the three editable sections and the read-only project context.
public enum MemoryFile: Hashable {
    case section(MemorySection)
    case projectContext
}
