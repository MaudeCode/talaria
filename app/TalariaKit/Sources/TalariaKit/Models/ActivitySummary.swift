import Foundation

/// TAL-2232: what is running and what needs the user, from `GET /api/activity/summary`. The server filters and orders
/// the rows (waiting for an approval, then for input, then running); clients show them as they come. TAL-2233: the server
/// also groups them; a server without the groups decodes them empty.
public struct ActivitySummary: Decodable, Equatable, Sendable {
    public let runningCount: Int
    public let waitingCount: Int
    public let rows: [Row]
    /// Waiting for an approval or for input.
    public let waiting: [Row]
    /// Running or starting.
    public let running: [Row]
    /// Waiting for an approval that its `approvalId` can answer.
    public let approvals: [Row]

    enum CodingKeys: String, CodingKey {
        case runningCount, waitingCount, rows, waiting, running, approvals
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        runningCount = try container.decode(Int.self, forKey: .runningCount)
        waitingCount = try container.decode(Int.self, forKey: .waitingCount)
        rows = try container.decode([Row].self, forKey: .rows)
        waiting = try container.decodeIfPresent([Row].self, forKey: .waiting) ?? []
        running = try container.decodeIfPresent([Row].self, forKey: .running) ?? []
        approvals = try container.decodeIfPresent([Row].self, forKey: .approvals) ?? []
    }

    public struct Row: Decodable, Equatable, Sendable, Identifiable {
        public let sessionId: String
        public let title: String
        /// `waiting_for_approval`, `waiting_for_input`, `running` or `starting`, as on Live Activity rows.
        public let phase: String
        /// Epoch seconds.
        public let startedAt: TimeInterval
        public let updatedAt: TimeInterval
        public let deepLink: String
        /// The approval at the head of the queue while `phase` is `waiting_for_approval`, as the approval routes take it.
        public let approvalId: String?

        public var id: String { sessionId }
    }
}
