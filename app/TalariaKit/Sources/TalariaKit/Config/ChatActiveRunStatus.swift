public import Foundation

public enum ChatActiveRunStatusKind: Equatable {
    case starting
    case active
    /// A background result started the running turn (TAL-460).
    case background
    case checking
    case reconnecting
    case stopping
    case syncing

    func label(agentName: String) -> String {
        switch self {
        case .starting:
            return String(localized: "Starting response")
        case .active:
            return String(localized: "\(agentName) is working")
        case .background:
            return String(localized: "Working on background results")
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

    func accessibilityLabel(agentName: String) -> String {
        switch self {
        case .starting:
            return String(localized: "\(agentName) is starting a response")
        case .active:
            return String(localized: "\(agentName) is working on the response")
        case .background:
            return String(localized: "\(agentName) is working on background results")
        case .checking:
            return String(localized: "\(agentName) is checking the response stream")
        case .reconnecting:
            return String(localized: "\(agentName) is reconnecting the response stream")
        case .stopping:
            return String(localized: "\(agentName) is stopping the response")
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

    /// `agentName` is the session's `assistant_name` from the server.
    public func label(agentName: String) -> String {
        kind.label(agentName: agentName)
    }

    public func accessibilityLabel(agentName: String) -> String {
        kind.accessibilityLabel(agentName: agentName)
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
        isBackgroundTurn: Bool = false,
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
        return ChatActiveRunStatusPresentation(kind: isBackgroundTurn ? .background : .active)
    }
}
