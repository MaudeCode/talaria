import Foundation

/// TAL-1001: the chat's one short notice above the composer, at an Agent notice's level so both share one chip. It
/// goes on its own or on tap and is never saved.
public struct ChatNotice: Equatable, Identifiable {
    public let id: UUID
    public let text: String
    public let level: SessionNotice.Level
}

extension SessionNotice.Level {
    /// How long a chat notice at this level stays: Web's default toast lifetime, longer for a warning or error.
    var noticeLifetime: Duration {
        self == .warn || self == .error ? .seconds(5) : .milliseconds(2500)
    }
}
