import Foundation

/// Behavior TalariaKit needs from the App's platform frameworks (App Intents, UIKit, ActivityKit, user notifications).
/// TalariaKit builds and tests on macOS, so it never calls those itself: the App installs each hook in
/// `PlatformBridges.install()` at launch, before anything uses one. An unset hook does nothing.
@MainActor
public enum PlatformHooks {
    /// Re-indexes the parameterized "New Chat in <Profile>" App Shortcut after a profile load; the argument says whether
    /// the cached profile list changed.
    public static var refreshProfileShortcuts: (_ changed: Bool) -> Void = { _ in }

    /// Whether the App is the active, foreground application (`UIApplication.applicationState == .active`).
    public static var isApplicationActive: () -> Bool = { true }

    /// The App's shared ActivityKit Live Activity manager, used when a chat does not inject one.
    public static var liveActivityManager: () -> any AgentLiveActivityManaging = { DisabledLiveActivityManager.shared }

    /// Runs a native OIDC sign-in in the system web authentication sheet and returns its callback URL.
    public static var authenticateInBrowser: (_ url: URL, _ callbackScheme: String) async throws -> URL = { _, _ in
        throw OIDCSignInError.presentationFailed
    }
}
