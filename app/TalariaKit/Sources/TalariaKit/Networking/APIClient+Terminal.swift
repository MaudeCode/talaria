import Foundation

/// TAL-1997: a session terminal a `terminal_open` card follows read-only.
extension APIClient {
    public func terminalRead(sessionID: String, terminalID: String, afterEventID: Int) async throws -> TerminalSlice {
        try await send(endpoint: .terminalRead(sessionID: sessionID, terminalID: terminalID, afterEventID: afterEventID), method: "GET")
    }

    /// The session terminal's output stream, which the view follows only as a signal to read again.
    public nonisolated func terminalOutputStreamURL(sessionID: String) -> URL {
        Endpoint.terminalOutput(sessionID: sessionID).url(relativeTo: baseURL)
    }
}
