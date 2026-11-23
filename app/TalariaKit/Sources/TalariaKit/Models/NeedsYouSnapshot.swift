import Foundation
import WidgetKit

/// TAL-1479: the chats waiting on the user, as the server's activity summary last listed them, for the Needs you
/// widget. The rows are the server's `waiting` group in its order, titles and phases verbatim; the count is its
/// `waiting_count`.
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

        public var id: String { "\(serverID ?? ""):\(sessionID)" }

        public var deepLink: URL? { TalariaDeepLink.sessionURL(sessionID: sessionID, publisherID: serverID) }
    }

    /// Past this age with no refresh the widget mutes its rows, as a stale Live Activity does.
    public static let staleAfter: TimeInterval = 30 * 60

    public let updatedAt: Date
    public let rows: [Row]
    /// The server's count of waiting chats; it can exceed `rows`.
    public let waitingCount: Int

    public init(updatedAt: Date, rows: [Row], waitingCount: Int) {
        self.updatedAt = updatedAt
        self.rows = rows
        self.waitingCount = waitingCount
    }

    public init(summary: ActivitySummary, serverURL: URL, updatedAt: Date) {
        let serverID = TalariaRelayClient.originURL(serverURL)?.absoluteString
        self.init(
            updatedAt: updatedAt,
            rows: summary.waiting.map { Row(sessionID: $0.sessionId, title: $0.title, phase: $0.phase, serverID: serverID) },
            waitingCount: summary.waitingCount
        )
    }

    public func isStale(at date: Date) -> Bool {
        date.timeIntervalSince(updatedAt) > Self.staleAfter
    }

    /// Where a tap outside a row goes: the first waiting chat, else the app.
    public var widgetURL: URL? { rows.first?.deepLink ?? TalariaDeepLink.openAppURL }
}

/// The App refreshes the waiting chats here from the session list refresh and the Relay aggregate refresh; the widget
/// reads them.
public struct NeedsYouSnapshotStore {
    public static let widgetKind = "NeedsYouWidget"
    static let storageKey = "needsYouSnapshot.v1"

    /// Counts `clear()` calls, so a summary read that was in flight across a sign-out or server change is dropped.
    private static let lock = NSLock()
    nonisolated(unsafe) private static var clearCount = 0

    /// The clear count now. A caller that learns of waiting chats from an earlier request passes the count it read
    /// before that request, so a sign-out or server switch in between voids its refresh too.
    public static var generation: Int { lock.withLock { clearCount } }

    private let defaults: UserDefaults?

    public init(defaults: UserDefaults? = UserDefaults(suiteName: ProviderQuotaWidgetSnapshotStore.appGroupIdentifier)) {
        self.defaults = defaults
    }

    /// Reads the server's activity summary and saves its waiting group. A failed read, or one a clear overtook since
    /// `generation`, leaves the last snapshot to go stale.
    @MainActor @discardableResult
    public func refresh(
        client: APIClient, serverURL: URL, since generation: Int = Self.generation,
        at date: @autoclosure () -> Date = Date()
    ) async -> Bool {
        #if DEBUG
        defer { Self.finishedRefreshesForTesting += 1 }
        #endif
        guard Self.generation == generation,
              let summary = try? await client.activitySummary(),
              Self.generation == generation,
              let defaults,
              let data = try? JSONEncoder().encode(NeedsYouSnapshot(summary: summary, serverURL: serverURL, updatedAt: date()))
        else { return false }
        defaults.set(data, forKey: Self.storageKey)
        WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
        return true
    }

    public func load() -> NeedsYouSnapshot? {
        defaults?.data(forKey: Self.storageKey).flatMap { try? JSONDecoder().decode(NeedsYouSnapshot.self, from: $0) }
    }

    /// Sign-out and server changes take the chat titles off the Lock Screen and void reads still in flight.
    public func clear() {
        Self.lock.withLock { Self.clearCount += 1 }
        guard let defaults, defaults.object(forKey: Self.storageKey) != nil else { return }
        defaults.removeObject(forKey: Self.storageKey)
        WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind)
    }
}

#if DEBUG
extension NeedsYouSnapshotStore {
    /// Counts finished refreshes, so a test can wait for the list's fire-and-forget refresh instead of a fixed delay.
    @MainActor static var finishedRefreshesForTesting = 0
}
#endif
