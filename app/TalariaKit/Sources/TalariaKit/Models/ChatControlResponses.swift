import Foundation

public struct ChatStartResponse: Decodable, Equatable {
    public let streamId: String?
    let sessionId: String?
    /// Unix epoch seconds for when the server started this turn, the same
    /// `pending_started_at` the session detail reports while the turn is in
    /// flight. Decoded lossily: absent or malformed values leave it nil.
    let pendingStartedAt: Double?
    public let error: String?

    private enum CodingKeys: String, CodingKey {
        case streamId, sessionId, pendingStartedAt, error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        streamId = try container.decodeIfPresent(String.self, forKey: .streamId)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        pendingStartedAt = container.decodeLossyDoubleIfPresent(forKey: .pendingStartedAt)
        error = try container.decodeIfPresent(String.self, forKey: .error)
    }

    /// When the turn this response opened really started: the server's
    /// `pending_started_at` when it reported a usable one, else the local
    /// moment the client sent the request.
    public func runStartedAt(sentAt: Date) -> Date {
        ChatStreamCoordinator.runStart(fromEpochSeconds: pendingStartedAt) ?? sentAt
    }
}

public struct ChatCancelResponse: Decodable, Equatable {
    public let ok: Bool?
    let cancelled: Bool?
    let streamId: String?
    /// TAL-426: the steers this Stop withdrew; nil from a Web older than the field.
    let withdrawnSteers: [SteerWithdrawnEvent]?
    public let error: String?
}

public struct ChatStreamStatusResponse: Decodable, Equatable {
    public let active: Bool?
    let streamId: String?
    let replayAvailable: Bool?
    let journal: RunJournalStatus?
}

/// The server's run-journal summary, surfaced on `/api/chat/stream/status` so a
/// reconciled Live Activity can be finalized with the run's real outcome (#267).
/// Every field is optional: the `journal` block is absent when the server has no
/// summary for a stream, and `terminalState`'s vocabulary may grow upstream — so
/// we decode tolerantly and never crash on an unknown value.
struct RunJournalStatus: Decodable, Equatable {
    /// Whether the server logged a genuine terminal event for the run. Decoded to
    /// mirror the journal payload shape (#267 acceptance criterion named both
    /// fields); outcome mapping reads `terminalState` only. Kept because it is not
    /// redundant with `terminalState`: a run the server force-marks
    /// `"lost-worker-bookkeeping"` reports `terminal == false`, so this stays
    /// available for any future consumer that must tell a real terminal event from
    /// a bookkeeping one.
    let terminal: Bool?
    let terminalState: String?
}

public struct ChatSteerResponse: Decodable, Equatable {
    public let accepted: Bool?
    let fallback: String?
    let streamId: String?
    let steerId: String?
    let error: String?
    /// TAL-460: sent during a background turn, the message started the user's own turn instead; follow it like a send.
    let startedTurn: ChatStartResponse?
}

public struct BtwStartResponse: Decodable, Equatable {
    public let streamId: String?
    let sessionId: String?
    let parentSessionId: String?
    public let error: String?
}

public struct BackgroundStartResponse: Decodable, Equatable {
    public let taskId: String?
    let streamId: String?
    let sessionId: String?
    public let error: String?
}
