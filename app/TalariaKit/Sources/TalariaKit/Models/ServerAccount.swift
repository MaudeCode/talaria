import Foundation
import os

/// Non-secret-shaped metadata for one configured Talaria Web server.
///
/// A self-hosted server's URL tells whoever reads it where the user's agent is
/// reachable, so it is stored like a credential: the whole registry lives in the
/// Keychain (see `ServerRegistry`), alongside the `server_url` and
/// `custom_headers` entries. Auth cookies live in per-server `HTTPCookieStorage`
/// jars with Keychain-backed snapshots.
///
/// Decoding is tolerant: missing fields fall back to sensible defaults so a blob
/// written by an older build still loads.
public struct ServerAccount: Codable, Identifiable, Equatable, Sendable {
    /// Stable per-server identity. We reuse the normalized base-URL string so it
    /// matches the offline cache's `serverURLString` key (`CachedSession` /
    /// `CachedMessage`) — no separate id↔URL mapping to keep in sync.
    public let id: String
    /// Normalized base URL (scheme + host [+ port]); equal to `id` in this slice.
    public var urlString: String
    /// User-facing label. Seeded from the global identity on migration; editable
    /// per server in #17.
    public var displayName: String
    /// Avatar initials. Seeded/derived on migration; editable per server in #17.
    public var initials: String
    /// Per-server Header Logo Color (hex). Seeded from the global color on
    /// migration; editable per server in #17.
    public var headerLogoColorHex: String
    /// Reference under which this server's custom request headers are scoped.
    /// Seeded to the server `id`; as of #16 headers are persisted per server under
    /// a Keychain key scoped by that id (`AuthManager` scopes by the equivalent
    /// normalized URL string), so server A's proxy token is never sent to server B.
    public var customHeadersRef: String?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: String,
        urlString: String,
        displayName: String,
        initials: String,
        headerLogoColorHex: String,
        customHeadersRef: String?,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.urlString = urlString
        self.displayName = displayName
        self.initials = initials
        self.headerLogoColorHex = headerLogoColorHex
        self.customHeadersRef = customHeadersRef
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id
        case urlString
        case displayName
        case initials
        case headerLogoColorHex
        case customHeadersRef
        case createdAt
        case updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // An entry needs at least an identifier; tolerate either key being the
        // one present so older/newer blobs across the epic still decode.
        let decodedID = try container.decodeIfPresent(String.self, forKey: .id)
        let decodedURL = try container.decodeIfPresent(String.self, forKey: .urlString)
        guard let resolved = decodedID ?? decodedURL else {
            throw DecodingError.dataCorruptedError(
                forKey: .id,
                in: container,
                debugDescription: "ServerAccount requires an id or urlString"
            )
        }
        id = decodedID ?? resolved
        urlString = decodedURL ?? resolved
        displayName = try container.decodeIfPresent(String.self, forKey: .displayName) ?? ""
        initials = try container.decodeIfPresent(String.self, forKey: .initials) ?? ""
        headerLogoColorHex = try container.decodeIfPresent(String.self, forKey: .headerLogoColorHex)
            ?? HeaderLogoColor.defaultHex
        customHeadersRef = try container.decodeIfPresent(String.self, forKey: .customHeadersRef)
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date(timeIntervalSince1970: 0)
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
    }
}

/// Process-wide, thread-safe registry of configured servers plus which one is
/// active, persisted as a JSON blob in the Keychain because server URLs are
/// treated as credentials (see `ServerAccount`).
///
/// Mirrors `CustomHeaderStore`: the blob is loaded from the Keychain **once** at
/// init into a lock-guarded in-memory snapshot, reads come from that snapshot
/// (no synchronous `securityd` IPC on every property access), and mutations
/// persist a candidate snapshot before committing it in memory under the same lock.
/// `AuthManager` owns all writes: it calls `activate(url:)` when it configures or
/// restores a server, and `forgetActiveServer()` on full sign-out. Per-server
/// identity is seeded from the global identity defaults on first insert only, so
/// later per-server edits (#17) survive relaunch.
public final class ServerRegistry: @unchecked Sendable {
    public static let shared = ServerRegistry()

    private let keychain: any KeychainStoring
    /// Source of the global identity values used to seed a new server entry
    /// (`sessionIdentity.*` / `headerLogoColorHex` — non-secret `@AppStorage`
    /// settings that stay in UserDefaults).
    private let identityDefaults: UserDefaults
    private let now: () -> Date
    private let storage: OSAllocatedUnfairLock<Snapshot>

    public init(
        keychain: any KeychainStoring = KeychainStore(),
        identityDefaults: UserDefaults = .standard,
        now: @escaping () -> Date = { Date() }
    ) {
        self.keychain = keychain
        self.identityDefaults = identityDefaults
        self.now = now
        self.storage = OSAllocatedUnfairLock(initialState: Self.loadSnapshot(from: keychain))
    }

    /// Single persisted blob so the list and the active selection stay atomic.
    private struct Snapshot: Codable {
        var servers: [ServerAccount]
        var activeServerID: String?

        init(servers: [ServerAccount] = [], activeServerID: String? = nil) {
            self.servers = servers
            self.activeServerID = activeServerID
        }

        var activeServer: ServerAccount? {
            guard let activeServerID else { return nil }
            return servers.first { $0.id == activeServerID }
        }

        enum CodingKeys: String, CodingKey {
            case servers
            case activeServerID
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            servers = (try? container.decodeIfPresent([ServerAccount].self, forKey: .servers)) ?? []
            activeServerID = try? container.decodeIfPresent(String.self, forKey: .activeServerID)
        }
    }

    // MARK: - Reads (in-memory snapshot, no Keychain IPC)

    public var servers: [ServerAccount] { storage.withLock { $0.servers } }

    var activeServerID: String? { storage.withLock { $0.activeServerID } }

    public var activeServer: ServerAccount? {
        storage.withLock { snapshot in
            guard let id = snapshot.activeServerID else { return nil }
            return snapshot.servers.first { $0.id == id }
        }
    }

    // MARK: - Mutations (update snapshot + write through to the Keychain)

    /// Ensures `url` is registered and marked active, returning the active entry.
    ///
    /// Dedupes by id (the normalized URL string): a URL already present is just
    /// re-activated, never duplicated, and its identity is left untouched so any
    /// per-server edits from #17 survive. A new URL is inserted with its identity
    /// seeded from the current global identity defaults. Callers pass an
    /// already-normalized URL (`AuthManager.normalizedServerURL`).
    @discardableResult
    public func activate(url: URL) throws -> ServerAccount {
        let id = url.absoluteString
        // When re-activating an already-registered server we mirror its (possibly
        // per-server-edited, #17) identity into the global identity defaults so the
        // existing @AppStorage-backed consumers follow the switch. We never mirror
        // on first insert: a new entry is *seeded from* those defaults, so writing
        // back would change first-run identity for single-server users.
        var identityToMirror: ServerAccount?
        let result: ServerAccount = try storage.withLock { snapshot in
            if let existing = snapshot.servers.first(where: { $0.id == id }) {
                // Already registered: only flip the active selection + write
                // through when it actually changes, so the launch path
                // (restoreSavedServer → activate for the already-active server)
                // doesn't do a redundant synchronous Keychain write every start.
                if snapshot.activeServerID != id {
                    var updated = snapshot
                    updated.activeServerID = id
                    try persist(updated)
                    snapshot = updated
                    identityToMirror = existing
                }
                return existing
            }

            let account = makeSeededAccount(id: id, url: url)
            var updated = snapshot
            updated.servers.append(account)
            updated.activeServerID = id
            try persist(updated)
            snapshot = updated
            return account
        }
        if let identityToMirror {
            mirrorIdentityToDefaults(identityToMirror)
        }
        return result
    }

    /// Marks an already-registered server active (the Settings switcher, #17).
    /// No-op — returning nil — when `id` isn't registered or is already active.
    /// Mirrors the newly active server's identity into the global identity
    /// defaults so the avatar / header tint follow the switch.
    @discardableResult
    public func setActive(id: String) throws -> ServerAccount? {
        var newActive: ServerAccount?
        try storage.withLock { snapshot in
            guard snapshot.activeServerID != id,
                  let account = snapshot.servers.first(where: { $0.id == id }) else {
                return
            }
            var updated = snapshot
            updated.activeServerID = id
            try persist(updated)
            snapshot = updated
            newActive = account
        }
        if let newActive {
            mirrorIdentityToDefaults(newActive)
        }
        return newActive
    }

    /// Removes the server `id`. When it was the active server, auto-selects the
    /// next remaining server as active and mirrors its identity; returns the
    /// server that is active *after* removal (nil when none remain, i.e. the
    /// caller should return to onboarding). Removing a non-active server leaves
    /// the active selection untouched. No-op for an unregistered id. (#17)
    @discardableResult
    public func remove(id: String) throws -> ServerAccount? {
        var activeChangedTo: ServerAccount?
        var didChangeActive = false
        let activeAfter: ServerAccount? = try storage.withLock { snapshot in
            guard snapshot.servers.contains(where: { $0.id == id }) else {
                return snapshot.activeServer
            }
            var updated = snapshot
            let wasActive = snapshot.activeServerID == id
            updated.servers.removeAll { $0.id == id }
            if wasActive {
                let next = updated.servers.first
                updated.activeServerID = next?.id
                didChangeActive = true
                activeChangedTo = next
            }
            try persist(updated)
            snapshot = updated
            return updated.activeServer
        }
        if didChangeActive, let activeChangedTo {
            mirrorIdentityToDefaults(activeChangedTo)
        }
        return activeAfter
    }

    /// Replaces the stored entry for `account.id` (per-server identity edits,
    /// #17), bumping `updatedAt`. No-op for an unregistered id. Mirrors to the
    /// global identity defaults when the updated server is the active one, so the
    /// active server's edits show up live without each consumer reading the
    /// registry directly.
    public func update(_ account: ServerAccount) throws {
        var activeUpdate: ServerAccount?
        try storage.withLock { snapshot in
            guard let index = snapshot.servers.firstIndex(where: { $0.id == account.id }) else {
                return
            }
            var updated = account
            updated.updatedAt = now()
            var updatedSnapshot = snapshot
            updatedSnapshot.servers[index] = updated
            try persist(updatedSnapshot)
            snapshot = updatedSnapshot
            if snapshot.activeServerID == account.id {
                activeUpdate = updated
            }
        }
        if let activeUpdate {
            mirrorIdentityToDefaults(activeUpdate)
        }
    }

    /// Inserts or replaces `account` exactly as given — timestamps included —
    /// without touching the active selection. Used to apply a setup another
    /// device synced (TAL-91); the active server's identity is mirrored so the
    /// avatar and header tint follow the edit.
    public func upsert(_ account: ServerAccount) throws {
        var activeUpdate: ServerAccount?
        try storage.withLock { snapshot in
            var updated = snapshot
            if let index = updated.servers.firstIndex(where: { $0.id == account.id }) {
                guard updated.servers[index] != account else { return }
                updated.servers[index] = account
            } else {
                updated.servers.append(account)
            }
            try persist(updated)
            snapshot = updated
            if snapshot.activeServerID == account.id {
                activeUpdate = account
            }
        }
        if let activeUpdate {
            mirrorIdentityToDefaults(activeUpdate)
        }
    }

    /// Reorders the list to follow `ids`; servers not named keep their relative
    /// order after the named ones. No write when the order already matches.
    public func reorder(ids: [String]) throws {
        try storage.withLock { snapshot in
            let rank = Dictionary(ids.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
            let reordered = snapshot.servers.enumerated().sorted {
                (rank[$0.element.id] ?? ids.count, $0.offset) < (rank[$1.element.id] ?? ids.count, $1.offset)
            }.map(\.element)
            guard reordered.map(\.id) != snapshot.servers.map(\.id) else { return }
            var updated = snapshot
            updated.servers = reordered
            try persist(updated)
            snapshot = updated
        }
    }

    /// Forgets the active server entirely, mirroring a full sign-out
    /// (`AuthManager.clearLocalAuth`) so a single-server install returns to
    /// "no servers configured."
    public func forgetActiveServer() throws {
        try storage.withLock { snapshot in
            guard let id = snapshot.activeServerID else { return }
            var updated = snapshot
            updated.servers.removeAll { $0.id == id }
            updated.activeServerID = nil
            try persist(updated)
            snapshot = updated
        }
    }

    // MARK: - Seeding

    /// Builds a fresh entry, seeding per-server identity from the global identity
    /// defaults and falling back to a host-derived label/initials when those are
    /// empty (intake: "derive from the normalized host by default").
    private func makeSeededAccount(id: String, url: URL) -> ServerAccount {
        let hostFallback = url.host ?? url.absoluteString
        let storedName = (identityDefaults.string(forKey: SessionIdentitySettings.displayNameKey) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let storedInitials = identityDefaults.string(forKey: SessionIdentitySettings.initialsKey) ?? ""
        let storedColor = identityDefaults.string(forKey: HeaderLogoColor.storageKey) ?? ""

        let displayName = storedName.isEmpty ? hostFallback : storedName
        let initials = SessionIdentitySettings.displayInitials(
            displayName: displayName,
            storedInitials: storedInitials,
            fallbackFullName: hostFallback
        )
        let colorHex = HeaderLogoColor.normalizedHex(storedColor) ?? HeaderLogoColor.defaultHex

        let timestamp = now()
        return ServerAccount(
            id: id,
            urlString: id,
            displayName: displayName,
            initials: initials,
            headerLogoColorHex: colorHex,
            customHeadersRef: id,
            createdAt: timestamp,
            updatedAt: timestamp
        )
    }

    /// Writes `account`'s per-server identity into the global identity defaults
    /// (`sessionIdentity.*` / `headerLogoColorHex`). The active server's stored
    /// identity stays the source of truth; this keeps the global `@AppStorage`
    /// mirror — which the avatar, header logo color, and New Chat/Send tint read —
    /// in step whenever the active server changes or its identity is edited (#17).
    /// Called outside the storage lock (UserDefaults has its own synchronization).
    private func mirrorIdentityToDefaults(_ account: ServerAccount) {
        identityDefaults.set(account.displayName, forKey: SessionIdentitySettings.displayNameKey)
        identityDefaults.set(account.initials, forKey: SessionIdentitySettings.initialsKey)
        identityDefaults.set(account.headerLogoColorHex, forKey: HeaderLogoColor.storageKey)
    }

    // MARK: - Persistence

    /// Writes the snapshot through to the Keychain. Called under the storage lock.
    private func persist(_ snapshot: Snapshot) throws {
        let data = try JSONEncoder().encode(snapshot)
        try keychain.save(String(decoding: data, as: UTF8.self), forKey: .servers)
    }

    private static func loadSnapshot(from keychain: any KeychainStoring) -> Snapshot {
        guard
            let json = try? keychain.load(.servers),
            let data = json.data(using: .utf8),
            let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data)
        else {
            return Snapshot()
        }
        return snapshot
    }
}
