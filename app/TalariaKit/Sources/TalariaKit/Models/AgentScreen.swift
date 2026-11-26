import Foundation

/// The session profile's Bot Screen, as reported by Talaria Web.
public struct AgentScreen: Decodable, Equatable, Sendable {
    public enum State: String, Decodable, Sendable {
        case unsupported
        case notInstalled = "not_installed"
        case stopped
        case running
    }

    public enum Control: String, Decodable, Sendable {
        case agent, you, other
    }

    public let available: Bool
    public let state: State
    public let control: Control
    public let installCommand: String?
}
