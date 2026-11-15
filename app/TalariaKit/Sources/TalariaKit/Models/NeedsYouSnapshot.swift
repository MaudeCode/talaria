import Foundation
import WidgetKit

/// TAL-1479: the chats waiting on the user, as the App last heard them from the server, for the Needs you widget.
/// Rows keep the server's order and its titles and phases verbatim.
public struct NeedsYouSnapshot: Codable, Equatable, Sendable {
    public struct Row: Codable, Equatable, Sendable, Identifiable {
        public let sessionID: String
        public let title: String
        /// `waiting_for_approval` or `waiting_for_input`, as on Live Activity rows.
        public let phase: String
        /// The origin of the server the chat lives on, as Relay names its publisher; the deep link switches to it.
        public let serverID: String?

        public init(sessionID: String, title: String, phase: String, serverID: String?) {
            self.sessionID = sessionID
            self.title = title
            self.phase = phase
            self.serverID = serverID
        }

        /// A row from the Relay aggregate the Live Activity shows.
        public init(_ row: TalariaAggregateActivityAttributes.ContentState.Row) {
            self.init(sessionID: row.sessionId, title: row.title, phase: row.phase, serverID: row.publisherId)
        }

        /// A row from the server's activity summary (`GET /api/activity/summary`).
        public init(_ row: ActivitySummary.Row, serverURL: URL) {
            self.init(
                sessionID: row.sessionId, title: row.title, phase: row.phase,
                serverID: TalariaRelayClient.originURL(serverURL)?.absoluteString
            )
        }

        public var id: String { "\(serverID ?? ""):\(sessionID)" }

        public var deepLink: URL? { TalariaDeepLink.sessionURL(sessionID: sessionID, publisherID: serverID) }
    }

    /// Past this age with no refresh the widget mutes its rows, as a stale Live Activity does.
    public static let staleAfter: TimeInterval = 30 * 60

    public let updatedAt: Date
    public let rows: [Row]

    public init(updatedAt: Date, rows: [Row]) {
        self.updatedAt = updatedAt
        self.rows = rows
    }

    public func isStale(at date: Date) -> Bool {
        date.timeIntervalSince(updatedAt) > Self.staleAfter
    }

    /// Where a tap outside a row goes: the first waiting chat, else the app.
    public var widgetURL: URL? { rows.first?.deepLink ?? TalariaDeepLink.openAppURL }
}

/// The App writes the waiting chats here from the Relay aggregate refresh and the session list refresh; the widget
/// reads them. Whichever write is newest wins.
public struct NeedsYouSnapshotStore {
    public static let widgetKind = "NeedsYouWidget"
    static let storageKey = "needsYouSnapshot.v1"

    private let defaults: UserDefaults?

    public init(defaults: UserDefaults? = UserDefaults(suiteName: ProviderQuotaWidgetSnapshotStore.appGroupIdentifier)) {
        self.defaults = defaults
    }

    /// The Relay aggregate; nil (no aggregate) means nothing waits.
    @discardableResult
    public func save(relay aggregate: TalariaAggregateActivityAttributes.ContentState?, at date: Date = Date()) -> Bool {
        save((aggregate?.rows ?? []).map(NeedsYouSnapshot.Row.init), at: date)
    }

    /// The active server's activity summary.
    @discardableResult
    public func save(summary: ActivitySummary, serverURL: URL, at date: Date = Date()) -> Bool {
        save(summary.rows.map { NeedsYouSnapshot.Row($0, serverURL: serverURL) }, at: date)
    }

    /// Both sources list running rows too; the snapshot keeps the waiting ones in the server's order.
    private func save(_ rows: [NeedsYouSnapshot.Row], at date: Date) -> Bool {
        let waiting = rows.filter { TalariaAggregateLiveActivityPresentation.isWaiting($0.phase) }
        guard let defaults,
              let data = try? JSONEncoder().encode(NeedsYouSnapshot(updatedAt: date, rows: waiting))
        else { return false }
        defaults.set(data, forKey: Self.storageKey)
        WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
        return true
    }

    public func load() -> NeedsYouSnapshot? {
        defaults?.data(forKey: Self.storageKey).flatMap { try? JSONDecoder().decode(NeedsYouSnapshot.self, from: $0) }
    }

    /// Sign-out and server removal take the chat titles off the Lock Screen.
    public func clear() {
        guard let defaults, defaults.object(forKey: Self.storageKey) != nil else { return }
        defaults.removeObject(forKey: Self.storageKey)
        WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
    }
}
