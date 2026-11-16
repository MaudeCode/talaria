import Foundation

/// TAL-1488: Deny from a notification banner or a Live Activity waits `window` before it is sent, so a mistaken tap can be
/// undone. The display reads "Denied · Undo" meanwhile; Undo restores the waiting state and sends nothing. Each pending
/// denial is persisted until it is sent, so a process killed inside the window sends it on the next launch: the window is
/// a convenience, never a lost answer. Allow and the chat's own approval card stay instant.
@MainActor
public final class DeferredDenial {
    /// The denial of the approval a banner or activity showed, for one session.
    public struct Record: Codable, Hashable, Sendable {
        public let publisherID: String?
        public let sessionID: String
        /// The approval's queue head (a Relay push or Live Activity) or its id (a local alert).
        public let approvalHeadID: String?
        public let approvalID: String?
        /// A banner's denial reports a refusal with a notification; an activity shows it on its rows.
        public let fromBanner: Bool

        public init(publisherID: String?, sessionID: String, approvalHeadID: String?, approvalID: String?, fromBanner: Bool) {
            self.publisherID = publisherID
            self.sessionID = sessionID
            self.approvalHeadID = approvalHeadID
            self.approvalID = approvalID
            self.fromBanner = fromBanner
        }

        /// One pending denial per session: a second Deny replaces the first.
        public var key: String { Self.key(publisherID: publisherID, sessionID: sessionID) }

        /// A banner and an activity may spell the same server differently; both name its origin.
        public static func key(publisherID: String?, sessionID: String) -> String {
            "\(publisherID.map { TalariaRelayClient.originIdentifier($0) ?? $0 } ?? ""):\(sessionID)"
        }
    }

    public struct Effects {
        /// Shows "Denied · Undo" for the record.
        public var show: @MainActor (Record) async -> Void
        /// Undo: restores the waiting state the record replaced.
        public var restore: @MainActor (Record) async -> Void
        /// Sends the denial once its window ends.
        public var send: @MainActor (Record) async -> Void

        public init(
            show: @escaping @MainActor (Record) async -> Void,
            restore: @escaping @MainActor (Record) async -> Void,
            send: @escaping @MainActor (Record) async -> Void
        ) {
            self.show = show
            self.restore = restore
            self.send = send
        }
    }

    public static let window: Duration = .seconds(5)
    static let storageKey = "deferredDenial.pending"

    private let defaults: UserDefaults
    private let clock: any Clock<Duration>
    private let effects: Effects
    /// Each pending record with the Deny that scheduled it, so a replaced Deny's timer sends nothing.
    private var pending: [String: (record: Record, deny: UUID)] = [:]
    /// Records being sent; they stay persisted until their send returns.
    private var sending: [UUID: Record] = [:]

    public init(defaults: UserDefaults = .standard, clock: any Clock<Duration> = ContinuousClock(), effects: Effects) {
        self.defaults = defaults
        self.clock = clock
        self.effects = effects
    }

    /// Shows the denial, waits the window and sends it unless it was undone or replaced meanwhile. Returns when the
    /// window ends, so a caller holding a background task or an intent keeps the process alive until then.
    public func deny(_ record: Record) async {
        let deny = UUID()
        pending[record.key] = (record, deny)
        persist()
        await effects.show(record)
        // A cancelled wait leaves the record persisted, for the next launch to send.
        guard (try? await clock.sleep(for: Self.window)) != nil, pending[record.key]?.deny == deny else { return }
        pending[record.key] = nil
        await send([record])
    }

    /// Cancels the session's pending denial and restores its waiting state. False when none is pending.
    @discardableResult
    public func undo(publisherID: String?, sessionID: String) async -> Bool {
        guard let record = pending.removeValue(forKey: Record.key(publisherID: publisherID, sessionID: sessionID))?.record else {
            return false
        }
        persist()
        await effects.restore(record)
        return true
    }

    /// At launch: sends every denial a killed process left pending.
    public func sendPersisted() async {
        let stored = defaults.data(forKey: Self.storageKey).flatMap { try? JSONDecoder().decode([Record].self, from: $0) } ?? []
        let ours = Set(pending.values.map(\.record)).union(sending.values)
        await send(stored.filter { !ours.contains($0) })
    }

    private func send(_ records: [Record]) async {
        let ids = records.map { record in
            let id = UUID()
            sending[id] = record
            return id
        }
        persist()
        for (id, record) in zip(ids, records) {
            await effects.send(record)
            sending[id] = nil
            persist()
        }
    }

    private func persist() {
        let records = pending.values.map(\.record) + sending.values
        if records.isEmpty {
            defaults.removeObject(forKey: Self.storageKey)
        } else {
            defaults.set(try? JSONEncoder().encode(records), forKey: Self.storageKey)
        }
    }
}
