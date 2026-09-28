import Foundation
import SwiftUI

/// What a long press inside a message row resolves to.
public enum ChatMessageMenuTarget: Equatable {
    case link(URL)
    case message
}

public enum ChatMessageMenuPolicy {
    /// A text line is thinner than a fingertip, so a link keeps a small margin
    /// around its drawn rect. It stays well under the line spacing, so the
    /// prose above and below a link still opens the message menu.
    public static let linkTouchSlop: CGFloat = 4

    /// Links win at their own hit target; everything else in the row belongs to
    /// the message menu.
    public static func target(
        at point: CGPoint,
        linkRegions: [ChatMessageLinkRegion],
        touchSlop: CGFloat = linkTouchSlop
    ) -> ChatMessageMenuTarget {
        let hit = linkRegions.first {
            $0.rect.insetBy(dx: -touchSlop, dy: -touchSlop).contains(point)
        }
        return hit.map { .link($0.url) } ?? .message
    }
}
