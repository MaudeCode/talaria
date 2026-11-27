import Foundation

public struct AgentRestoreStatus: Decodable, Sendable {
    public let available: Bool
    public let canUpload: Bool
    public let server: String
    public let profile: String
    public let job: AgentRestoreJob?
}

public struct AgentRestoreJob: Decodable, Sendable {
    public enum State: String {
        case staged, running, restored, refused, busy, partial, unknown, unavailable
        case invalidArchive = "invalid_archive"
        case backupFailed = "backup_failed"
    }

    public let id: String
    public let fileName: String
    public let canConfirm: Bool
    public let recoveryUrl: String?
    private let state: String

    public var knownState: State? { State(rawValue: state) }
}
