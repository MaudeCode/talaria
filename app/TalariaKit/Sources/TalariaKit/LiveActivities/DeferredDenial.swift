import Foundation

/// TAL-1488: Deny from a notification banner or a Live Activity waits `window` before it is sent, so a mistaken tap can be
/// undone. The display reads "Denied · Undo" meanwhile; Undo restores the waiting state and sends nothing. Each pending
/// denial is persisted with its deadline until it is sent, so after a process killed inside the window the next launch
/// keeps Undo for the rest of it and then sends: the window is a convenience, never a lost answer. Allow and the chat's own approval card stay instant.
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

    /// A pending denial and when its window ends. Persisted, so a relaunch keeps Undo for the rest of the window.
    private struct Entry: Codable {
        let record: Record
        let deadline: Date
    }

    private let defaults: UserDefaults
    private let clock: any Clock<Duration>
    private let now: () -> Date
    private let effects: Effects
    /// Each pending entry with the Deny that scheduled it, so a replaced or undone Deny's timer sends nothing.
    private var pending: [String: (entry: Entry, deny: UUID)] = [:]
    /// Records being sent; they stay persisted until their send returns.
    private var sending: [UUID: Record] = [:]
    /// Entries a killed process left, loaded before any write; their timers start in `resumePersisted`.
    private var restored: [String: UUID]?

    public init(
        defaults: UserDefaults = .standard, clock: any Clock<Duration> = ContinuousClock(), now: @escaping () -> Date = Date.init,
        effects: Effects
    ) {
        self.defaults = defaults
        self.clock = clock
        self.now = now
        self.effects = effects
    }

    /// Shows the denial, waits the window and sends it unless it was undone or replaced meanwhile. Returns when the
    /// window ends, so a caller holding a background task or an intent keeps the process alive until then.
    public func deny(_ record: Record) async {
        loadPersisted()
        let deny = UUID()
        pending[record.key] = (Entry(record: record, deadline: now() + Self.window.timeInterval), deny)
        persist()
        await effects.show(record)
        await expire(record.key, deny)
    }

    /// Cancels the session's pending denial and restores its waiting state. False when none is pending.
    @discardableResult
    public func undo(publisherID: String?, sessionID: String) async -> Bool {
        loadPersisted()
        guard let record = pending.removeValue(forKey: Record.key(publisherID: publisherID, sessionID: sessionID))?.entry.record else {
            return false
        }
        persist()
        await effects.restore(record)
        return true
    }

    /// At launch: resumes each denial a killed process left pending. Undo stays available for the rest of its window,
    /// and one whose window has ended is sent now.
    public func resumePersisted() async {
        loadPersisted()
        let resumed = restored ?? [:]
        restored = [:]
        await withTaskGroup(of: Void.self) { group in
            for (key, deny) in resumed {
                group.addTask { await self.expire(key, deny) }
            }
        }
    }

    /// Sends the entry when its window ends, unless Undo or a later Deny replaced it meanwhile.
    private func expire(_ key: String, _ deny: UUID) async {
        guard let deadline = pending[key].flatMap({ $0.deny == deny ? $0.entry.deadline : nil }) else { return }
        // A cancelled wait leaves the record persisted, for the next launch to send.
        guard (try? await clock.sleep(for: .seconds(max(0, deadline.timeIntervalSince(now()))))) != nil,
              let entry = pending[key], entry.deny == deny else { return }
        pending[key] = nil
        let id = UUID()
        sending[id] = entry.entry.record
        persist()
        await effects.send(entry.entry.record)
        sending[id] = nil
        persist()
    }

    private func loadPersisted() {
        guard restored == nil else { return }
        var loaded: [String: UUID] = [:]
        let stored = defaults.data(forKey: Self.storageKey).flatMap { try? JSONDecoder().decode([Entry].self, from: $0) } ?? []
        for entry in stored where pending[entry.record.key] == nil {
            let deny = UUID()
            pending[entry.record.key] = (entry, deny)
            loaded[entry.record.key] = deny
        }
        restored = loaded
    }

    private func persist() {
        // A record being sent has no window left; a relaunch sends it again, and the server settles a repeat.
        let entries = pending.values.map(\.entry) + sending.values.map { Entry(record: $0, deadline: .distantPast) }
        if entries.isEmpty {
            defaults.removeObject(forKey: Self.storageKey)
        } else {
            defaults.set(try? JSONEncoder().encode(entries), forKey: Self.storageKey)
        }
    }
}

private extension Duration {
    var timeInterval: TimeInterval { Double(components.seconds) + Double(components.attoseconds) / 1e18 }
}
