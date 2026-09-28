import Foundation
#if os(iOS)
import ActivityKit
#endif

public struct AgentRunActivityAttributes: Codable {
    public struct ContentState: Codable, Hashable {
        public var sessionID: String
        public var sessionTitle: String
        public var status: AgentRunActivityStatus
        public var currentActivity: String
        public var responseExcerpt: String
        public var startedAt: Date
        public var updatedAt: Date
        public var isStale: Bool
        public var isFinal: Bool
        public var errorSummary: String?

        public init(
            sessionID: String,
            sessionTitle: String,
            status: AgentRunActivityStatus,
            currentActivity: String,
            responseExcerpt: String = "",
            startedAt: Date,
            updatedAt: Date,
            isStale: Bool = false,
            isFinal: Bool = false,
            errorSummary: String? = nil
        ) {
            self.sessionID = sessionID
            self.sessionTitle = AgentRunActivitySanitizer.sessionTitle(sessionTitle)
            self.status = status
            self.currentActivity = AgentRunActivitySanitizer.activityLine(currentActivity)
            self.responseExcerpt = AgentRunActivitySanitizer.responseExcerpt(responseExcerpt)
            self.startedAt = startedAt
            self.updatedAt = updatedAt
            self.isStale = isStale
            self.isFinal = isFinal
            self.errorSummary = errorSummary.map(AgentRunActivitySanitizer.activityLine)
        }
    }

    public var sessionID: String
    var sessionTitle: String
    public var streamID: String?
    var startedAt: Date
    public var relayPublisherID: String?

    public init(
        sessionID: String,
        sessionTitle: String,
        streamID: String? = nil,
        startedAt: Date,
        relayPublisherID: String? = nil
    ) {
        self.sessionID = sessionID
        self.sessionTitle = AgentRunActivitySanitizer.sessionTitle(sessionTitle)
        self.streamID = AgentLiveActivityReusePolicy.normalizedStreamID(streamID)
        self.startedAt = startedAt
        self.relayPublisherID = relayPublisherID
    }
}

public struct TalariaAggregateActivityAttributes: Codable {
    public struct ContentState: Codable, Hashable {
        public struct Row: Codable, Hashable, Identifiable {
            var completionId: String? = nil
            public var streamId: String? = nil
            public var publisherId: String
            var publisherLabel: String
            public var sessionId: String
            public var title: String
            public var phase: String
            public var status: String
            public var updatedAt: Double
            var deepLink: String

            public init(completionId: String? = nil, streamId: String? = nil, publisherId: String, publisherLabel: String, sessionId: String, title: String, phase: String, status: String, updatedAt: Double, deepLink: String) {
                self.completionId = completionId
                self.streamId = streamId
                self.publisherId = publisherId
                self.publisherLabel = publisherLabel
                self.sessionId = sessionId
                self.title = title
                self.phase = phase
                self.status = status
                self.updatedAt = updatedAt
                self.deepLink = deepLink
            }

            public var id: String { "\(publisherId):\(sessionId)" }
        }

        var schemaVersion: Int
        public var activeCount: Int
        var title: String
        public var subtitle: String
        public var updatedAt: Double
        public var rows: [Row]

        public init(schemaVersion: Int, activeCount: Int, title: String, subtitle: String, updatedAt: Double, rows: [Row]) {
            self.schemaVersion = schemaVersion
            self.activeCount = activeCount
            self.title = title
            self.subtitle = subtitle
            self.updatedAt = updatedAt
            self.rows = rows
        }

        public var hasTerminalRows: Bool {
            rows.contains { ["completed", "failed", "cancelled"].contains($0.phase) }
        }
    }

    public init() {}
}

// ActivityKit is iOS-only; the conformances keep the attributes testable on macOS.
#if os(iOS)
extension AgentRunActivityAttributes: ActivityAttributes {}
extension TalariaAggregateActivityAttributes: ActivityAttributes {}
#endif

public enum TalariaAggregateLiveActivityPresentation {
    public static let lockScreenRowLimit = 5
    public static let expandedIslandRowLimit = 3

    public static func isEffectivelyStale(
        state: TalariaAggregateActivityAttributes.ContentState,
        isStale: Bool
    ) -> Bool {
        isStale && state.activeCount > 0
    }

    public static func headerText(
        state: TalariaAggregateActivityAttributes.ContentState,
        isStale: Bool
    ) -> String {
        isEffectivelyStale(state: state, isStale: isStale)
            ? String(localized: "Waiting for server")
            : state.subtitle
    }

    private static func outcomePhase(_ state: TalariaAggregateActivityAttributes.ContentState) -> String {
        if state.rows.contains(where: { $0.phase == "failed" }) { return "failed" }
        if !state.rows.isEmpty && state.rows.allSatisfy({ $0.phase == "cancelled" }) { return "cancelled" }
        return "completed"
    }

    public static func outcomeTitle(_ state: TalariaAggregateActivityAttributes.ContentState) -> String {
        switch outcomePhase(state) {
        case "failed": String(localized: "Failed")
        case "cancelled": String(localized: "Cancelled")
        default: String(localized: "Done")
        }
    }

    public static func statusText(_ status: String, isStale: Bool) -> String {
        isStale ? String(localized: "Waiting") : status
    }

    public static func signalPhase(
        state: TalariaAggregateActivityAttributes.ContentState,
        isStale: Bool
    ) -> String? {
        if isEffectivelyStale(state: state, isStale: isStale) { return "stale" }
        if state.activeCount == 0 && state.rows.allSatisfy({ ["completed", "failed", "cancelled"].contains($0.phase) }) {
            return outcomePhase(state)
        }
        return state.rows.first(where: {
            $0.phase == "waiting_for_approval" || $0.phase == "waiting_for_input"
        })?.phase ?? state.rows.first(where: { $0.phase == "failed" })?.phase
    }

    public static func colorHex(for phase: String, isLuminanceReduced: Bool = false) -> UInt32? {
        if isLuminanceReduced, phase != "starting", phase != "running" { return nil }

        switch phase {
        case "waiting_for_approval": return 0xD97706
        case "waiting_for_input": return 0x4F46E5
        case "failed": return 0xDC2626
        case "completed": return 0x059669
        case "starting", "running": return 0x0284C7
        default: return nil
        }
    }

    public static func signalSymbol(for phase: String) -> String {
        switch phase {
        case "waiting_for_approval": "exclamationmark.circle.fill"
        case "waiting_for_input": "questionmark.circle.fill"
        case "failed": "xmark.octagon.fill"
        case "completed": "checkmark.circle.fill"
        case "cancelled": "xmark.circle"
        case "stale": "clock.arrow.circlepath"
        default: "circle.fill"
        }
    }

    public static func accessibilityLabel(for phase: String) -> String {
        switch phase {
        case "waiting_for_approval": String(localized: "Approval needed")
        case "waiting_for_input": String(localized: "Input needed")
        case "failed": String(localized: "Agent work failed")
        case "completed": String(localized: "Done")
        case "cancelled": String(localized: "Cancelled")
        case "stale": String(localized: "Waiting for server")
        default: String(localized: "Agent status")
        }
    }
}

public enum TalariaLiveActivityMode: String, CaseIterable, Identifiable {
    case perSession
    case allRunning

    public static let storageKey = "liveActivity.mode"
    public static var current: Self {
        Self(rawValue: UserDefaults.standard.string(forKey: storageKey) ?? "") ?? .perSession
    }

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .perSession: String(localized: "Current session")
        case .allRunning: String(localized: "All running sessions")
        }
    }
}

public enum TalariaRelayNotifications {
    public static let isEnabledKey = "talariaRelay.notificationsEnabled"
    public static let pushTokenKey = "talariaRelay.pushToken"
    public static let pushToStartTokenKey = "talariaRelay.pushToStartToken"
}

public enum AgentRunActivityStatus: String, Codable, Hashable, CaseIterable {
    case starting
    case thinking
    case usingTool
    case searchingFiles
    case readingFiles
    case runningCommand
    case responding
    case waitingForApproval
    case waitingForClarification
    case complete
    case failed
    case cancelled

    public var title: String {
        switch self {
        case .starting:
            String(localized: "Starting")
        case .thinking:
            String(localized: "Thinking")
        case .usingTool:
            String(localized: "Using tool")
        case .searchingFiles:
            String(localized: "Searching files")
        case .readingFiles:
            String(localized: "Reading files")
        case .runningCommand:
            String(localized: "Running command")
        case .responding:
            String(localized: "Responding")
        case .waitingForApproval:
            String(localized: "Waiting for approval")
        case .waitingForClarification:
            String(localized: "Needs clarification")
        case .complete:
            String(localized: "Complete")
        case .failed:
            String(localized: "Failed")
        case .cancelled:
            String(localized: "Cancelled")
        }
    }

    public var compactTitle: String {
        switch self {
        case .starting:
            String(localized: "Start")
        case .thinking:
            String(localized: "Think")
        case .usingTool:
            String(localized: "Tool")
        case .searchingFiles:
            String(localized: "Search")
        case .readingFiles:
            String(localized: "Files")
        case .runningCommand:
            String(localized: "Cmd")
        case .responding:
            String(localized: "Reply")
        case .waitingForApproval:
            String(localized: "Approve")
        case .waitingForClarification:
            String(localized: "Clarify")
        case .complete:
            String(localized: "Done")
        case .failed:
            String(localized: "Fail")
        case .cancelled:
            String(localized: "Stop")
        }
    }
}

/// The server's display class for a tool call, sent as `kind` on live frames and persisted calls.
/// The app maps it to an icon and localized verb; it never classifies tool names itself.
/// Declared here because this file is shared with the Live Activity widget.
public enum ToolDisplayKind: String, Equatable, Sendable {
    case shell, read, list, search, web, write, skill, memory, delegate, unknown

    /// An older server sends no kind; an unrecognized one decodes as `.unknown`.
    public init?(serverValue: String?) {
        guard let serverValue else { return nil }
        self = ToolDisplayKind(rawValue: serverValue) ?? .unknown
    }
}

enum AgentRunActivityToolKind: Equatable {
    case generic(String)
    case search
    case files
    case command
}

public enum AgentRunActivitySanitizer {
    static let maximumSessionTitleCharacters = 42
    static let maximumActivityCharacters = 64
    static let maximumExcerptCharacters = 140
    static let maximumToolLabelCharacters = 28

    public static func sessionTitle(_ rawValue: String) -> String {
        let normalized = normalizedSingleLine(rawValue)
        return trimmed(normalized.isEmpty ? String(localized: "Hermes session") : normalized, limit: maximumSessionTitleCharacters)
    }

    static func activityLine(_ rawValue: String) -> String {
        trimmed(normalizedSingleLine(rawValue), limit: maximumActivityCharacters)
    }

    static func responseExcerpt(_ rawValue: String) -> String {
        let normalized = normalizedSingleLine(rawValue)
        return trimmed(normalized, limit: maximumExcerptCharacters)
    }

    /// The Live Activity phase for the server's tool kind; other kinds show the tool's name.
    static func toolKind(_ kind: ToolDisplayKind?, name: String?) -> AgentRunActivityToolKind {
        switch kind {
        case .shell: .command
        case .search: .search
        case .read, .list: .files
        default: .generic(toolLabel(name))
        }
    }

    static func toolLabel(_ rawValue: String?) -> String {
        let fallback = String(localized: "tool")
        guard let rawValue else { return fallback }

        let noPathSeparators = rawValue
            .replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/")
            .last
            .map(String.init) ?? rawValue
        let words = noPathSeparators
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
        let normalized = normalizedSingleLine(words)
        return trimmed(normalized.isEmpty ? fallback : normalized, limit: maximumToolLabelCharacters)
    }

    private static func normalizedSingleLine(_ rawValue: String) -> String {
        rawValue
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func trimmed(_ value: String, limit: Int) -> String {
        guard value.count > limit else { return value }
        guard limit > 3 else {
            return String(value.prefix(limit))
        }

        let endIndex = value.index(value.startIndex, offsetBy: limit - 3)
        return String(value[..<endIndex]) + "..."
    }
}

public enum AgentRunElapsedTimeFormatter {
    public static func label(startedAt: Date, updatedAt: Date) -> String {
        let elapsedSeconds = max(0, Int(updatedAt.timeIntervalSince(startedAt).rounded(.down)))
        let hours = elapsedSeconds / 3_600
        let minutes = (elapsedSeconds % 3_600) / 60
        let seconds = elapsedSeconds % 60

        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }

        return String(format: "%02d:%02d", minutes, seconds)
    }
}

public enum AgentLiveActivityReusePolicy {
    public static func isViewedCompletion(
        state: AgentRunActivityAttributes.ContentState, publisherID: String?,
        viewedPublisherID: String, viewedSessionID: String, through viewedAt: Date
    ) -> Bool {
        state.isFinal && publisherID == viewedPublisherID
            && state.sessionID == viewedSessionID && state.updatedAt <= viewedAt
    }

    public static func preservesCompletedActivity(isFinal: Bool, relayPublisherID: String?) -> Bool {
        isFinal && relayPublisherID != nil
    }

    public static func normalizedStreamID(_ streamID: String?) -> String? {
        guard let streamID else { return nil }

        let normalized = streamID.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
    }

    public static func canReuseActivity(
        existingSessionID: String,
        existingStreamID: String?,
        requestedSessionID: String,
        requestedStreamID: String?
    ) -> Bool {
        existingSessionID == requestedSessionID
            && normalizedStreamID(existingStreamID) == normalizedStreamID(requestedStreamID)
    }
}

public enum AgentRunActivityStateReducer {
    public static func updatingSessionTitle(
        _ title: String,
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: title,
            status: state.status,
            currentActivity: state.currentActivity,
            responseExcerpt: state.responseExcerpt,
            startedAt: state.startedAt,
            updatedAt: now,
            isStale: state.isStale,
            isFinal: state.isFinal,
            errorSummary: state.errorSummary
        )
    }

    /// `startedAt` may be backdated to the server's run start; `updatedAt` is
    /// when this process attached, so the orphan reconciler's recency window
    /// still measures local staleness rather than run age.
    public static func initialState(
        sessionID: String,
        sessionTitle: String,
        startedAt: Date = Date(),
        updatedAt: Date? = nil
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: sessionID,
            sessionTitle: sessionTitle,
            status: .starting,
            currentActivity: String(localized: "Starting response"),
            startedAt: startedAt,
            updatedAt: updatedAt ?? startedAt
        )
    }

    static func appendingToken(
        _ text: String,
        to state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        guard !text.isEmpty else { return state }
        return AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: .responding,
            currentActivity: String(localized: "Writing response"),
            responseExcerpt: state.responseExcerpt + text,
            startedAt: state.startedAt,
            updatedAt: now
        )
    }

    public static func settingInterimAssistant(
        _ text: String,
        on state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        let excerpt = AgentRunActivitySanitizer.responseExcerpt(text)
        guard !excerpt.isEmpty else { return state }
        return AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: .responding,
            currentActivity: String(localized: "Writing response"),
            responseExcerpt: excerpt,
            startedAt: state.startedAt,
            updatedAt: now
        )
    }

    public static func clearingResponseExcerpt(
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: state.status,
            currentActivity: state.currentActivity,
            responseExcerpt: "",
            startedAt: state.startedAt,
            updatedAt: now,
            isStale: state.isStale,
            isFinal: state.isFinal,
            errorSummary: state.errorSummary
        )
    }

    public static func reasoning(
        _ text: String,
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        let activity = String(localized: "Thinking")
        return statusState(.thinking, activity: activity, state: state, now: now)
    }

    public static func toolStarted(
        kind: ToolDisplayKind?,
        name: String?,
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        switch AgentRunActivitySanitizer.toolKind(kind, name: name) {
        case .command:
            return statusState(.runningCommand, activity: String(localized: "Running command"), state: state, now: now)
        case .search:
            return statusState(.searchingFiles, activity: String(localized: "Searching files"), state: state, now: now)
        case .files:
            return statusState(.readingFiles, activity: String(localized: "Reading files"), state: state, now: now)
        case .generic(let label):
            return statusState(.usingTool, activity: String(localized: "Using \(label)"), state: state, now: now)
        }
    }

    public static func toolCompleted(
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        statusState(.responding, activity: String(localized: "Processing result"), state: state, now: now)
    }

    public static func waitingForApproval(
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        statusState(.waitingForApproval, activity: String(localized: "Waiting for approval"), state: state, now: now)
    }

    public static func waitingForClarification(
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        statusState(.waitingForClarification, activity: String(localized: "Needs clarification"), state: state, now: now)
    }

    public static func stale(
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: state.status,
            currentActivity: state.currentActivity.isEmpty ? String(localized: "Latest status shown") : state.currentActivity,
            responseExcerpt: state.responseExcerpt,
            startedAt: state.startedAt,
            updatedAt: now,
            isStale: true,
            isFinal: state.isFinal,
            errorSummary: state.errorSummary
        )
    }

    public static func final(
        status: AgentRunActivityStatus,
        activity: String,
        state: AgentRunActivityAttributes.ContentState,
        errorSummary: String? = nil,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: status,
            currentActivity: activity,
            responseExcerpt: state.responseExcerpt,
            startedAt: state.startedAt,
            updatedAt: now,
            isStale: false,
            isFinal: true,
            errorSummary: errorSummary
        )
    }

    private static func statusState(
        _ status: AgentRunActivityStatus,
        activity: String,
        state: AgentRunActivityAttributes.ContentState,
        now: Date
    ) -> AgentRunActivityAttributes.ContentState {
        AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: status,
            currentActivity: activity,
            responseExcerpt: state.responseExcerpt,
            startedAt: state.startedAt,
            updatedAt: now
        )
    }
}
