import Foundation
import Observation

/// Bridges App Intents (which run outside the SwiftUI view tree) into the app's existing
/// deep-link router. An intent writes a `talaria://…` URL here; `ContentView` observes
/// `pendingDeepLink` and feeds it through the same `handleOpenURL` path as an external URL,
/// so intent navigation reuses the share/session deep-link plumbing rather than inventing a
/// parallel one (issue #337). A shared singleton is the standard bridge because the intent
/// has no reference to the live view hierarchy.
@MainActor
@Observable
public final class AppIntentRouter {
    public static let shared = AppIntentRouter()

    /// Set by an App Intent, drained by `ContentView`. Holding it (rather than acting
    /// immediately) lets the view consume it whether the intent fired before the view
    /// appeared (cold launch) or after (warm launch).
    public var pendingDeepLink: URL?

    private init() {}

    /// Records a deep link for the view layer to route. No-op on a nil URL so callers can
    /// pass the optional `TalariaDeepLink` builders without unwrapping.
    public func requestDeepLink(_ url: URL?) {
        guard let url else { return }
        pendingDeepLink = url
    }
}
