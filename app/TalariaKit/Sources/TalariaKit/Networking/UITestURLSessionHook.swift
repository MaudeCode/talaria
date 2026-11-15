#if DEBUG
import Foundation
import os

/// Lets the App's UI-test fixture route every session this package creates through its URL protocol.
/// `TalariaApp.init` installs the fixture before anything creates a session; unset, sessions are unchanged.
/// Setting it bumps `generation`, so `APIClient`'s shared sessions are rebuilt under the new hook.
public enum UITestURLSessionHook {
    nonisolated(unsafe) public static var configure: (URLSessionConfiguration) -> Void = { _ in } {
        didSet { generationLock.withLock { $0 &+= 1 } }
    }

    private static let generationLock = OSAllocatedUnfairLock(initialState: 0)
    static var generation: Int { generationLock.withLock { $0 } }
}
#endif
