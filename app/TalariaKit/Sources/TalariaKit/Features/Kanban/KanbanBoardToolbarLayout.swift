import CoreGraphics

/// Bounds the Kanban navigation bar so the Board picker keeps its name and chevron
/// visible while New Card, Dispatcher, Select Cards and Card Filters stay reachable.
///
/// The picker sits in the principal slot, and the bar drops that slot outright once the
/// leading and trailing groups leave it too little room: a long Board name removed the
/// whole picker instead of truncating it. Capping the name to the space that is left, and
/// folding the two secondary controls into one overflow menu when four trailing controls
/// no longer leave a readable name, keeps the picker and every action on screen.
///
/// The reserves below are deliberate over-estimates of the measured bar. Reserving too
/// much only truncates the name earlier; reserving too little brings the empty bar back.
public struct KanbanBoardToolbarLayout: Equatable {
    /// Cap for the Board name, or `nil` while the bar width is still unknown.
    public let boardNameWidth: CGFloat?
    /// True when Select Cards and Card Filters move into a single overflow menu.
    public let usesOverflowMenu: Bool

    /// Narrowest name that still reads as a truncated Board name beside the chevron.
    static let minimumBoardNameWidth: CGFloat = 64
    /// Chevron, the picker's internal spacing, and the gap it keeps from both groups.
    private static let chevronWidth: CGFloat = 40
    /// Leading control and the bar's outer margin.
    private static let leadingWidth: CGFloat = 60
    /// Spacing the trailing group adds around each control.
    private static let controlSpacing: CGFloat = 20
    /// The trailing group's outer margin.
    private static let trailingMargin: CGFloat = 20

    public static func resolve(containerWidth: CGFloat, controlWidth: CGFloat) -> Self {
        guard containerWidth > 0, controlWidth > 0 else {
            return Self(boardNameWidth: nil, usesOverflowMenu: false)
        }
        let nameWidth = { (trailingControls: Int) in
            containerWidth - leadingWidth - chevronWidth - trailingMargin
                - (controlWidth + controlSpacing) * CGFloat(trailingControls)
        }
        let inlineWidth = nameWidth(4)
        if inlineWidth >= minimumBoardNameWidth {
            return Self(boardNameWidth: inlineWidth, usesOverflowMenu: false)
        }
        return Self(
            boardNameWidth: max(minimumBoardNameWidth, nameWidth(3)),
            usesOverflowMenu: true
        )
    }
}
