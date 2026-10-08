import CloudKit
import Foundation

/// The remote side of configuration sync, narrowed to what the coordinator
/// needs. `CloudKitConfigurationSyncStore` is the only production conformer;
/// tests drive the coordinator through an in-memory one.
protocol ConfigurationSyncStore: Sendable {
    func accountAvailability() async -> ConfigurationSyncAccountAvailability
    /// Everything changed or deleted since `token` (all records when nil).
    func fetchChanges(since token: Data?) async throws -> ConfigurationSyncChanges
    /// Overwrites `records` and deletes `recordNames`. Last writer wins; the
    /// coordinator resolves conflicts before calling this.
    func save(_ records: [ConfigurationSyncRecord], deleting recordNames: [String]) async throws
    /// Removes every synced Talaria record for this iCloud user.
    func deleteAll() async throws
}

/// Talaria's private-database CloudKit store. All records live in one custom
/// zone so changes come back as a delta with deletions, and no query index
/// has to exist in the CloudKit schema.
///
/// The only field on any record is `payload`, written through
/// `CKRecord.encryptedValues`. CloudKit encrypts it on this device with key
/// material from the user's iCloud Keychain; record names are opaque UUIDs.
actor CloudKitConfigurationSyncStore: ConfigurationSyncStore {
    static let zoneName = "TalariaConfiguration"
    static let payloadKey = "payload"

    /// The container this build was configured with (`Info.plist`
    /// `TalariaCloudKitContainerIdentifier`, from `ICLOUD_CONTAINER_IDENTIFIER`).
    /// Nil when the value never resolved, so a misconfigured build fails closed.
    static var configuredContainerIdentifier: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "TalariaCloudKitContainerIdentifier") as? String,
              !value.isEmpty, !value.hasPrefix("$(") else { return nil }
        return value
    }

    static let zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)

    private let container: CKContainer
    private let database: CKDatabase
    private var zoneIsReady = false

    init(containerIdentifier: String) {
        container = CKContainer(identifier: containerIdentifier)
        database = container.privateCloudDatabase
    }

    func accountAvailability() async -> ConfigurationSyncAccountAvailability {
        do {
            switch try await container.accountStatus() {
            case .available:
                return .available
            case .noAccount:
                return .unavailable(String(localized: "Sign in to iCloud on this iPhone to sync."))
            case .restricted:
                return .unavailable(String(localized: "iCloud is restricted on this iPhone."))
            case .couldNotDetermine, .temporarilyUnavailable:
                return .unavailable(String(localized: "iCloud is temporarily unavailable."))
            @unknown default:
                return .unavailable(String(localized: "iCloud is temporarily unavailable."))
            }
        } catch {
            return .unavailable(Self.mapped(error).userMessage)
        }
    }

    func fetchChanges(since token: Data?) async throws -> ConfigurationSyncChanges {
        // Only a first sync (no token) may create the zone. Once this device
        // has synced, a missing zone means another device deleted the synced
        // data, and that must surface as `syncedDataDeleted`, not a fresh zone.
        if token == nil {
            try await ensureZone()
        }
        var serverToken = try token.flatMap {
            try NSKeyedUnarchiver.unarchivedObject(ofClass: CKServerChangeToken.self, from: $0)
        }
        var changes = ConfigurationSyncChanges()
        do {
            while true {
                let page = try await database.recordZoneChanges(inZoneWith: Self.zoneID, since: serverToken)
                for result in page.modificationResultsByID.values {
                    // A failed or unreadable record must fail the fetch: accepting
                    // the page token would skip that change on every later delta.
                    // Unknown record types are ignored.
                    let ckRecord = try result.get().record
                    guard ConfigurationSyncRecord.RecordType(rawValue: ckRecord.recordType) != nil else { continue }
                    guard let record = Self.syncRecord(from: ckRecord) else {
                        throw ConfigurationSyncStoreError.failed(
                            String(localized: "A synced record could not be read by this version of Talaria.")
                        )
                    }
                    changes.changed.append(record)
                }
                changes.deletedRecordNames += page.deletions.map(\.recordID.recordName)
                serverToken = page.changeToken
                if !page.moreComing { break }
            }
        } catch {
            throw noteZoneLoss(Self.mapped(error))
        }
        changes.changeToken = try serverToken.map {
            try NSKeyedArchiver.archivedData(withRootObject: $0, requiringSecureCoding: true)
        }
        // The fetch proved the zone exists; a later save must not recreate one
        // that another device deletes in between, it must fail as deleted.
        zoneIsReady = true
        return changes
    }

    func save(_ records: [ConfigurationSyncRecord], deleting recordNames: [String]) async throws {
        guard !records.isEmpty || !recordNames.isEmpty else { return }
        try await ensureZone()
        do {
            let result = try await database.modifyRecords(
                saving: records.map(Self.makeRecord),
                deleting: recordNames.map { CKRecord.ID(recordName: $0, zoneID: Self.zoneID) },
                savePolicy: .allKeys,
                atomically: true
            )
            for case .failure(let error) in result.saveResults.values {
                throw error
            }
            for case .failure(let error) in result.deleteResults.values
            where (error as? CKError)?.code != .unknownItem {
                throw error
            }
        } catch {
            throw noteZoneLoss(Self.mapped(error))
        }
    }

    /// A deleted zone means the next first sync must create it again.
    private func noteZoneLoss(_ error: ConfigurationSyncStoreError) -> ConfigurationSyncStoreError {
        if error == .syncedDataDeleted {
            zoneIsReady = false
        }
        return error
    }

    func deleteAll() async throws {
        do {
            let result = try await database.modifyRecordZones(saving: [], deleting: [Self.zoneID])
            for case .failure(let error) in result.deleteResults.values {
                throw error
            }
        } catch {
            let mapped = Self.mapped(error)
            // An already-missing zone is the outcome the user asked for.
            if mapped == .syncedDataDeleted {
                zoneIsReady = false
                return
            }
            throw mapped
        }
        zoneIsReady = false
    }

    private func ensureZone() async throws {
        guard !zoneIsReady else { return }
        do {
            let result = try await database.modifyRecordZones(saving: [CKRecordZone(zoneID: Self.zoneID)], deleting: [])
            for case .failure(let error) in result.saveResults.values {
                throw error
            }
        } catch {
            throw Self.mapped(error)
        }
        zoneIsReady = true
    }

    // MARK: - Record shape

    /// Builds the CloudKit record for one sync record: an opaque name in the
    /// Talaria zone whose only content is the encrypted `payload`. Pure, so a
    /// test can prove no plain field or record-name ever carries the payload.
    nonisolated static func makeRecord(_ record: ConfigurationSyncRecord) -> CKRecord {
        let ckRecord = CKRecord(
            recordType: record.type.rawValue,
            recordID: CKRecord.ID(recordName: record.name, zoneID: zoneID)
        )
        ckRecord.encryptedValues[payloadKey] = record.payload as NSData
        return ckRecord
    }

    nonisolated static func syncRecord(from ckRecord: CKRecord) -> ConfigurationSyncRecord? {
        guard let type = ConfigurationSyncRecord.RecordType(rawValue: ckRecord.recordType),
              let payload = ckRecord.encryptedValues[payloadKey] as? Data else { return nil }
        return ConfigurationSyncRecord(name: ckRecord.recordID.recordName, type: type, payload: payload)
    }

    // MARK: - Errors

    nonisolated static func mapped(_ error: Error) -> ConfigurationSyncStoreError {
        if let mapped = error as? ConfigurationSyncStoreError { return mapped }
        guard let ckError = error as? CKError else {
            return (error as? URLError) != nil ? .offline : .failed(error.localizedDescription)
        }
        // CloudKit's own description names record IDs and zones, so it goes in
        // the copyable detail and the row shows a sentence instead.
        let unmapped = ConfigurationSyncStoreError.failed(
            String(localized: "iCloud couldn't save your settings. Try again later."),
            detail: "CKError \(ckError.code.rawValue) \(ckError.code.name): \(ckError.localizedDescription)"
        )
        switch ckError.code {
        case .networkUnavailable, .networkFailure, .serviceUnavailable, .requestRateLimited, .zoneBusy:
            return .offline
        case .notAuthenticated, .accountTemporarilyUnavailable:
            return .accountUnavailable(String(localized: "Sign in to iCloud on this iPhone to sync."))
        case .changeTokenExpired:
            return .changeTokenExpired
        case .zoneNotFound, .userDeletedZone:
            return .syncedDataDeleted
        case .partialFailure:
            return ckError.partialErrorsByItemID?.values.first.map(mapped) ?? unmapped
        case .serverRejectedRequest:
            // Production refuses a record type missing from the deployed schema
            // ("Cannot create new type … in production schema").
            return .failed(
                String(localized: "iCloud sync isn't set up for this build yet. Settings sync will resume after an update."),
                detail: unmapped.detail
            )
        default:
            return unmapped
        }
    }
}

private extension CKError.Code {
    /// The SDK case name; CloudKit codes have no string form of their own.
    var name: String {
        switch self {
        case .internalError: "internalError"
        case .partialFailure: "partialFailure"
        case .networkUnavailable: "networkUnavailable"
        case .networkFailure: "networkFailure"
        case .badContainer: "badContainer"
        case .serviceUnavailable: "serviceUnavailable"
        case .requestRateLimited: "requestRateLimited"
        case .missingEntitlement: "missingEntitlement"
        case .notAuthenticated: "notAuthenticated"
        case .permissionFailure: "permissionFailure"
        case .unknownItem: "unknownItem"
        case .invalidArguments: "invalidArguments"
        case .resultsTruncated: "resultsTruncated"
        case .serverRecordChanged: "serverRecordChanged"
        case .serverRejectedRequest: "serverRejectedRequest"
        case .assetFileNotFound: "assetFileNotFound"
        case .assetFileModified: "assetFileModified"
        case .incompatibleVersion: "incompatibleVersion"
        case .constraintViolation: "constraintViolation"
        case .operationCancelled: "operationCancelled"
        case .changeTokenExpired: "changeTokenExpired"
        case .batchRequestFailed: "batchRequestFailed"
        case .zoneBusy: "zoneBusy"
        case .badDatabase: "badDatabase"
        case .quotaExceeded: "quotaExceeded"
        case .zoneNotFound: "zoneNotFound"
        case .limitExceeded: "limitExceeded"
        case .userDeletedZone: "userDeletedZone"
        case .tooManyParticipants: "tooManyParticipants"
        case .alreadyShared: "alreadyShared"
        case .referenceViolation: "referenceViolation"
        case .managedAccountRestricted: "managedAccountRestricted"
        case .participantMayNeedVerification: "participantMayNeedVerification"
        case .serverResponseLost: "serverResponseLost"
        case .assetNotAvailable: "assetNotAvailable"
        case .accountTemporarilyUnavailable: "accountTemporarilyUnavailable"
        default: "unknown"
        }
    }
}

/// Stands in when the build has no CloudKit container (UI-test fixture,
/// contributor builds without the entitlement). Every operation fails closed.
struct UnavailableConfigurationSyncStore: ConfigurationSyncStore {
    let reason: String

    func accountAvailability() async -> ConfigurationSyncAccountAvailability {
        .unavailable(reason)
    }

    func fetchChanges(since token: Data?) async throws -> ConfigurationSyncChanges {
        throw ConfigurationSyncStoreError.accountUnavailable(reason)
    }

    func save(_ records: [ConfigurationSyncRecord], deleting recordNames: [String]) async throws {
        throw ConfigurationSyncStoreError.accountUnavailable(reason)
    }

    func deleteAll() async throws {
        throw ConfigurationSyncStoreError.accountUnavailable(reason)
    }
}

extension ConfigurationSyncStoreError: LocalizedError, ErrorDetailProviding {
    public var errorDescription: String? { userMessage }

    /// Copy shown in Settings. Never carries a credential: every case is a
    /// fixed sentence or a system description of the failure.
    public var userMessage: String {
        switch self {
        case .offline: String(localized: "Waiting for a network connection.")
        case .accountUnavailable(let reason): reason
        case .changeTokenExpired: String(localized: "iCloud asked for a full resync.")
        case .syncedDataDeleted: String(localized: "Synced data was deleted from iCloud.")
        case .failed(let message, _): message
        }
    }

    public var detail: String? {
        guard case .failed(_, let detail) = self else { return nil }
        return detail
    }
}
