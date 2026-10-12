public import Foundation

public enum ChatActiveRunStatusKind: Equatable {
    case starting
    case active
    /// A background result started the running turn (TAL-460).
    case background
    case checking
    case reconnecting
    case waitingForNetwork
    case stopping
    case syncing

    func label(agentName: String) -> String {
        switch self {
        case .starting:
            return String(localized: "Starting response")
        case .active:
            // The elapsed time follows it: "Working 42s" (TAL-922).
            return String(localized: "Working")
        case .background:
            return String(localized: "Working on background results")
        case .checking:
            return String(localized: "Checking stream")
        case .reconnecting:
            return String(localized: "Reconnecting stream")
        case .waitingForNetwork:
            return String(localized: "Waiting for network")
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
        case .waitingForNetwork:
            return String(localized: "\(agentName) is waiting for a network connection")
        case .stopping:
            return String(localized: "\(agentName) is stopping the response")
        case .syncing:
            return String(localized: "Syncing messages with the server")
        }
    }
}

public struct ChatActiveRunStatusPresentation: Equatable {
    let kind: ChatActiveRunStatusKind
    /// When the run started, for the elapsed time after the label (TAL-446). Nil when the
    /// start is unknown or the status is not about a run in progress.
    public let runStartedAt: Date?

    /// `runStartedAt` is the stream's run start, seeded from the server's `pending_started_at`.
    public init(kind: ChatActiveRunStatusKind, runStartedAt: Date? = nil) {
        self.kind = kind
        switch kind {
        case .active, .checking, .reconnecting:
            self.runStartedAt = runStartedAt
        case .starting, .background, .waitingForNetwork, .stopping, .syncing:
            self.runStartedAt = nil
        }
    }

    /// The status for a stream recovery state; nil while the stream is healthy.
    public init?(recoveryState: ActiveStreamRecoveryState, runStartedAt: Date? = nil) {
        switch recoveryState {
        case .idle:
            return nil
        case .checking:
            self.init(kind: .checking, runStartedAt: runStartedAt)
        case .reconnecting:
            self.init(kind: .reconnecting, runStartedAt: runStartedAt)
        case .waitingForNetwork:
            self.init(kind: .waitingForNetwork, runStartedAt: runStartedAt)
        }
    }

    /// `agentName` is the session's `assistant_name` from the server.
    public func label(agentName: String) -> String {
        kind.label(agentName: agentName)
    }

    public func accessibilityLabel(agentName: String) -> String {
        kind.accessibilityLabel(agentName: agentName)
    }

    /// How long the run has gone on as of `now`, shown after the label in T3 Code's units (TAL-922):
    /// "42s" under a minute, "5m" under an hour, then "1h 30m". Nil when the chip shows no elapsed time.
    public func elapsedTime(now: Date, locale: Locale = .autoupdatingCurrent) -> String? {
        guard let seconds = elapsedSeconds(now: now) else { return nil }
        guard seconds >= 60 else {
            return Duration.seconds(seconds).formatted(.units(allowed: [.seconds], width: .narrow, zeroValueUnits: .show(length: 1)).locale(locale))
        }
        let units: Set<Duration.UnitsFormatStyle.Unit> = seconds < 3_600 ? [.minutes] : [.hours, .minutes]
        return Duration.seconds(seconds / 60 * 60).formatted(.units(allowed: units, width: .narrow, zeroValueUnits: .show(length: 1)).locale(locale))
    }

    /// How long the run has gone on as of `now`, read after the label: "running for 1 minute,
    /// 23 seconds". Nil when the chip shows no elapsed time.
    public func accessibilityElapsedTime(now: Date, locale: Locale = .autoupdatingCurrent) -> String? {
        guard let seconds = elapsedSeconds(now: now) else { return nil }
        let duration = Duration.seconds(seconds)
            .formatted(.units(allowed: [.hours, .minutes, .seconds], width: .wide).locale(locale))
        return String(localized: "running for \(duration)")
    }

    /// Whole seconds since the run started, never negative; nil without a start.
    private func elapsedSeconds(now: Date) -> Int? {
        runStartedAt.map { max(0, Int(now.timeIntervalSince($0))) }
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
    public static func presentation(
        isStartingChat: Bool,
        hasActiveStream: Bool,
        activeStreamRecoveryState: ActiveStreamRecoveryState,
        isCancellingStream: Bool,
        isSyncingTranscript: Bool = false,
        isBackgroundTurn: Bool = false,
        activeRunStartedAt: Date? = nil
    ) -> ChatActiveRunStatusPresentation? {
        if isCancellingStream {
            return ChatActiveRunStatusPresentation(kind: .stopping)
        }
        if isStartingChat {
            return ChatActiveRunStatusPresentation(kind: .starting)
        }

        // Syncing stands in for run progress and recovery until the transcript is current.
        if isSyncingTranscript {
            return ChatActiveRunStatusPresentation(kind: .syncing)
        }

        if let recovery = ChatActiveRunStatusPresentation(
            recoveryState: activeStreamRecoveryState,
            runStartedAt: activeRunStartedAt
        ) {
            return recovery
        }

        guard hasActiveStream else { return nil }
        return ChatActiveRunStatusPresentation(
            kind: isBackgroundTurn ? .background : .active,
            runStartedAt: activeRunStartedAt
        )
    }
}
