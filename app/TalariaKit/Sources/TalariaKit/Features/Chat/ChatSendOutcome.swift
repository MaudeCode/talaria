import Foundation

/// A send's result and the error it hit, handed to its caller. `lastError` is shared state that the next
/// send clears, such as the queued send a finished voice note releases, so callers must not read it back (TAL-150).
public struct ChatSendOutcome {
    public let didStart: Bool
    public let error: Error?

    init(didStart: Bool, error: Error? = nil) {
        self.didStart = didStart
        self.error = error
    }
}

/// A queued send that failed with no caller waiting on it; ChatView forwards the error to its auth handling.
public struct ChatSendFailure: Identifiable {
    public let id = UUID()
    public let error: Error
}
