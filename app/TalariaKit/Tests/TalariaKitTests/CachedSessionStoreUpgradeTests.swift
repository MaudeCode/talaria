import SwiftData
import XCTest
@testable import TalariaKit

/// A cache store written before the row action gates (TAL-723) opens under the current model.
@MainActor
final class CachedSessionStoreUpgradeTests: XCTestCase {
    func testAStoreWrittenBeforeTheRowActionGatesOpensAndKeepsItsRows() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeURL = directory.appendingPathComponent("cache.store")
        let serverURL = URL(string: "https://example.test")!
        let cachedAt = Date()

        do {
            let container = try ModelContainer(
                for: PreRowActionGates.CachedSession.self, CachedMessage.self,
                configurations: ModelConfiguration(url: storeURL, cloudKitDatabase: .none)
            )
            let context = ModelContext(container)
            context.insert(PreRowActionGates.CachedSession(
                cacheKey: CachedSession.cacheKey(serverURLString: serverURL.absoluteString, sessionID: "old"),
                serverURLString: serverURL.absoluteString,
                sessionID: "old",
                title: "Cached before the gates",
                cachedAt: cachedAt
            ))
            try context.save()
        }

        let container = try ModelContainer(
            for: CachedSession.self, CachedMessage.self,
            configurations: ModelConfiguration(url: storeURL, cloudKitDatabase: .none)
        )
        let context = ModelContext(container)
        let old = try XCTUnwrap(CacheStore.cachedSessions(serverURL: serverURL, in: context).first)
        XCTAssertEqual(old.title, "Cached before the gates")
        XCTAssertNil(old.canPin)
        XCTAssertNil(old.canBranch)

        try CacheStore.cacheSessions(
            [SessionSummary(sessionId: "old", title: "Reloaded", canBranch: false, canPin: true, canArchive: true, canDelete: false, canDuplicate: true)],
            serverURL: serverURL,
            in: context
        )
        let reloaded = try XCTUnwrap(CacheStore.cachedSessions(serverURL: serverURL, in: context).first)
        XCTAssertEqual(reloaded.canPin, true)
        XCTAssertEqual(reloaded.canBranch, false)
    }
}

/// `CachedSession` as main stored it before TAL-723; SwiftData names the entity after the bare class name.
enum PreRowActionGates {
    @Model
    final class CachedSession {
        @Attribute(.unique) var cacheKey: String
        var serverURLString: String
        var sessionID: String
        var title: String?
        var workspace: String?
        var workspaceName: String?
        var model: String?
        var modelProvider: String?
        var messageCount: Int?
        var createdAt: Double?
        var updatedAt: Double?
        var lastMessageAt: Double?
        var sortTs: Double?
        var pinned: Bool?
        var archived: Bool?
        var projectId: String?
        var profile: String?
        var inputTokens: Int?
        var outputTokens: Int?
        var estimatedCost: Double?
        var activeStreamId: String?
        var isStreaming: Bool?
        var isCliSession: Bool?
        var userMessageCount: Int?
        var hasPendingUserMessage: Bool?
        var pendingStartedAt: Double?
        var worktreePath: String?
        var sourceTag: String?
        var rawSource: String?
        var sessionSource: String?
        var sourceLabel: String?
        var sourceKind: String?
        var parentSessionId: String?
        var relationshipType: String?
        var readOnly: Bool?
        var isReadOnly: Bool?
        var listPosition: Int?
        var branchedFromSessionID: String?
        var branchedFromTitle: String?
        var cachedAt: Date
        var expiresAt: Date

        init(cacheKey: String, serverURLString: String, sessionID: String, title: String, cachedAt: Date) {
            self.cacheKey = cacheKey
            self.serverURLString = serverURLString
            self.sessionID = sessionID
            self.title = title
            self.cachedAt = cachedAt
            self.expiresAt = cachedAt.addingTimeInterval(CachePolicy.ttl)
        }
    }
}
