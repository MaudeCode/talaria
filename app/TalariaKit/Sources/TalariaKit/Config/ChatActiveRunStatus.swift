public import Foundation

public enum ChatActiveRunStatusKind: Equatable {
    case starting
    case active
    case checking
    case reconnecting
    case stopping
    case syncing

    var label: String {
        switch self {
        case .starting:
            return String(localized: "Starting response")
        case .active:
            return String(localized: "Hermes is working")
        case .checking:
            return String(localized: "Checking stream")
        case .reconnecting:
            return String(localized: "Reconnecting stream")
        case .stopping:
            return String(localized: "Stopping response")
        case .syncing:
            return String(localized: "Syncing messages")
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .starting:
            return String(localized: "Hermes is starting a response")
        case .active:
            return String(localized: "Hermes is working on the response")
        case .checking:
            return String(localized: "Hermes is checking the response stream")
        case .reconnecting:
            return String(localized: "Hermes is reconnecting the response stream")
        case .stopping:
            return String(localized: "Hermes is stopping the response")
        case .syncing:
            return String(localized: "Syncing messages with the server")
        }
    }
}

public struct ChatActiveRunStatusPresentation: Equatable {
    let kind: ChatActiveRunStatusKind

    public init(kind: ChatActiveRunStatusKind) {
        self.kind = kind
    }

    public var label: String {
        kind.label
    }

    public var accessibilityLabel: String {
        kind.accessibilityLabel
    }

    /// Syncing has no inline twin at the transcript tail, so it never stands in for one.
    public var isSyncing: Bool {
        kind == .syncing
    }
}

public enum ChatActiveRunStatusPolicy {
    public static func presentation(
        isStartingChat: Bool,
        hasActiveStream: Bool,
        activeStreamRecoveryState: ActiveStreamRecoveryState,
        isCancellingStream: Bool,
        isSyncingTranscript: Bool = false,
        isScrolledNearBottom: Bool
    ) -> ChatActiveRunStatusPresentation? {
        if !isScrolledNearBottom, isCancellingStream {
            return ChatActiveRunStatusPresentation(kind: .stopping)
        }

        if !isScrolledNearBottom, isStartingChat {
            return ChatActiveRunStatusPresentation(kind: .starting)
        }

        // Syncing has no inline twin at the transcript tail, so it shows at any scroll
        // position, and it hides run progress the way T3 Code's thread sync does.
        if isSyncingTranscript {
            return ChatActiveRunStatusPresentation(kind: .syncing)
        }

        guard !isScrolledNearBottom else { return nil }

        switch activeStreamRecoveryState {
        case .checking:
            return ChatActiveRunStatusPresentation(kind: .checking)
        case .reconnecting:
            return ChatActiveRunStatusPresentation(kind: .reconnecting)
        case .idle:
            break
        }

        guard hasActiveStream else { return nil }
        return ChatActiveRunStatusPresentation(kind: .active)
    }
}
