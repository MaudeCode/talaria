import SwiftUI
import UIKit
import TalariaKit

enum KanbanCardAction: Equatable {
    case move(String)
    case block
    case unblock
    case complete
    case archive
}

enum KanbanCardRowPrimaryAction: Equatable {
    case openDetail(String)
    case toggleSelection(String)

    static func resolve(for card: KanbanCard, isSelecting: Bool) -> Self? {
        guard let cardID = card.cardID else { return nil }
        return isSelecting ? .toggleSelection(cardID) : .openDetail(cardID)
    }

    static func focusTarget(afterDismissing cardID: String, visibleCards: [KanbanCard]) -> String? {
        visibleCards.contains { $0.cardID == cardID } ? cardID : nil
    }
}

struct KanbanPendingCardAction: Identifiable, Equatable {
    let id = UUID()
    let card: KanbanCard
    let action: KanbanCardAction

    static func == (lhs: KanbanPendingCardAction, rhs: KanbanPendingCardAction) -> Bool {
        lhs.id == rhs.id
    }
}
