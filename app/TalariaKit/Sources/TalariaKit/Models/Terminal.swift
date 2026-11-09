import Foundation

/// TAL-1997: the terminal a `terminal_open` result started (`TerminalRefSchema`): a Web host PTY of the session that the
/// card's Open follows read-only. `command` is null when the agent typed none.
public struct TerminalRef: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public let terminalId: String
    public let title: String
    public let command: String?

    public var id: String { terminalId }

    public init(terminalId: String, title: String, command: String?) {
        self.terminalId = terminalId
        self.title = title
        self.command = command
    }
}

/// TAL-1997: one `GET /api/terminal/read` (`TerminalViewSliceSchema`). The server removed escape sequences and applied
/// carriage returns; `output` holds `lines` lines. When `replacesLastLine` is true its first line is, in full, the line
/// the previous read ended inside.
public struct TerminalSlice: Decodable, Equatable, Sendable {
    public let terminalId: String
    public let output: String
    public let lines: Int
    public let nextEventId: Int
    public let truncated: Bool
    public let running: Bool
    public let exitCode: Int?
    public let replacesLastLine: Bool
}
