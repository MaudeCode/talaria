import SwiftUI

public enum KanbanCardAction: Equatable {
    case move(String)
    case block
    case unblock
    case complete
    case archive
}

public enum KanbanCardRowPrimaryAction: Equatable {
    case openDetail(String)
    case toggleSelection(String)

    public static func resolve(for card: KanbanCard, isSelecting: Bool) -> Self? {
        guard let cardID = card.cardID else { return nil }
        return isSelecting ? .toggleSelection(cardID) : .openDetail(cardID)
    }

    public static func focusTarget(afterDismissing cardID: String, visibleCards: [KanbanCard]) -> String? {
        visibleCards.contains { $0.cardID == cardID } ? cardID : nil
    }
}

public struct KanbanPendingCardAction: Identifiable, Equatable {
    public let id = UUID()
    public let card: KanbanCard
    public let action: KanbanCardAction

    public init(card: KanbanCard, action: KanbanCardAction) {
        self.card = card
        self.action = action
    }

    public static func == (lhs: KanbanPendingCardAction, rhs: KanbanPendingCardAction) -> Bool {
        lhs.id == rhs.id
    }
}
