import Foundation

/// TAL-2232: what is running and what needs the user, from `GET /api/activity/summary`. The server filters and orders
/// the rows (waiting for an approval, then for input, then running); clients show them as they come.
public struct ActivitySummary: Decodable, Equatable, Sendable {
    public let runningCount: Int
    public let waitingCount: Int
    public let rows: [Row]

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
