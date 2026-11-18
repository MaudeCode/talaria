import Foundation

public enum AgentLiveActivityEvent: Equatable, Sendable {
    case sessionTitle(String)
    case token(String)
    case interimAssistant(String)
    case clearResponseExcerpt
    case reasoning(String)
    /// TAL-2336: the call that started or finished, with its transcript row's server fields.
    case toolStarted(AgentRunActivityTool)
    case toolCompleted(AgentRunActivityTool)
    /// `headID` is the server's `head_id` for the pending approval and `text` what it runs (its command, else its
    /// description); a nil head keeps the approval already shown. TAL-2336: `tool` is the call it holds.
    case waitingForApproval(headID: String?, text: String?, tool: AgentRunActivityTool? = nil)
    case waitingForClarification
    /// The pending approval or clarification settled, here or in another client, and the run goes on.
    /// TAL-2341: also a call started that the activity does not name (`activity_unnamed`); either way it reads "Working".
    case promptSettled
    /// TAL-1422: the server's plan progress for the run of `sessionID` (`todo_state.plan_progress`).
    case planProgress(completed: Int, total: Int, sessionID: String)
    /// TAL-1422: the server's count of running workers for `sessionID` (`worker_count` of its background-work read).
    case workerCount(Int, sessionID: String)
}

/// A persisted Live Activity left over from a previous launch that this manager
/// isn't currently driving — a reconciliation candidate (#246). Carries the bits
/// the reconciler needs to decide whether a "response complete" notification is
/// still worth firing: the run's session and when it last advanced (#248).
public struct OrphanedLiveActivity: Equatable, Sendable {
    public let streamID: String
    public let sessionID: String
    public let updatedAt: Date
    /// The chat title the activity last showed, for naming the chat in a reply notification.
    public let sessionTitle: String

    public init(streamID: String, sessionID: String, updatedAt: Date, sessionTitle: String = "") {
        self.streamID = streamID
        self.sessionID = sessionID
        self.updatedAt = updatedAt
        self.sessionTitle = sessionTitle
    }
}

@MainActor
public protocol AgentLiveActivityManaging: AnyObject {
    var currentSessionID: String? { get }
    var currentStreamID: String? { get }
    func armAggregateForLocalWork(sessionID: String, sessionTitle: String, publisherURL: URL)
    /// `startedAt` is when the run began, not when the widget was created: the
    /// coordinator passes the server-seeded run start so the widget's elapsed
    /// timer counts the whole turn rather than from this process attaching.
    func start(sessionID: String, sessionTitle: String, streamID: String?, publisherURL: URL, startedAt: Date)
    func update(_ event: AgentLiveActivityEvent)
    func markStale()
    func end(status: AgentRunActivityStatus, activity: String, errorSummary: String?)
    /// Persisted Live Activities left over from a previous launch that this manager
    /// isn't currently driving — reconciliation candidates (#246).
    func orphanedActivities() -> [OrphanedLiveActivity]
    /// End a persisted activity this manager isn't tracking in memory (e.g. the
    /// app was terminated mid-run and relaunched), matched by streamID (#246).
    /// Returns `true` only if it actually transitioned a still-running activity to
    /// final — the reconciler uses that to avoid firing a duplicate notification
    /// for a completion another path already finalized (#248).
    @discardableResult
    func endOrphanedActivity(streamID: String, status: AgentRunActivityStatus, activity: String) async -> Bool
}

extension AgentLiveActivityManaging {
    var currentSessionID: String? { nil }
    var currentStreamID: String? { nil }
    func armAggregateForLocalWork(sessionID: String, sessionTitle: String, publisherURL: URL) {}
    // Defaults so test spies and non-ActivityKit conformers don't have to care
    // about reconciliation; the real manager overrides both.
    func orphanedActivities() -> [OrphanedLiveActivity] { [] }
    @discardableResult
    func endOrphanedActivity(streamID: String, status: AgentRunActivityStatus, activity: String) async -> Bool { false }
}
