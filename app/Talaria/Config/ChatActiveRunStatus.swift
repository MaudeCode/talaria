import Foundation
import TalariaKit

enum ChatActiveRunStatusKind: Equatable {
    case starting
    case active
    case checking
    case reconnecting
    case stopping

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
        }
    }
}

struct ChatActiveRunStatusPresentation: Equatable {
    let kind: ChatActiveRunStatusKind

    var label: String {
        kind.label
    }

    var accessibilityLabel: String {
        kind.accessibilityLabel
    }
}

enum ChatActiveRunStatusPolicy {
    static func presentation(
        isStartingChat: Bool,
        hasActiveStream: Bool,
        activeStreamRecoveryState: ActiveStreamRecoveryState,
        isCancellingStream: Bool,
        isScrolledNearBottom: Bool
    ) -> ChatActiveRunStatusPresentation? {
        guard !isScrolledNearBottom else { return nil }

        if isCancellingStream {
            return ChatActiveRunStatusPresentation(kind: .stopping)
        }

        if isStartingChat {
            return ChatActiveRunStatusPresentation(kind: .starting)
        }

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
