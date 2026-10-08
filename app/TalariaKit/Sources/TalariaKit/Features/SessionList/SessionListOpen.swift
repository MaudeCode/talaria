import Foundation

/// Resolves a session the list is about to open: a row tap, a restored selection,
/// or a deep link that is loaded first.
public enum SessionListOpen {
    public enum Outcome: Equatable {
        case open(SessionSummary)
        /// Loading or importing failed; the caller surfaces the view model's error.
        case failed
        /// The user chose a newer destination while this one resolved.
        case superseded
    }

    /// External sessions are imported (or refreshed) server-side before navigation,
    /// so the opened session carries the server's authoritative writability.
    ///
    /// The open begins before the first await: any destination chosen or open
    /// started while the load or import was in flight — New Chat, a utility,
    /// another row — is newer than this one and must not be replaced (TAL-153).
    @MainActor
    public static func resolve(
        beginOpen: () -> Int,
        openRevision: () -> Int,
        load: () async -> SessionSummary?,
        importSession: (SessionSummary) async -> SessionSummary?
    ) async -> Outcome {
        let startRevision = beginOpen()
        guard let session = await load() else { return .failed }
        guard startRevision == openRevision() else { return .superseded }
        guard let resolved = await importSession(session) else { return .failed }
        guard startRevision == openRevision() else { return .superseded }
        return .open(resolved)
    }
}
