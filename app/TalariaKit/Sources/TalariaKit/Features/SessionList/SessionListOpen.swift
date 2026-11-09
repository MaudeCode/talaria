import Foundation

/// Resolves a session the list opens: a row tap, a restored selection, or a deep link
/// that is loaded first.
public enum SessionListOpen: Sendable {
    public enum Outcome: Equatable, Sendable {
        /// The session is open; nothing else to do.
        case opened
        /// The server verified the opened session under another canonical identity: open that one in its place.
        case replace(SessionSummary)
        /// Loading failed; the caller surfaces the view model's error.
        case failed
        /// The user chose a newer destination meanwhile.
        case superseded
    }

    /// Opens the session as soon as it is loaded, then verifies it (TAL-839): an external
    /// session's destination shows at once while the server confirms its identity and
    /// writability, and the destination itself shows a failed verification.
    ///
    /// The open begins before the first await: any destination chosen or open started
    /// while the load or the verification was in flight — New Chat, a utility, another
    /// row, Back — is newer than this one and must not be replaced (TAL-153).
    @MainActor
    public static func resolve(
        beginOpen: () -> Int,
        openRevision: () -> Int,
        load: () async -> SessionSummary?,
        open: (SessionSummary) -> Void,
        verify: (SessionSummary) async -> SessionSummary?
    ) async -> Outcome {
        let startRevision = beginOpen()
        guard let session = await load() else { return .failed }
        guard startRevision == openRevision() else { return .superseded }
        open(session)
        let openedRevision = openRevision()
        guard let verified = await verify(session) else { return .opened }
        guard openedRevision == openRevision() else { return .superseded }
        return verified.sessionId == session.sessionId ? .opened : .replace(verified)
    }
}
