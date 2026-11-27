import CoreSpotlight
import CryptoKit
import Foundation
import OSLog
import UniformTypeIdentifiers

@MainActor
protocol SessionSpotlightIndex {
    func upsert(_ items: [CSSearchableItem]) async throws
    func deleteItems(_ identifiers: [String]) async throws
    func deleteDomain(_ identifier: String) async throws
}

extension CSSearchableIndex: SessionSpotlightIndex {
    func upsert(_ items: [CSSearchableItem]) async throws { try await indexSearchableItems(items) }
    func deleteItems(_ identifiers: [String]) async throws { try await deleteSearchableItems(withIdentifiers: identifiers) }
    func deleteDomain(_ identifier: String) async throws { try await deleteSearchableItems(withDomainIdentifiers: [identifier]) }
}

@MainActor
final class SessionSpotlightIndexer {
    private struct Metadata: Encodable {
        let title: String
        let project: String?
        let modifiedAt: Date?

        func searchableItem(id: String, domain: String) -> CSSearchableItem {
            let attributes = CSSearchableItemAttributeSet(contentType: .text)
            attributes.title = title
            attributes.contentDescription = project
            attributes.contentModificationDate = modifiedAt
            let item = CSSearchableItem(uniqueIdentifier: id, domainIdentifier: domain, attributeSet: attributes)
            item.expirationDate = .distantFuture
            return item
        }
    }

    private static let hashesKey = "sessionSpotlight.hashes"
    private static let purgesKey = "sessionSpotlight.pendingDomainPurges"
    private static let logger = Logger(subsystem: "dev.kil.talaria", category: "session-spotlight")

    private let index: any SessionSpotlightIndex
    private let defaults: UserDefaults
    // Keep IDs and content digests across launches without making a second store of chat titles.
    private var hashes: [String: [String: Data]]
    private var pendingPurges: Set<String>
    private var pendingWrite: Task<Void, Never>?

    static func system() -> SessionSpotlightIndexer? {
        guard CSSearchableIndex.isIndexingAvailable() else { return nil }
        return SessionSpotlightIndexer(
            index: CSSearchableIndex(name: "talaria-sessions", protectionClass: .complete), defaults: .standard
        )
    }

    init(index: any SessionSpotlightIndex, defaults: UserDefaults) {
        self.index = index
        self.defaults = defaults
        hashes = defaults.dictionary(forKey: Self.hashesKey) as? [String: [String: Data]] ?? [:]
        pendingPurges = Set(defaults.stringArray(forKey: Self.purgesKey) ?? [])
        if !pendingPurges.isEmpty { enqueue { await self.retryPurges() } }
    }

    func replace(_ sessions: [SessionSummary], for server: URL) {
        guard let domain = Self.domain(for: server) else { return }
        enqueue {
            await self.retryPurges()
            guard !self.pendingPurges.contains(domain) else { return }
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            var desired: [String: (metadata: Metadata, hash: Data)] = [:]
            for session in sessions {
                guard let id = Self.identifier(session.sessionId, domain: domain) else { continue }
                let metadata = Metadata(
                    title: SessionRowPresentation.displayTitle(for: session),
                    project: session.projectName,
                    modifiedAt: session.updatedAt.flatMap { $0.isFinite ? Date(timeIntervalSince1970: $0) : nil }
                )
                desired[id] = (metadata, Data(SHA256.hash(data: try encoder.encode(metadata))))
            }

            let previous = self.hashes[domain] ?? [:]
            try await self.deleteItems(previous.keys.filter { desired[$0] == nil }, domain: domain)
            let changed = desired.filter { previous[$0.key] != $0.value.hash }
            guard !changed.isEmpty else { return }

            // An interrupted upsert still leaves IDs to retry or remove on a later refresh.
            for id in changed.keys { self.hashes[domain, default: [:]][id] = Data() }
            self.defaults.set(self.hashes, forKey: Self.hashesKey)
            try await self.index.upsert(changed.map { $0.value.metadata.searchableItem(id: $0.key, domain: domain) })
            for (id, entry) in changed { self.hashes[domain, default: [:]][id] = entry.hash }
            self.defaults.set(self.hashes, forKey: Self.hashesKey)
        }
    }

    func remove(_ sessionIDs: [String]?, for server: URL) {
        guard let domain = Self.domain(for: server) else { return }
        enqueue {
            if let sessionIDs {
                try await self.deleteItems(sessionIDs.compactMap { Self.identifier($0, domain: domain) }, domain: domain)
            } else {
                self.pendingPurges.insert(domain)
                self.defaults.set(Array(self.pendingPurges), forKey: Self.purgesKey)
                try await self.purge(domain)
            }
        }
    }

    func waitForPendingWrites() async { await pendingWrite?.value }

    private static func domain(for server: URL) -> String? {
        // The index and its links must never carry credentials embedded in a server URL.
        guard TalariaRelayClient.originURL(server) != nil else { return nil }
        return server.absoluteString
    }

    private static func identifier(_ sessionID: String?, domain: String) -> String? {
        sessionID.flatMap { TalariaDeepLink.sessionURL(sessionID: $0, publisherID: domain)?.absoluteString }
    }

    private func deleteItems(_ identifiers: [String], domain: String) async throws {
        guard !identifiers.isEmpty else { return }
        try await index.deleteItems(identifiers)
        for id in identifiers { hashes[domain]?.removeValue(forKey: id) }
        defaults.set(hashes, forKey: Self.hashesKey)
    }

    private func purge(_ domain: String) async throws {
        try await index.deleteDomain(domain)
        hashes.removeValue(forKey: domain)
        defaults.set(hashes, forKey: Self.hashesKey)
        pendingPurges.remove(domain)
        defaults.set(Array(pendingPurges), forKey: Self.purgesKey)
    }

    private func retryPurges() async {
        for domain in pendingPurges {
            do { try await purge(domain) }
            catch { Self.logger.warning("Could not remove a server's Spotlight results: \(error)") }
        }
    }

    private func enqueue(_ write: @escaping @MainActor () async throws -> Void) {
        let previous = pendingWrite
        pendingWrite = Task {
            await previous?.value
            do { try await write() }
            catch { Self.logger.warning("Could not update Spotlight results: \(error)") }
        }
    }
}
