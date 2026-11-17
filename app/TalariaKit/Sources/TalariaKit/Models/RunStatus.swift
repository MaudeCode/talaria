import Foundation

/// The server-selected run presentation. Unknown phases remain decodable for forward compatibility.
public struct RunStatus: Codable, Equatable, Sendable {
    public let phase: String
    public let progressPercent: Double?
    public let wait: Wait?
    /// TAL-2337: while the run works, the call it is in, as its transcript row names it; nil between calls and from an older server.
    public let currentTool: AgentRunActivityTool?

    public struct Wait: Codable, Equatable, Sendable {
        public let providerLabel: String?
        public let until: Double?
        public let untilKind: String?
    }

    enum CodingKeys: String, CodingKey { case phase, progressPercent, wait, currentTool }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        phase = try container.decode(String.self, forKey: .phase)
        progressPercent = try? container.decodeIfPresent(Double.self, forKey: .progressPercent)
        wait = try? container.decodeIfPresent(Wait.self, forKey: .wait)
        currentTool = try? container.decodeIfPresent(AgentRunActivityTool.self, forKey: .currentTool)
    }
}
