import Foundation
import SwiftUI

/// Which of the session list's optional navigation rows are shown, so a user can
/// hide the parts of the app they never use (issue #189).
public struct SidebarSectionVisibility: Equatable {
    public var tasks: Bool
    public var kanban: Bool
    public var skills: Bool
    public var memory: Bool
    public var insights: Bool

    public init(tasks: Bool, kanban: Bool, skills: Bool, memory: Bool, insights: Bool) {
        self.tasks = tasks
        self.kanban = kanban
        self.skills = skills
        self.memory = memory
        self.insights = insights
    }

    /// Show every row, primarily for previews and tests.
    static let showAll = SidebarSectionVisibility(
        tasks: true,
        kanban: true,
        skills: true,
        memory: true,
        insights: true
    )

}

/// Pure, testable backing model for the session-list avatar's long-press server
/// switcher (#283). Maps `AuthManager.servers` + the active server id into the
/// rows the context menu renders, deriving each row's display name the same way
/// the Settings server list does, so the menu's contents — and which server is
/// marked active — are unit-testable without standing up the view.
public struct AvatarServerSwitcherModel: Equatable {
    public struct Entry: Identifiable, Equatable {
        public let id: String
        public let account: ServerAccount
        public let displayName: String
        public let isActive: Bool
    }

    public let entries: [Entry]

    /// The id of the entry marked active, or nil when the active id matches no
    /// configured server (a defensive transient, e.g. mid-removal).
    var activeID: String? { entries.first(where: \.isActive)?.id }

    public init(servers: [ServerAccount], activeServerID: String?) {
        entries = servers.map { account in
            let hostFallback = URL(string: account.urlString)?.host ?? account.urlString
            let displayName = account.displayName.isEmpty ? hostFallback : account.displayName
            return Entry(
                id: account.id,
                account: account,
                displayName: displayName,
                isActive: account.id == activeServerID
            )
        }
    }
}

/// Where the screen and the sidebar sit as the sidebar goes from closed (0) to open (1), in
/// leading-edge points. The screen slides aside to reveal the sidebar, except beside a vertical
/// bar: the bar is window chrome that cannot move with the screen, so there the sidebar slides
/// in over a screen that stays put (TAL-481).
public struct AppSidebarSlide: Equatable {
    public var revealWidth: CGFloat
    public var leadingInset: CGFloat
    public var presentsOver: Bool
    public var trailingInset: CGFloat

    public init(revealWidth: CGFloat, leadingInset: CGFloat, presentsOver: Bool, trailingInset: CGFloat = 0) {
        self.revealWidth = revealWidth
        self.leadingInset = leadingInset
        self.presentsOver = presentsOver
        self.trailingInset = trailingInset
    }

    /// How far the moving view travels: the screen by the reveal width, or the sidebar by its
    /// whole width, leading inset included.
    private var travel: CGFloat {
        presentsOver ? leadingInset + revealWidth + trailingInset : revealWidth
    }

    public func surfaceOffset(progress: CGFloat) -> CGFloat {
        presentsOver ? 0 : revealWidth * progress
    }

    public func sidebarOffset(progress: CGFloat) -> CGFloat {
        presentsOver ? -travel * (1 - progress) : 0
    }

    public func tintAlpha(progress: CGFloat) -> CGFloat {
        progress
    }

    /// The progress at which the moving view (the screen, or the presented sidebar) sits at `offset`.
    public func progress(movingOffset offset: CGFloat) -> CGFloat {
        guard travel > 0 else { return 0 }
        let progress = presentsOver ? 1 + offset / travel : offset / travel
        return min(max(progress, 0), 1)
    }
}

public enum AppSidebarGesturePolicy {
    public static let edgeActivationWidth: CGFloat = 28

    /// An open sidebar tracks any horizontal drag; a closed one opens only from the leading
    /// edge of a stack root, since a stack that can pop owns the edge swipe as Back (TAL-462).
    /// A screen-edge pan asks before it has moved, so a zero translation is judged by its start.
    public static func accepts(
        isPresented: Bool,
        canPopVisibleStack: Bool,
        startX: CGFloat,
        containerWidth: CGFloat,
        translation: CGSize,
        isRightToLeft: Bool
    ) -> Bool {
        guard translation == .zero || abs(translation.width) > abs(translation.height) else { return false }
        guard !isPresented else { return true }
        guard !canPopVisibleStack else { return false }

        return isRightToLeft
            ? startX >= containerWidth - edgeActivationWidth
            : startX <= edgeActivationWidth
    }

    public static func progress(
        isPresented: Bool,
        translationWidth: CGFloat,
        revealWidth: CGFloat,
        isRightToLeft: Bool
    ) -> CGFloat {
        guard revealWidth > 0 else { return 0 }
        let direction: CGFloat = isRightToLeft ? -1 : 1
        let currentOffset = isPresented ? revealWidth : 0
        return min(max((currentOffset + translationWidth * direction) / revealWidth, 0), 1)
    }
}
