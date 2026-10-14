import Foundation

/// A notice's kind, as Web's toasts have: it picks the chip's icon and how long the notice stays.
public enum ChatNoticeKind: Equatable, Sendable {
    case info
    case warning
    case error

    /// Web's default toast lifetime for info; a warning or error stays longer to be read.
    var lifetime: Duration {
        self == .info ? .milliseconds(2500) : .seconds(5)
    }
}

/// TAL-1001: the chat's one short notice above the composer. It goes on its own or on tap and is never saved.
public struct ChatNotice: Equatable, Identifiable, Sendable {
    public let id: UUID
    public let text: String
    public let kind: ChatNoticeKind
}
