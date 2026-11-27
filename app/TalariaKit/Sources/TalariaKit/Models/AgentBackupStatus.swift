import Foundation

public struct AgentBackupStatus: Decodable, Sendable {
    public let available: Bool
    public let server: String
    public let profile: String
    public let job: AgentBackupJob?
}

public struct AgentBackupJob: Decodable, Sendable {
    public enum State: String {
        case running, ready, failed, cancelled
    }

    public let id: String
    public let phase: String?
    public let completed: Int?
    public let total: Int?
    public let complete: Bool?
    public let fileName: String?
    public let sizeBytes: Int64?
    public let downloadUrl: String?
    public let expiresAt: Double?
    private let state: String

    /// An older App leaves unknown job states alone until it can read a supported state.
    public var knownState: State? { State(rawValue: state) }
}
