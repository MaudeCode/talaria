import Foundation

public enum AgentLiveActivityEvent: Equatable {
    case sessionTitle(String)
    case token(String)
    case interimAssistant(String)
    case clearResponseExcerpt
    case reasoning(String)
    case toolStarted(kind: ToolDisplayKind?, name: String?)
    case toolCompleted
    case waitingForApproval
    case waitingForClarification
}

/// A persisted Live Activity left over from a previous launch that this manager
/// isn't currently driving — a reconciliation candidate (#246). Carries the bits
/// the reconciler needs to decide whether a "response complete" notification is
/// still worth firing: the run's session and when it last advanced (#248).
public struct OrphanedLiveActivity: Equatable {
    public let streamID: String
    public let sessionID: String
    public let updatedAt: Date

    public init(streamID: String, sessionID: String, updatedAt: Date) {
        self.streamID = streamID
        self.sessionID = sessionID
        self.updatedAt = updatedAt
    }
}

@MainActor
public protocol AgentLiveActivityManaging: AnyObject {
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
    func armAggregateForLocalWork(sessionID: String, sessionTitle: String, publisherURL: URL) {}
    // Defaults so test spies and non-ActivityKit conformers don't have to care
    // about reconciliation; the real manager overrides both.
    func orphanedActivities() -> [OrphanedLiveActivity] { [] }
    @discardableResult
    func endOrphanedActivity(streamID: String, status: AgentRunActivityStatus, activity: String) async -> Bool { false }
}
