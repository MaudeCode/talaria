import Foundation
import Observation

/// Delivers App Intents, external URLs and notification taps to one window. The pending route survives cold launch;
/// a Shortcut's draft stays in this process and only URL routes go through deep-link parsing.
@MainActor
@Observable
public final class AppIntentRouter {
    public enum Route: Equatable, Sendable {
        case deepLink(URL)
        case newChat(NewChatRequest)
    }

    public static let shared = AppIntentRouter()
    public private(set) var pendingRoute: Route?
    /// Nil while no window is known yet, when the first to drain takes it.
    /// Observed, so a route handed over from a closed window wakes the window it moves to.
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
        request(.deepLink(url), showing: showing)
    }

    public func requestNewChat(_ newChat: NewChatRequest) {
        request(.newChat(newChat), showing: [])
    }

    private func request(_ route: Route, showing: Set<String>) {
        pendingWindow = Self.window(showing: showing, recency: windows)
        pendingRoute = route
        if windows.count > 1, let pendingWindow, pendingWindow != windows.first { bringForward(pendingWindow) }
    }

    /// The pending route, once, to the window it belongs to.
    public func takeRoute(in window: String?) -> Route? {
        guard let route = pendingRoute, pendingWindow == nil || pendingWindow == window else { return nil }
        pendingRoute = nil
        pendingWindow = nil
        return route
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

    /// A closed window hands its pending route to the window now most recently active.
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
