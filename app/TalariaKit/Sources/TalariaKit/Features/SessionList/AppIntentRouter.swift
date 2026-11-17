import Foundation
import Observation

/// Bridges App Intents (which run outside the SwiftUI view tree) into the app's existing
/// deep-link router. An intent writes a `talaria://…` URL here; `ContentView` observes
/// `pendingDeepLink` and feeds it through the same `handleOpenURL` path as an external URL,
/// so intent navigation reuses the share/session deep-link plumbing rather than inventing a
/// parallel one (issue #337). A shared singleton is the standard bridge because the intent
/// has no reference to the live view hierarchy.
///
/// TAL-2388: every event enters here, external URLs and notification taps included, and names the one window that
/// handles it, so two windows never both act on it.
@MainActor
@Observable
public final class AppIntentRouter {
    public static let shared = AppIntentRouter()

    /// Set by an App Intent, drained by `ContentView`. Holding it (rather than acting
    /// immediately) lets the view consume it whether the intent fired before the view
    /// appeared (cold launch) or after (warm launch).
    public var pendingDeepLink: URL?
    /// The window `pendingDeepLink` belongs to; nil while no window is known yet, when the first to drain takes it.
    /// Observed, so a link handed over from a closed window wakes the window it moves to.
    public private(set) var pendingWindow: String?
    /// Window scenes by their session's persistent identifier, most recently active first.
    @ObservationIgnored private(set) var windows: [String] = []
    /// Asks the system to bring a window forward; the app sets it.
    @ObservationIgnored public var bringForward: (String) -> Void = { _ in }

    init() {}

    /// Records a deep link for the view layer to route. No-op on a nil URL so callers can
    /// pass the optional `TalariaDeepLink` builders without unwrapping.
    public func requestDeepLink(_ url: URL?) {
        guard let url else { return }
        let showing = TalariaDeepLink.sessionID(from: url).map {
            SessionNotificationRefresh.windows(showing: $0, publisherID: TalariaDeepLink.publisherID(from: url))
        } ?? []
        pendingWindow = Self.window(showing: showing, recency: windows)
        pendingDeepLink = url
        if windows.count > 1, let pendingWindow, pendingWindow != windows.first { bringForward(pendingWindow) }
    }

    /// The pending deep link, once, to the window it belongs to.
    public func takeDeepLink(in window: String?) -> URL? {
        guard let url = pendingDeepLink, pendingWindow == nil || pendingWindow == window else { return nil }
        pendingDeepLink = nil
        pendingWindow = nil
        return url
    }

    /// The routing rule: a window showing the event's session takes it, the most recent of them if several; anything
    /// else goes to the most recently active window.
    nonisolated static func window(showing: Set<String>, recency: [String]) -> String? {
        recency.first(where: showing.contains) ?? showing.min() ?? recency.first
    }

    public func windowDidBecomeActive(_ window: String) {
        windows.removeAll { $0 == window }
        windows.insert(window, at: 0)
    }

    /// A closed window hands its pending deep link to the window now most recently active.
    public func windowDidClose(_ window: String) {
        windows.removeAll { $0 == window }
        if pendingWindow == window { pendingWindow = windows.first }
    }

    /// TAL-2388: one chat in one window. Brings forward another window that shows this chat, if one does.
    public func bringsForwardOtherWindow(showing sessionID: String, on server: URL, from window: String?) -> Bool {
        let others = SessionNotificationRefresh.windows(showing: sessionID, publisherID: server.absoluteString)
            .subtracting([window].compactMap { $0 })
        guard !others.isEmpty, let target = Self.window(showing: others, recency: windows) else { return false }
        bringForward(target)
        return true
    }
}
