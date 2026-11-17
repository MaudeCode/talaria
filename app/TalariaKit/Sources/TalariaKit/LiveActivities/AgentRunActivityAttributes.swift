import Foundation
#if os(iOS)
import ActivityKit
#endif

public struct AgentRunActivityAttributes: Codable, Sendable {
    public struct ContentState: Codable, Hashable, Sendable {
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
        /// TAL-1463: Relay's `approvalHeadId` for the approval this run waits on; Allow and Deny answer only it.
        public var approvalHeadID: String?
        /// TAL-1463: what that approval runs, from the App's own stream. Relay never sends it, so a relay-driven
        /// activity offers Deny and Open; Allow needs the whole text on screen.
        public var approvalText: String?
        /// TAL-1488: Deny was tapped and waits out its Undo window; the activity reads "Denied · Undo". Device-local: Relay
        /// and the App's stream never send it, so their next update clears it.
        public var isDenying: Bool?
        /// TAL-874: Relay's tool calls the run started and its last phase change or tool event. Absent from the App's own
        /// stream and from an older Relay or Web.
        public var toolCount: Int?
        public var activityAt: Date?
        /// TAL-1422: the server's plan progress for this run and the session's running workers, from Relay or the App's own
        /// server reads. 0 clears a count; nil is a server or Relay that sends none.
        public var planCompleted: Int?
        public var planTotal: Int?
        public var workerCount: Int?
        /// TAL-2336: the run's current call, from Relay or the App's own stream; nil before its first call, once the run
        /// moved on to thinking or writing, and from an older Relay or Web.
        public var currentTool: AgentRunActivityTool?

        /// TAL-1422: the plan and worker counts to show, or nil when there are none.
        public var workCounts: AgentRunWorkCounts? {
            AgentRunWorkCounts(planCompleted: planCompleted, planTotal: planTotal, workerCount: workerCount)
        }

        /// TAL-2336: the call the activity line shows in place of `currentActivity`: none once the run finished or failed,
        /// and none while stale unless it still waits on the user, as `lockScreenLead` decides.
        public var shownTool: AgentRunActivityTool? {
            guard !isFinal, errorSummary?.isEmpty ?? true else { return nil }
            if isStale, status != .waitingForApproval, status != .waitingForClarification { return nil }
            return currentTool
        }

        /// The lock screen's lead line. A stale activity still waiting on the user keeps its ask.
        public var lockScreenLead: String {
            if isStale, status != .waitingForApproval, status != .waitingForClarification {
                return String(localized: "Latest status shown")
            }
            if let errorSummary, !errorSummary.isEmpty {
                return errorSummary
            }
            return currentActivity
        }

        /// TAL-2037: the small family's second line (Apple Watch Smart Stack, CarPlay): the elapsed timer while working,
        /// otherwise the ask or outcome title. Stale work shows the Lock Screen's stale wording; a stale ask stays an ask.
        public var smallDetail: AgentRunSmallDetail {
            guard status.isWorking, !isFinal else { return .text(status.title) }
            return isStale ? .text(lockScreenLead) : .timer(startedAt: startedAt)
        }

        public func hasSameContent(as other: Self) -> Bool {
            var comparison = other
            comparison.updatedAt = updatedAt
            return self == comparison
        }

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
            errorSummary: String? = nil,
            approvalHeadID: String? = nil,
            approvalText: String? = nil,
            toolCount: Int? = nil,
            activityAt: Date? = nil,
            planCompleted: Int? = nil,
            planTotal: Int? = nil,
            workerCount: Int? = nil,
            currentTool: AgentRunActivityTool? = nil
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
            self.approvalHeadID = approvalHeadID
            self.approvalText = approvalText
            self.toolCount = toolCount
            self.activityAt = activityAt
            self.planCompleted = planCompleted
            self.planTotal = planTotal
            self.workerCount = workerCount
            self.currentTool = currentTool
        }
    }

    public var sessionID: String
    public var sessionTitle: String
    public var streamID: String?
    public var startedAt: Date
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

public struct TalariaAggregateActivityAttributes: Codable, Sendable {
    public struct ContentState: Codable, Hashable, Sendable {
        public struct Row: Codable, Hashable, Identifiable, Sendable {
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
            /// TAL-1463: the approval a waiting row shows, so Allow and Deny answer only it.
            public var approvalHeadId: String? = nil
            /// TAL-1488: Deny waits out its Undo window on this row. Device-local, like `answerError`.
            public var isDenying: Bool? = nil
            /// TAL-1422: the row's plan progress and running workers, as Relay sends them.
            public var planCompleted: Int? = nil
            public var planTotal: Int? = nil
            public var workerCount: Int? = nil
            /// TAL-2336: the row's current call, as Relay sends it.
            public var currentTool: AgentRunActivityTool? = nil

            public var workCounts: AgentRunWorkCounts? {
                AgentRunWorkCounts(planCompleted: planCompleted, planTotal: planTotal, workerCount: workerCount)
            }

            /// TAL-2336: the call a working row shows in place of its status word.
            public var shownTool: AgentRunActivityTool? {
                TalariaAggregateLiveActivityPresentation.isWorking(phase) ? currentTool : nil
            }

            public init(completionId: String? = nil, streamId: String? = nil, publisherId: String, publisherLabel: String, sessionId: String, title: String, phase: String, status: String, updatedAt: Double, deepLink: String, approvalHeadId: String? = nil, planCompleted: Int? = nil, planTotal: Int? = nil, workerCount: Int? = nil, currentTool: AgentRunActivityTool? = nil) {
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
                self.approvalHeadId = approvalHeadId
                self.planCompleted = planCompleted
                self.planTotal = planTotal
                self.workerCount = workerCount
                self.currentTool = currentTool
            }

            public var id: String { "\(publisherId):\(sessionId)" }
        }

        var schemaVersion: Int
        public var isFinal: Bool? = nil
        public var isStale: Bool? = nil
        public var activeCount: Int
        var title: String
        public var subtitle: String
        public var updatedAt: Double
        public var rows: [Row]
        /// Why an answer from the activity was refused (TAL-1463). Device-local: the relay never sends it, so its next
        /// snapshot clears it.
        public var answerError: String? = nil

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

public enum TalariaAggregateLiveActivityPresentation: Sendable {
    public static let lockScreenRowLimit = 5
    public static let expandedIslandRowLimit = 3

    public static func isEffectivelyStale(
        state: TalariaAggregateActivityAttributes.ContentState,
        isStale: Bool
    ) -> Bool {
        (isStale && !(state.isFinal ?? (state.activeCount == 0)))
            || state.isStale == true
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

    public static func colorHex(for phase: String) -> UInt32? {
        switch phase {
        case "waiting_for_approval": 0xD97706
        case "waiting_for_input": 0x4F46E5
        case "failed": 0xDC2626
        case "completed": 0x059669
        case "starting", "running": 0x0284C7
        default: nil
        }
    }

    /// Work in progress, which keeps its hue on the dimmed Lock Screen (`LiveActivityPalette.tint(isWorking:)`).
    public static func isWorking(_ phase: String) -> Bool {
        phase == "starting" || phase == "running"
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

public enum TalariaLiveActivityMode: String, CaseIterable, Identifiable, Sendable {
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
    /// TAL-873: completion alerts for turns a finished sub-agent or background process started; off by default.
    public static let backgroundAlertsEnabledKey = "talariaRelay.backgroundAlertsEnabled"
    public static let pushTokenKey = "talariaRelay.pushToken"
    public static let pushToStartTokenKey = "talariaRelay.pushToStartToken"
}

/// TAL-1422: the plan progress and running workers a Live Activity shows, as the server counted them. The App only words
/// and formats them; a plan with nothing open or no running workers arrives as 0 and shows nothing.
public struct AgentRunWorkCounts: Equatable, Sendable {
    public let plan: (completed: Int, total: Int)?
    public let workers: Int?

    /// Nil when there is nothing to show.
    public init?(planCompleted: Int?, planTotal: Int?, workerCount: Int?) {
        let plan = planTotal.flatMap { total in total > 0 ? (completed: planCompleted ?? 0, total: total) : nil }
        let workers = workerCount.flatMap { $0 > 0 ? $0 : nil }
        guard plan != nil || workers != nil else { return nil }
        self.plan = plan
        self.workers = workers
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.plan?.completed == rhs.plan?.completed && lhs.plan?.total == rhs.plan?.total && lhs.workers == rhs.workers
    }

    /// "Plan 2/5 · 3 workers".
    public var text: String {
        [
            plan.map { String(localized: "Plan \($0.completed)/\($0.total)") },
            workers.map { String(localized: "\($0) workers") },
        ].compactMap { $0 }.joined(separator: " · ")
    }

    /// "Plan steps done: 2 of 5, 3 workers running".
    public var accessibilityLabel: String {
        [
            plan.map { String(localized: "Plan steps done: \($0.completed) of \($0.total)") },
            workers.map { String(localized: "\($0) workers running") },
        ].compactMap { $0 }.joined(separator: ", ")
    }
}

/// TAL-2037: the second line of the small family: the elapsed timer from `startedAt`, or a status word.
public enum AgentRunSmallDetail: Equatable, Sendable {
    case timer(startedAt: Date)
    case text(String)
}

public enum AgentRunActivityStatus: String, Codable, Hashable, CaseIterable, Sendable {
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
            String(localized: "Input")
        case .complete:
            String(localized: "Complete")
        case .failed:
            String(localized: "Failed")
        case .cancelled:
            String(localized: "Cancelled")
        }
    }

    /// Work in progress: neither waiting on the user nor finished.
    public var isWorking: Bool {
        switch self {
        case .starting, .thinking, .usingTool, .searchingFiles, .readingFiles, .runningCommand, .responding: true
        case .waitingForApproval, .waitingForClarification, .complete, .failed, .cancelled: false
        }
    }

    /// The compact island's trailing word: nil while working, since the leading glyph already shows the phase.
    public var compactTitle: String? {
        switch self {
        case .starting, .thinking, .usingTool, .searchingFiles, .readingFiles, .runningCommand, .responding:
            nil
        case .waitingForApproval:
            String(localized: "Approve")
        case .waitingForClarification:
            String(localized: "Input")
        case .complete:
            String(localized: "Done")
        case .failed:
            String(localized: "Failed")
        case .cancelled:
            String(localized: "Stopped")
        }
    }
}

/// The server's display class for a tool call, sent as `kind` on live frames and persisted calls.
/// The app maps it to an icon and localized verb; it never classifies tool names itself.
/// Declared here because this file is shared with the Live Activity widget.
public enum ToolDisplayKind: String, CaseIterable, Equatable, Sendable {
    case shell, read, list, search, web, write, skill, memory, delegate, talaria, unknown
    /// TAL-2325: a tool that generates an image, speech or a video, or describes an image or a video.
    case image, audio, video
    case imageAnalysis = "image_analysis"
    case videoAnalysis = "video_analysis"
    /// TAL-2326: a past-chat search, a scheduled job, a connected app and a question to the user.
    case session, schedule, connection, question
    /// TAL-2327: a Kanban task read or changed; its `ToolVerb` picks the verb.
    case kanban
    /// TAL-2328: the agent's browser (code, a CDP command, a dialog, saved logins) and the desktop (`computer_use`).
    case browser, computer
    /// TAL-2330: an MCP server's tool and a hosted connector's; each names its app in `ToolCall.app`.
    case mcp, connector

    /// An older server sends no kind; an unrecognized one decodes as `.unknown`.
    public init?(serverValue: String?) {
        guard let serverValue else { return nil }
        self = ToolDisplayKind(rawValue: serverValue) ?? .unknown
    }
}

/// TAL-2327: what a call of a kind whose tools act differently (`kanban`) does, which picks its verb; an unknown value
/// decodes as nil and the call reads with its kind's own phrase. TAL-2328: and what a `browser` or `computer` call does.
public enum ToolVerb: String, Equatable, Sendable {
    case create, view, list, update, complete, block, comment
    case run, send, answer, fill, capture, click, type

    public init?(serverValue: String?) {
        guard let serverValue, let verb = ToolVerb(rawValue: serverValue) else { return nil }
        self = verb
    }
}

/// TAL-2336: the call a Live Activity names, with its transcript row's server fields (`ActivityToolSchema`): its kind,
/// redacted target, whether it finished, a verb and app where its kind has one, and its outcome. Relay sends it as
/// `currentTool`; the App's own stream builds it from the same fields of its tool frames. Every field decodes as sent, so an
/// unknown kind, verb or outcome key reads as the transcript reads it rather than failing the activity.
public struct AgentRunActivityTool: Codable, Hashable, Sendable {
    public struct App: Codable, Hashable, Sendable {
        public var name: String
    }

    public struct Outcome: Codable, Hashable, Sendable {
        public var key: String
        public var tone: String
        public var count: Int?
        public var value: String?
    }

    public var kind: String
    public var target: String
    public var done: Bool
    /// The call failed (the server's `is_error`); nil when it did not.
    public var failed: Bool?
    public var verb: String?
    public var app: App?
    public var outcome: Outcome?

    public init(kind: String, target: String, done: Bool, failed: Bool? = nil, verb: String? = nil, app: App? = nil, outcome: Outcome? = nil) {
        self.kind = kind
        self.target = target
        self.done = done
        self.failed = failed
        self.verb = verb
        self.app = app
        self.outcome = outcome
    }

    /// A call as the App's stream or an approval carries it; an older server's call without a kind reads as an unknown tool.
    public init(_ call: ToolCall, outcome: ToolOutcome? = nil) {
        self.init(
            kind: call.kind?.rawValue ?? ToolDisplayKind.unknown.rawValue,
            target: call.target ?? "",
            done: call.isCompleted,
            failed: call.isError == true ? true : nil,
            verb: call.verb?.rawValue,
            app: call.app.map { App(name: $0.name) },
            outcome: (outcome ?? call.resultView?.outcome).map {
                Outcome(key: $0.key.rawValue, tone: $0.tone.rawValue, count: $0.count, value: $0.value)
            }
        )
    }

    /// A call as its live `tool` (`done` false) or `tool_complete` frame carries it.
    public init(_ event: ToolStreamEvent, done: Bool) {
        self.init(
            kind: event.kind?.rawValue ?? ToolDisplayKind.unknown.rawValue,
            target: event.target ?? "",
            done: done,
            failed: event.isError == true ? true : nil,
            verb: event.verb?.rawValue,
            app: event.app.map { App(name: $0.name) },
            outcome: event.resultView?.outcome.map {
                Outcome(key: $0.key.rawValue, tone: $0.tone.rawValue, count: $0.count, value: $0.value)
            }
        )
    }

    /// TAL-2336: the call an approval holds, still running and waiting on the user, as the server marks it on Relay.
    public static func held(_ call: ToolCall) -> Self {
        Self(call, outcome: ToolOutcome(key: .pendingApproval, tone: .attention))
    }

    /// The call as a transcript row, so the activity names it with the transcript's own icon and label.
    public var toolCall: ToolCall {
        ToolCall(
            id: "activity-tool", name: nil, preview: nil, args: nil,
            kind: ToolDisplayKind(serverValue: kind), verb: ToolVerb(serverValue: verb), app: app.map { ToolApp(name: $0.name) },
            target: target.isEmpty ? nil : target, resultView: toolOutcome.map { ToolResultView(outcome: $0) },
            isError: failed, isCompleted: done, startedAt: 0
        )
    }

    /// The outcome the App can word; an unknown key or tone shows none.
    public var toolOutcome: ToolOutcome? {
        guard let outcome, let key = ToolOutcome.Key(rawValue: outcome.key), let tone = ToolOutcome.Tone(rawValue: outcome.tone) else {
            return nil
        }
        return ToolOutcome(key: key, tone: tone, count: outcome.count, value: outcome.value)
    }

    /// "Running npm test", "Used session_send": the transcript row's label.
    public var label: String { AssistantActivitySummary.label(for: toolCall) }
    /// The transcript row's icon: an SF Symbol, or `AssistantActivitySummary.talariaMarkIcon` for the Talaria mark.
    public var icon: String { AssistantActivitySummary.icon(for: toolCall) }
    /// "Waiting for approval", "Exit 1": the outcome as the transcript words it.
    public var outcomeText: String? { toolOutcome?.text }

    /// The activity status for the call's kind, which picks the status glyph.
    var status: AgentRunActivityStatus {
        switch ToolDisplayKind(serverValue: kind) {
        case .shell: .runningCommand
        case .search: .searchingFiles
        case .read, .list: .readingFiles
        default: .usingTool
        }
    }
}

public enum AgentRunActivitySanitizer: Sendable {
    static let maximumSessionTitleCharacters = 42
    static let maximumActivityCharacters = 64
    static let maximumExcerptCharacters = 140
    /// About two lines of an activity's monospaced caption, so the text and its buttons fit a Lock Screen activity.
    static let maximumApprovalTextCharacters = 80
    static let maximumResponsePrefixScalars = 1_024

    public static func sessionTitle(_ rawValue: String) -> String {
        let normalized = normalizedSingleLine(rawValue)
        return trimmed(normalized.isEmpty ? String(localized: "Hermes session") : normalized, limit: maximumSessionTitleCharacters)
    }

    static func activityLine(_ rawValue: String) -> String {
        trimmed(normalizedSingleLine(rawValue), limit: maximumActivityCharacters)
    }

    public static func responsePrefix(_ rawValue: String) -> (text: String, isFull: Bool) {
        let normalized = normalizedSingleLine(rawValue)
        // Grapheme clusters can contain unbounded combining marks; reserve room for the ellipsis.
        let scalarLimit = maximumResponsePrefixScalars - 3
        let scalars = normalized.unicodeScalars.prefix(scalarLimit + 1)
        let bounded = String(String.UnicodeScalarView(scalars.prefix(scalarLimit)))
        if scalars.count > scalarLimit {
            return (String(bounded.prefix(maximumExcerptCharacters - 3)) + "...", true)
        }
        let isFull = bounded.count > maximumExcerptCharacters
        // One extra non-whitespace character must survive trimming at the cutoff.
        var prefix = String(bounded.prefix(maximumExcerptCharacters + 2))
        // Keep a separator split across tokens, without retaining the whitespace itself.
        if !isFull, !prefix.isEmpty,
           rawValue.unicodeScalars.last.map({ CharacterSet.whitespacesAndNewlines.contains($0) }) == true {
            prefix += " "
        }
        return (prefix, isFull)
    }

    /// The approval's text on one line, or nil when it is empty or longer than an activity shows: Allow is never offered
    /// beside a shortened text.
    static func approvalText(_ rawValue: String) -> String? {
        let normalized = normalizedSingleLine(rawValue)
        return normalized.isEmpty || normalized.count > maximumApprovalTextCharacters ? nil : normalized
    }

    static func responseExcerpt(_ rawValue: String) -> String {
        let normalized = normalizedSingleLine(rawValue)
        return trimmed(normalized, limit: maximumExcerptCharacters)
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

    /// A persisted current-session activity, with the stream of the run that owns it now.
    public struct Candidate: Equatable, Sendable {
        public var id: String
        public var sessionID: String
        public var streamID: String?
        public var isFinal: Bool
        public var relayPublisherID: String?

        public init(id: String, sessionID: String, streamID: String?, isFinal: Bool, relayPublisherID: String?) {
            self.id = id
            self.sessionID = sessionID
            self.streamID = AgentLiveActivityReusePolicy.normalizedStreamID(streamID)
            self.isFinal = isFinal
            self.relayPublisherID = relayPublisherID
        }
    }

    /// The activity a new or reattached run drives: its own live activity, else the retained
    /// relay-backed completion of the same publisher and session, restarted in place (TAL-192).
    public static func reusableActivityID(
        in candidates: [Candidate], sessionID: String, streamID: String?,
        publisherID: String?, registeredActivityID: String?
    ) -> String? {
        let streamID = normalizedStreamID(streamID)
        let live = candidates.first { candidate in
            !candidate.isFinal && candidate.sessionID == sessionID && candidate.streamID == streamID
                && (publisherID == nil || candidate.relayPublisherID == publisherID || candidate.id == registeredActivityID)
        }
        if let live { return live.id }
        guard let publisherID else { return nil }
        return candidates.first { candidate in
            candidate.isFinal && candidate.relayPublisherID == publisherID && candidate.sessionID == sessionID
        }?.id
    }

    /// Whether an acknowledged relay completion belongs to the run that owns `candidate`.
    public static func completion(
        _ row: TalariaAggregateActivityAttributes.ContentState.Row, matches candidate: Candidate
    ) -> Bool {
        row.publisherId == candidate.relayPublisherID && row.sessionId == candidate.sessionID
            && candidate.streamID != nil && normalizedStreamID(row.streamId) == candidate.streamID
    }

    static let streamBindingsKey = "liveActivity.streamBindings"

    /// The run that owns an activity. ActivityKit attributes are immutable and relay pushes
    /// replace the content without a stream, so a reused card's run is recorded locally.
    public static func effectiveStreamID(
        activityID: String, attributeStreamID: String?, defaults: UserDefaults = .standard
    ) -> String? {
        guard let bound = defaults.dictionary(forKey: streamBindingsKey)?[activityID] as? String else {
            return normalizedStreamID(attributeStreamID)
        }
        return normalizedStreamID(bound)
    }

    /// Records that `streamID` now owns `activityID`, dropping bindings of ended activities.
    public static func bindStream(
        _ streamID: String?, toActivityID activityID: String,
        liveActivityIDs: Set<String>, defaults: UserDefaults = .standard
    ) {
        var bindings = (defaults.dictionary(forKey: streamBindingsKey) as? [String: String] ?? [:])
            .filter { liveActivityIDs.contains($0.key) }
        // An empty value records a run without a stream, so the attribute's stale run is not used.
        bindings[activityID] = normalizedStreamID(streamID) ?? ""
        defaults.set(bindings, forKey: streamBindingsKey)
    }
}

public enum AgentRunActivityStateReducer {
    public static func updatingSessionTitle(
        _ title: String,
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        keepingTool(of: state, in: AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: title,
            status: state.status,
            currentActivity: state.currentActivity,
            responseExcerpt: state.responseExcerpt,
            startedAt: state.startedAt,
            updatedAt: now,
            isStale: state.isStale,
            isFinal: state.isFinal,
            errorSummary: state.errorSummary,
            approvalHeadID: state.approvalHeadID,
            approvalText: state.approvalText
        ))
    }

    /// TAL-1422: the server's plan progress for the run, from its `todo_state` frame. A frame of another chat changes nothing.
    public static func settingPlanProgress(
        completed: Int, total: Int, sessionID: String,
        state: AgentRunActivityAttributes.ContentState, now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        guard state.sessionID == sessionID, !state.isFinal else { return state }
        var result = state
        result.planCompleted = completed
        result.planTotal = total
        result.updatedAt = now
        return result
    }

    /// TAL-1422: the server's count of the chat's running workers, from its background-work read.
    public static func settingWorkerCount(
        _ count: Int, sessionID: String,
        state: AgentRunActivityAttributes.ContentState, now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        guard state.sessionID == sessionID else { return state }
        var result = state
        result.workerCount = count
        result.updatedAt = now
        return result
    }

    /// TAL-1422: the plan and worker counts come only from the server, so a local status change keeps them.
    private static func keepingWorkCounts(
        of state: AgentRunActivityAttributes.ContentState,
        in next: AgentRunActivityAttributes.ContentState
    ) -> AgentRunActivityAttributes.ContentState {
        var result = next
        result.planCompleted = state.planCompleted
        result.planTotal = state.planTotal
        result.workerCount = state.workerCount
        return result
    }

    /// TAL-2336: a change that is not the run's next step (a rename, a cleared excerpt, going stale) keeps the call shown.
    private static func keepingTool(
        of state: AgentRunActivityAttributes.ContentState,
        in next: AgentRunActivityAttributes.ContentState
    ) -> AgentRunActivityAttributes.ContentState {
        var result = keepingWorkCounts(of: state, in: next)
        result.currentTool = state.currentTool
        return result
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
        return keepingWorkCounts(of: state, in: AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: .responding,
            currentActivity: String(localized: "Writing response"),
            responseExcerpt: state.responseExcerpt + text,
            startedAt: state.startedAt,
            updatedAt: now
        ))
    }

    public static func settingInterimAssistant(
        _ text: String,
        on state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        let excerpt = AgentRunActivitySanitizer.responseExcerpt(text)
        guard !excerpt.isEmpty else { return state }
        var result = continuingAssistant(on: state, now: now)
        result.responseExcerpt = excerpt
        result.updatedAt = now
        return result
    }

    public static func continuingAssistant(
        on state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        let activity = String(localized: "Writing response")
        guard state.status != .responding || state.currentActivity != activity
                || state.isStale || state.isFinal || state.errorSummary != nil else { return state }
        var result = state
        result.status = .responding
        result.currentActivity = activity
        result.updatedAt = now
        result.isStale = false
        result.isFinal = false
        result.errorSummary = nil
        return result
    }

    public static func clearingResponseExcerpt(
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        keepingTool(of: state, in: AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: state.status,
            currentActivity: state.currentActivity,
            responseExcerpt: "",
            startedAt: state.startedAt,
            updatedAt: now,
            isStale: state.isStale,
            isFinal: state.isFinal,
            errorSummary: state.errorSummary,
            approvalHeadID: state.approvalHeadID,
            approvalText: state.approvalText
        ))
    }

    public static func reasoning(
        _ text: String,
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        let activity = String(localized: "Thinking")
        return statusState(.thinking, activity: activity, state: state, now: now)
    }

    /// TAL-2336: the activity names the call that started, as its transcript row does.
    public static func toolStarted(
        _ tool: AgentRunActivityTool,
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        var result = statusState(tool.status, activity: tool.label, state: state, now: now)
        result.currentTool = tool
        return result
    }

    /// TAL-2336: the call finished; it stays named, in the past tense with its outcome, until the run moves on. A completion
    /// frame without its target or kind (the start frame carried them) keeps the ones shown.
    public static func toolCompleted(
        _ tool: AgentRunActivityTool,
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        var completed = tool
        completed.done = true
        if completed.target.isEmpty, let shown = state.currentTool,
           shown.kind == completed.kind || completed.kind == ToolDisplayKind.unknown.rawValue {
            completed.kind = shown.kind
            completed.target = shown.target
            completed.app = completed.app ?? shown.app
            completed.verb = completed.verb ?? shown.verb
        }
        var result = statusState(.responding, activity: String(localized: "Processing result"), state: state, now: now)
        result.currentTool = completed
        return result
    }

    /// `approvalHeadID` names the approval the activity shows; without one, it offers Open instead of Allow and Deny.
    /// `approvalText` is what it runs, shown beside Allow; a text too long for an activity is left out.
    /// TAL-2336: `tool` is the call the approval holds (the server's `tool`), which the activity names as waiting.
    public static func waitingForApproval(
        state: AgentRunActivityAttributes.ContentState,
        approvalHeadID: String? = nil,
        approvalText: String? = nil,
        tool: AgentRunActivityTool? = nil,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        var result = statusState(.waitingForApproval, activity: String(localized: "Waiting for approval"), state: state, now: now)
        result.approvalHeadID = approvalHeadID
        result.approvalText = approvalText.flatMap(AgentRunActivitySanitizer.approvalText)
        result.currentTool = tool
        return result
    }

    public static func promptSettled(
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        statusState(.thinking, activity: String(localized: "Working"), state: state, now: now)
    }

    public static func waitingForClarification(
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        statusState(.waitingForClarification, activity: String(localized: "Input"), state: state, now: now)
    }

    public static func stale(
        state: AgentRunActivityAttributes.ContentState,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        keepingTool(of: state, in: AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: state.status,
            currentActivity: state.currentActivity.isEmpty ? String(localized: "Latest status shown") : state.currentActivity,
            responseExcerpt: state.responseExcerpt,
            startedAt: state.startedAt,
            updatedAt: now,
            isStale: true,
            isFinal: state.isFinal,
            errorSummary: state.errorSummary,
            approvalHeadID: state.approvalHeadID,
            approvalText: state.approvalText
        ))
    }

    public static func final(
        status: AgentRunActivityStatus,
        activity: String,
        state: AgentRunActivityAttributes.ContentState,
        errorSummary: String? = nil,
        now: Date = Date()
    ) -> AgentRunActivityAttributes.ContentState {
        var result = keepingWorkCounts(of: state, in: AgentRunActivityAttributes.ContentState(
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
        ))
        // A finished run has no plan left to track, as the server clears it; its session's workers may still run.
        result.planCompleted = state.planTotal.map { _ in 0 }
        result.planTotal = state.planTotal.map { _ in 0 }
        return result
    }

    private static func statusState(
        _ status: AgentRunActivityStatus,
        activity: String,
        state: AgentRunActivityAttributes.ContentState,
        now: Date
    ) -> AgentRunActivityAttributes.ContentState {
        keepingWorkCounts(of: state, in: AgentRunActivityAttributes.ContentState(
            sessionID: state.sessionID,
            sessionTitle: state.sessionTitle,
            status: status,
            currentActivity: activity,
            responseExcerpt: state.responseExcerpt,
            startedAt: state.startedAt,
            updatedAt: now
        ))
    }
}
