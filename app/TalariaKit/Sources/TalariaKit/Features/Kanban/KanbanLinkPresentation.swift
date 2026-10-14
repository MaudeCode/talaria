import Foundation

/// One Prerequisite or Dependent row in Card detail.
public struct KanbanLinkPresentation: Equatable, Sendable {
    public let cardID: String
    /// Nil when the server could not name the Card (since deleted); the row shows its ID instead.
    public let title: String?
    public let statusTitle: String?

    /// Keeps same-titled links distinct for VoiceOver.
    public var accessibilityName: String {
        title.map { "\($0) (\(cardID))" } ?? cardID
    }
}

extension KanbanCardDetailEnvelope {
    public func linkPresentations(_ ids: [String]) -> [KanbanLinkPresentation] {
        ids.map { id in
            let named = linkedCards?.first { $0.cardID == id && $0.title?.isEmpty == false }
            return KanbanLinkPresentation(
                cardID: id,
                title: named?.title,
                statusTitle: named?.status.map { KanbanStatusPresentation($0).title }
            )
        }
    }
}

extension KanbanCard {
    /// How long the active run has been going; nil without one.
    public func currentRunElapsed(at now: Date) -> TimeInterval? {
        currentRunStartedAt.map { max(0, now.timeIntervalSince1970 - $0) }
    }
}
