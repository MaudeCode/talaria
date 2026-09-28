import Foundation

/// Pure reconciliation of the local server list against what CloudKit
/// reported. Deterministic on purpose: given the same inputs every device
/// produces the same plan, which is what stops two devices ping-ponging.
///
/// Rules, in order:
/// 1. A record deleted remotely removes the matching local server.
/// 2. A server removed locally is deleted remotely (`pendingDeletions`).
/// 3. Two records for one URL collapse onto the lexically smaller record name;
///    the other is deleted so a race between devices cannot leave duplicates.
/// 4. Per server, the newer `updatedAt` wins. A winner with no password
///    inherits the loser's, so a device that never saw the password cannot
///    erase it.
/// 5. Anything local whose fingerprint differs from the last uploaded one goes
///    up under its existing (or a fresh opaque) record name.
enum ConfigurationSyncMerge {
    struct RemoteSetup: Equatable {
        var recordName: String
        var setup: SyncedServerSetup
    }

    struct Upload: Equatable {
        var recordName: String
        var setup: SyncedServerSetup
    }

    struct Plan: Equatable {
        /// Servers to insert or overwrite locally, already ordered by position.
        var applyLocally: [SyncedServerSetup] = []
        /// Server ids to remove locally.
        var removeLocally: [String] = []
        var upload: [Upload] = []
        var deleteRemote: [String] = []
        /// Bookkeeping after the plan is applied and uploads succeed.
        var recordNames: [String: String] = [:]
        var uploaded: [String: ConfigurationSyncState.UploadMark] = [:]
        var pendingDeletions: [String] = []
        /// The merged list in final order, by server id.
        var order: [String] = []
    }

    static func plan(
        local: [SyncedServerSetup],
        remote: [RemoteSetup],
        remoteDeletions: [String],
        state: ConfigurationSyncState,
        now: Date,
        makeRecordName: () -> String = { UUID().uuidString }
    ) -> Plan {
        var plan = Plan()
        var recordNames = state.recordNames
        var uploaded = state.uploaded
        var pending = Set(state.pendingDeletions)
        let localByID = Dictionary(local.map { ($0.serverID, $0) }, uniquingKeysWith: { first, _ in first })

        // 2. Locally removed servers still mapped to a record → delete remotely.
        for (serverID, recordName) in recordNames where localByID[serverID] == nil {
            pending.insert(recordName)
            recordNames.removeValue(forKey: serverID)
            uploaded.removeValue(forKey: serverID)
        }

        // 1. Remote deletions.
        let deletedNames = Set(remoteDeletions)
        for (serverID, recordName) in recordNames where deletedNames.contains(recordName) {
            recordNames.removeValue(forKey: serverID)
            uploaded.removeValue(forKey: serverID)
            if localByID[serverID] != nil {
                plan.removeLocally.append(serverID)
            }
        }
        pending.subtract(deletedNames)

        var merged: [String: SyncedServerSetup] = localByID
        for id in plan.removeLocally {
            merged.removeValue(forKey: id)
        }

        // 3 + 4. Remote changes.
        for change in remote.sorted(by: { $0.recordName < $1.recordName }) {
            let serverID = change.setup.serverID
            if pending.contains(change.recordName) { continue }

            var isCanonicalRecord = true
            if let existingName = recordNames[serverID], existingName != change.recordName {
                let canonical = min(existingName, change.recordName)
                let duplicate = max(existingName, change.recordName)
                plan.deleteRemote.append(duplicate)
                recordNames[serverID] = canonical
                isCanonicalRecord = change.recordName == canonical
            } else {
                recordNames[serverID] = change.recordName
            }

            let local = merged[serverID]
            let localChangedAt = local.map { max($0.updatedAt, state.localChangedAt[serverID] ?? .distantPast) }
            if let local, let localChangedAt, localChangedAt >= change.setup.updatedAt {
                // Local wins. Forget the upload mark when the remote copy differs so
                // the fingerprint check below pushes the local version back up.
                let kept = local.keepingPassword(from: change.setup)
                merged[serverID] = kept
                if kept != local {
                    // The remote copy carried the password this device lacked:
                    // store it here as well, not only in the upload.
                    plan.applyLocally.append(kept)
                }
                if change.setup.fingerprint != kept.fingerprint {
                    uploaded.removeValue(forKey: serverID)
                }
                continue
            }
            let winner = change.setup.keepingPassword(from: local)
            merged[serverID] = winner
            // Only the final winner for a server is applied; a provisional one
            // queued from an earlier duplicate record must not replay after it.
            plan.applyLocally.removeAll { $0.serverID == serverID }
            plan.applyLocally.append(winner)
            // Mark what the canonical record holds, not the winner: when the winner
            // inherited a local password, or arrived under a duplicate name that
            // is about to be deleted, the fingerprints differ and it uploads below.
            if isCanonicalRecord {
                uploaded[serverID] = .init(fingerprint: change.setup.fingerprint, changedAt: change.setup.updatedAt)
            } else {
                uploaded.removeValue(forKey: serverID)
            }
        }

        // 5. Uploads.
        let order = merged.values.sorted {
            ($0.position, $0.serverID) < ($1.position, $1.serverID)
        }
        for (index, var setup) in order.enumerated() {
            setup.position = index
            let serverID = setup.serverID
            let recordName: String
            if let existing = recordNames[serverID] {
                recordName = existing
            } else {
                recordName = makeRecordName()
                recordNames[serverID] = recordName
            }
            if uploaded[serverID]?.fingerprint != setup.fingerprint {
                setup.updatedAt = max(setup.updatedAt, state.localChangedAt[serverID] ?? .distantPast, now)
                plan.upload.append(Upload(recordName: recordName, setup: setup))
            }
        }

        plan.applyLocally.sort { ($0.position, $0.serverID) < ($1.position, $1.serverID) }
        plan.deleteRemote += pending.sorted()
        plan.recordNames = recordNames
        plan.uploaded = uploaded
        plan.pendingDeletions = pending.sorted()
        plan.order = order.map(\.serverID)
        return plan
    }
}
