import CryptoKit
import Foundation

/// One configured server as it travels through the user's private CloudKit
/// database (TAL-91). The whole struct is the *encrypted* payload of a
/// `ServerSetup` record: the URL, password, and custom headers never appear in
/// the record name or an ordinary field, so record metadata exposes nothing
/// about the server. `version` lets a later payload shape decode an older one.
struct SyncedServerSetup: Codable, Equatable, Sendable {
    static let currentVersion = 1

    var version: Int
    var urlString: String
    var displayName: String
    var initials: String
    var headerLogoColorHex: String
    /// `nil` means no device has captured a password yet; `""` means the server
    /// authenticated without one (auth off, trusted headers, or OIDC).
    var password: String?
    var customHeaders: [CustomHeader]
    /// Position in the configured-server list, so order converges too.
    var position: Int
    /// When the writing device last changed this setup. Last writer wins.
    var updatedAt: Date

    init(
        version: Int = SyncedServerSetup.currentVersion,
        urlString: String,
        displayName: String,
        initials: String,
        headerLogoColorHex: String,
        password: String?,
        customHeaders: [CustomHeader],
        position: Int,
        updatedAt: Date
    ) {
        self.version = version
        self.urlString = urlString
        self.displayName = displayName
        self.initials = initials
        self.headerLogoColorHex = headerLogoColorHex
        self.password = password
        self.customHeaders = customHeaders
        self.position = position
        self.updatedAt = updatedAt
    }

    init(
        account: ServerAccount,
        password: String?,
        customHeaders: [CustomHeader],
        position: Int,
        updatedAt: Date
    ) {
        self.init(
            urlString: account.urlString,
            displayName: account.displayName,
            initials: account.initials,
            headerLogoColorHex: account.headerLogoColorHex,
            password: password,
            customHeaders: customHeaders,
            position: position,
            updatedAt: updatedAt
        )
    }

    enum CodingKeys: String, CodingKey {
        case version, urlString, displayName, initials, headerLogoColorHex
        case password, customHeaders, position, updatedAt
    }

    /// Tolerant: a payload written by a newer or older build still decodes as
    /// long as it names its server.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? 1
        try ConfigurationSyncCodec.requireSupported(version: version, of: Self.currentVersion, in: container)
        urlString = try container.decode(String.self, forKey: .urlString)
        displayName = try container.decodeIfPresent(String.self, forKey: .displayName) ?? ""
        initials = try container.decodeIfPresent(String.self, forKey: .initials) ?? ""
        headerLogoColorHex = try container.decodeIfPresent(String.self, forKey: .headerLogoColorHex)
            ?? HeaderLogoColor.defaultHex
        password = try container.decodeIfPresent(String.self, forKey: .password)
        customHeaders = try container.decodeIfPresent([CustomHeader].self, forKey: .customHeaders) ?? []
        position = try container.decodeIfPresent(Int.self, forKey: .position) ?? 0
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date(timeIntervalSince1970: 0)
    }

    /// The server identity used for local dedup; matches `ServerAccount.id`.
    var serverID: String { urlString }

    /// Content hash used to decide whether a local setup differs from what was
    /// last uploaded or downloaded. `updatedAt` is excluded on purpose: a
    /// timestamp alone is not a change worth a CloudKit write.
    var fingerprint: String {
        var stable = self
        stable.updatedAt = Date(timeIntervalSince1970: 0)
        return ConfigurationSyncCodec.fingerprint(of: stable)
    }

    /// `self` with the password filled from `other` when this copy has none.
    /// A later edit from a device that never captured the password must not
    /// wipe the one another device saved.
    func keepingPassword(from other: SyncedServerSetup?) -> SyncedServerSetup {
        guard password == nil, let inherited = other?.password else { return self }
        var merged = self
        merged.password = inherited
        return merged
    }
}

/// The allowlisted app preferences, one record per iCloud user.
struct SyncedPreferences: Codable, Equatable {
    static let currentVersion = 1

    var version: Int
    var values: [String: JSONValue]
    var updatedAt: Date

    init(version: Int = SyncedPreferences.currentVersion, values: [String: JSONValue], updatedAt: Date) {
        self.version = version
        self.values = values
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case version, values, updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? 1
        try ConfigurationSyncCodec.requireSupported(version: version, of: Self.currentVersion, in: container)
        values = try container.decodeIfPresent([String: JSONValue].self, forKey: .values) ?? [:]
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date(timeIntervalSince1970: 0)
    }

    var fingerprint: String { ConfigurationSyncCodec.fingerprint(of: values) }
}

/// Deterministic JSON so fingerprints and encrypted payloads are stable across
/// devices and launches.
enum ConfigurationSyncCodec {
    /// Dates keep sub-second precision: timestamps order edits between
    /// devices, and ISO 8601 would round two edits in one second to a tie that
    /// each device keeps winning.
    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }

    /// A payload from a newer build may have renamed or dropped fields; reading
    /// it with defaults could apply destructive values and then overwrite the
    /// newer record. Older versions decode tolerantly, newer ones are refused.
    static func requireSupported<K: CodingKey>(version: Int, of current: Int, in container: KeyedDecodingContainer<K>) throws {
        guard version <= current else {
            throw DecodingError.dataCorruptedError(
                forKey: K(stringValue: "version")!,
                in: container,
                debugDescription: "Payload version \(version) is newer than \(current)"
            )
        }
    }

    static func fingerprint<T: Encodable>(of value: T) -> String {
        guard let data = try? encoder().encode(value) else { return "" }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// A record as the sync store sees it: an opaque name, a type, and one
/// encrypted payload. Keeping CloudKit types out of this shape lets the
/// coordinator and its tests run against an in-memory store.
struct ConfigurationSyncRecord: Equatable, Sendable {
    enum RecordType: String, Sendable {
        case serverSetup = "ServerSetup"
        case preferences = "AppPreferences"
    }

    /// The single record holding the allowlisted preferences.
    static let preferencesRecordName = "preferences"

    var name: String
    var type: RecordType
    var payload: Data

    static func serverSetup(name: String, _ setup: SyncedServerSetup) throws -> ConfigurationSyncRecord {
        ConfigurationSyncRecord(
            name: name,
            type: .serverSetup,
            payload: try ConfigurationSyncCodec.encoder().encode(setup)
        )
    }

    static func preferences(_ preferences: SyncedPreferences) throws -> ConfigurationSyncRecord {
        ConfigurationSyncRecord(
            name: preferencesRecordName,
            type: .preferences,
            payload: try ConfigurationSyncCodec.encoder().encode(preferences)
        )
    }
}

struct ConfigurationSyncChanges: Equatable, Sendable {
    var changed: [ConfigurationSyncRecord] = []
    var deletedRecordNames: [String] = []
    var changeToken: Data?
}

/// What CloudKit says about the signed-in iCloud account.
enum ConfigurationSyncAccountAvailability: Equatable, Sendable {
    case available
    case unavailable(String)
}

public enum ConfigurationSyncStoreError: Error, Equatable {
    /// No network, throttled, or CloudKit temporarily down: retry later.
    case offline
    /// Not signed in to iCloud, restricted, or the account changed under us.
    case accountUnavailable(String)
    /// The server rejected our change token; fetch from the beginning.
    case changeTokenExpired
    /// The zone is gone: another device deleted the synced Talaria data.
    case syncedDataDeleted
    case failed(String)
}

/// The per-device sync bookkeeping. It maps server ids (normalized URLs) to
/// opaque record names, so it lives in the Keychain next to the registry
/// rather than in UserDefaults.
struct ConfigurationSyncState: Codable, Equatable, Sendable {
    struct UploadMark: Codable, Equatable, Sendable {
        var fingerprint: String
        var changedAt: Date
    }

    var appleUserID: String?
    var isEnabled = false
    var changeToken: Data?
    /// server id → record name
    var recordNames: [String: String] = [:]
    /// server id → last fingerprint known to match the remote copy
    var uploaded: [String: UploadMark] = [:]
    /// Record names removed locally that still need a remote delete.
    var pendingDeletions: [String] = []
    /// When each local setup last changed, keyed by server id. Seeds `updatedAt`
    /// on upload so the other device can order edits.
    var localChangedAt: [String: Date] = [:]
    var preferencesMark: UploadMark?
    /// When a not-yet-uploaded local preference edit was first noticed, so a
    /// remote record older than that edit cannot overwrite it.
    var preferencesChangedAt: Date?
    var lastSyncAt: Date?

    enum CodingKeys: String, CodingKey {
        case appleUserID, isEnabled, changeToken, recordNames, uploaded
        case pendingDeletions, localChangedAt, preferencesMark, preferencesChangedAt, lastSyncAt
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        appleUserID = try container.decodeIfPresent(String.self, forKey: .appleUserID)
        isEnabled = try container.decodeIfPresent(Bool.self, forKey: .isEnabled) ?? false
        changeToken = try container.decodeIfPresent(Data.self, forKey: .changeToken)
        recordNames = try container.decodeIfPresent([String: String].self, forKey: .recordNames) ?? [:]
        uploaded = try container.decodeIfPresent([String: UploadMark].self, forKey: .uploaded) ?? [:]
        pendingDeletions = try container.decodeIfPresent([String].self, forKey: .pendingDeletions) ?? []
        localChangedAt = try container.decodeIfPresent([String: Date].self, forKey: .localChangedAt) ?? [:]
        preferencesMark = try container.decodeIfPresent(UploadMark.self, forKey: .preferencesMark)
        preferencesChangedAt = try container.decodeIfPresent(Date.self, forKey: .preferencesChangedAt)
        lastSyncAt = try container.decodeIfPresent(Date.self, forKey: .lastSyncAt)
    }

    /// Forgets everything tied to the remote zone while keeping the Apple
    /// sign-in, for disconnect and for a zone deleted elsewhere.
    mutating func resetRemoteBookkeeping() {
        isEnabled = false
        changeToken = nil
        recordNames = [:]
        uploaded = [:]
        pendingDeletions = []
        localChangedAt = [:]
        preferencesMark = nil
        preferencesChangedAt = nil
        lastSyncAt = nil
    }
}

/// What the Settings row and the sync screen show. Apple sign-in and iCloud
/// availability stay separate: a valid Apple credential never implies CloudKit
/// is reachable.
public enum ConfigurationSyncStatus: Equatable, Sendable {
    case signedOut
    case appleCredentialRevoked
    case disabled
    case unavailable(String)
    case offline
    case syncing
    case failed(String)
    /// Synced, but these servers have no saved password yet, so another device
    /// could not sign in to them.
    case missingCredentials([String])
    case synced(Date?)

    public var isSyncing: Bool { self == .syncing }
}
