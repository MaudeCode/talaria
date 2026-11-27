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
    func deleteAll() async throws
}

extension CSSearchableIndex: SessionSpotlightIndex {
    func upsert(_ items: [CSSearchableItem]) async throws { try await indexSearchableItems(items) }
    func deleteItems(_ identifiers: [String]) async throws { try await deleteSearchableItems(withIdentifiers: identifiers) }
    func deleteDomain(_ identifier: String) async throws { try await deleteSearchableItems(withDomainIdentifiers: [identifier]) }
    func deleteAll() async throws { try await deleteAllSearchableItems() }
}

@MainActor
final class SessionSpotlightIndexer {
    private struct Metadata: Encodable {
        let title: String
        let project: String?
        let modifiedAt: Date?

        init(_ session: SessionSummary) {
            title = session.searchTitle ?? SessionRowPresentation.displayTitle(for: session)
            project = session.projectName
            modifiedAt = session.updatedAt.flatMap { $0.isFinite ? Date(timeIntervalSince1970: $0) : nil }
        }

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
    private weak var appLock: AppLockModel?

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

    func protect(with appLock: AppLockModel) {
        self.appLock = appLock
        appLock.prepareToEnable = { [weak self] in
            guard let self else { return }
            // App Lock suppresses donations as soon as enabling starts. Drain any older write before purging.
            await self.waitForPendingWrites()
            do { try await self.clearAll() }
            catch {
                Self.logger.warning("Could not remove Spotlight results before enabling App Lock: \(error)")
                throw error
            }
        }
        if appLock.isEnabled { enqueue { try await self.clearAll() } }
    }

    func replace(_ sessions: [SessionSummary], for server: URL) {
        guard let domain = Self.domain(for: server) else { return }
        enqueue {
            guard self.appLock?.suppressesSpotlight != true else { return }
            await self.retryPurges()
            guard !self.pendingPurges.contains(domain) else { return }
            var desired: [String: Metadata] = [:]
            for session in sessions {
                guard let id = Self.identifier(session.sessionId, domain: domain) else { continue }
                desired[id] = Metadata(session)
            }

            let previous = self.hashes[domain] ?? [:]
            try await self.deleteItems(previous.keys.filter { desired[$0] == nil }, domain: domain)
            try await self.upsert(desired, domain: domain)
        }
    }

    func update(_ session: SessionSummary, for server: URL) {
        guard let domain = Self.domain(for: server), let id = Self.identifier(session.sessionId, domain: domain) else { return }
        enqueue {
            guard self.hashes[domain]?[id] != nil, !self.pendingPurges.contains(domain) else { return }
            try await self.upsert([id: Metadata(session)], domain: domain)
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

    private func upsert(_ desired: [String: Metadata], domain: String) async throws {
        guard appLock?.suppressesSpotlight != true else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        var changed: [String: Data] = [:]
        var items: [CSSearchableItem] = []
        for (id, metadata) in desired {
            let hash = Data(SHA256.hash(data: try encoder.encode(metadata)))
            guard hashes[domain]?[id] != hash else { continue }
            changed[id] = hash
            items.append(metadata.searchableItem(id: id, domain: domain))
        }
        guard !changed.isEmpty else { return }

        // An interrupted upsert still leaves IDs to retry or remove on a later refresh.
        for id in changed.keys { hashes[domain, default: [:]][id] = Data() }
        defaults.set(hashes, forKey: Self.hashesKey)
        try await index.upsert(items)
        for (id, hash) in changed { hashes[domain, default: [:]][id] = hash }
        defaults.set(hashes, forKey: Self.hashesKey)
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

    private func clearAll() async throws {
        try await index.deleteAll()
        hashes.removeAll()
        pendingPurges.removeAll()
        defaults.removeObject(forKey: Self.hashesKey)
        defaults.removeObject(forKey: Self.purgesKey)
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
