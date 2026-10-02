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

    /// The status for a stream recovery state; nil while the stream is healthy.
    public init?(recoveryState: ActiveStreamRecoveryState) {
        switch recoveryState {
        case .idle:
            return nil
        case .checking:
            self.init(kind: .checking)
        case .reconnecting:
            self.init(kind: .reconnecting)
        }
    }

    public var label: String {
        kind.label
    }

    public var accessibilityLabel: String {
        kind.accessibilityLabel
    }

    /// Whether this is the "Syncing messages" pill (TAL-436).
    public var isSyncing: Bool {
        kind == .syncing
    }

    /// Whether the transcript makes room for this chip. The syncing pill floats over the
    /// transcript bottom, so it never shifts the chat as it comes and goes.
    public var reservesTranscriptSpace: Bool {
        !isSyncing
    }
}

public enum ChatActiveRunStatusPolicy {
    /// The transcript tail's recovery chip. While the syncing pill shows, it stands in for the
    /// chip so the two never compete (TAL-436).
    public static func transcriptRecoveryState(
        _ state: ActiveStreamRecoveryState,
        statusPresentation: ChatActiveRunStatusPresentation?
    ) -> ActiveStreamRecoveryState {
        statusPresentation?.isSyncing == true ? .idle : state
    }

    public static func presentation(
        isStartingChat: Bool,
        hasActiveStream: Bool,
        activeStreamRecoveryState: ActiveStreamRecoveryState,
        isCancellingStream: Bool,
        isSyncingTranscript: Bool = false,
        isScrolledNearBottom: Bool
    ) -> ChatActiveRunStatusPresentation? {
        if !isScrolledNearBottom {
            if isCancellingStream {
                return ChatActiveRunStatusPresentation(kind: .stopping)
            }
            if isStartingChat {
                return ChatActiveRunStatusPresentation(kind: .starting)
            }
        }

        // Syncing has no inline twin at the transcript tail, so it shows at any scroll
        // position, and it stands in for run progress until the transcript is current.
        if isSyncingTranscript {
            return ChatActiveRunStatusPresentation(kind: .syncing)
        }

        guard !isScrolledNearBottom else { return nil }

        if let recovery = ChatActiveRunStatusPresentation(recoveryState: activeStreamRecoveryState) {
            return recovery
        }

        guard hasActiveStream else { return nil }
        return ChatActiveRunStatusPresentation(kind: .active)
    }
}
