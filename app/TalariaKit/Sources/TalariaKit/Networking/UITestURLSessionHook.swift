#if DEBUG
import Foundation

/// Lets the App's UI-test fixture route every session this package creates through its URL protocol.
/// `TalariaApp.init` installs the fixture before anything creates a session; unset, sessions are unchanged.
public enum UITestURLSessionHook {
    nonisolated(unsafe) public static var configure: (URLSessionConfiguration) -> Void = { _ in }
}
#endif
