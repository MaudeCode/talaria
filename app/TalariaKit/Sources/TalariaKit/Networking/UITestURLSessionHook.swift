#if DEBUG
import Foundation
import os

/// Lets the App's UI-test fixture route every session this package creates through its URL protocol.
/// `TalariaApp.init` installs the fixture before anything creates a session; unset, sessions are unchanged.
/// Setting it, or calling `resetSharedSessions()`, makes `APIClient`'s shared sessions rebuild under the current hook.
public enum UITestURLSessionHook {
    nonisolated(unsafe) public static var configure: (URLSessionConfiguration) -> Void = { _ in } {
        didSet { resetSharedSessions() }
    }

    /// For a hook whose configuration changes without being reassigned, such as the fixture's per-test generation.
    public static func resetSharedSessions() {
        generationLock.withLock { $0 &+= 1 }
    }

    private static let generationLock = OSAllocatedUnfairLock(initialState: 0)
    static var generation: Int { generationLock.withLock { $0 } }
}

/// A chat or session list, whose async work reads and writes the offline cache. The App's hosted-test fixture waits at
/// teardown until none has such work admitted, before its cache goes (TAL-1097).
@MainActor
public protocol UITestCacheOwner: AnyObject {
    var hasCacheWorkInFlight: Bool { get }
}

/// Tells the fixture about each cache owner as it is made. Unset, it does nothing.
@MainActor
public enum UITestCacheOwnerHook {
    public static var created: (any UITestCacheOwner) -> Void = { _ in }
}
#endif
