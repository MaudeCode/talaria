import Observation
import SwiftData
import XCTest
@testable import TalariaKit

@MainActor
final class CacheStoreIncrementalTests: XCTestCase {
    func testRepeated500SessionPayloadWritesNoRowsOrSaveAndChangedTitleWritesOneRow() throws {
        let context = try makeContext()
        let server = URL(string: "https://incremental-cache.test")!
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let sessions = (0..<500).map { SessionSummary(sessionId: "session-\($0)", title: "Title \($0)") }
        try CacheStore.cacheSessions(sessions, serverURL: server, in: context, cachedAt: now)
        let rows = try context.fetch(FetchDescriptor<CachedSession>())
        var changedRows = Set<String>()
        func observeRows() {
            for row in rows {
                withObservationTracking {
                    // Observe every stored property, including cache/detail metadata, so even an
                    // equal-value setter invalidation counts as a write to this row.
                    let fields: [PartialKeyPath<CachedSession>] = [
                        \.cacheKey, \.serverURLString, \.sessionID, \.title,
                        \.workspace, \.workspaceName, \.model, \.modelProvider,
                        \.messageCount, \.createdAt, \.updatedAt, \.lastMessageAt,
                        \.sortTs, \.pinned, \.archived, \.projectId,
                        \.profile, \.inputTokens, \.outputTokens, \.estimatedCost,
                        \.activeStreamId, \.isStreaming, \.isCliSession, \.userMessageCount,
                        \.hasPendingUserMessage, \.pendingStartedAt, \.worktreePath, \.sourceTag,
                        \.rawSource, \.sessionSource, \.sourceLabel, \.sourceKind,
                        \.parentSessionId, \.relationshipType, \.readOnly, \.isReadOnly,
                        \.listPosition, \.branchedFromSessionID, \.branchedFromTitle, \.canPin,
                        \.canArchive, \.canDelete, \.canDuplicate, \.canBranch,
                        \.transcriptOnly, \.runStatusData, \.ownerAttachmentData, \.executionModeData,
                        \.recentMessagesOffset, \.recentMessagesTruncated, \.recentMessagesCount, \.recentMessagesExpiresAt,
                        \.cachedAt, \.expiresAt,
                    ]
                    for field in fields { _ = row[keyPath: field] }
                } onChange: {
                    MainActor.assumeIsolated { _ = changedRows.insert(row.sessionID) }
                }
            }
        }
        var saves = 0
        let contextID = ObjectIdentifier(context)
        let observer = NotificationCenter.default.addObserver(forName: ModelContext.willSave, object: nil, queue: nil) { notification in
            guard let object = notification.object as AnyObject?, ObjectIdentifier(object) == contextID else { return }
            MainActor.assumeIsolated { saves += 1 }
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        observeRows()
        try CacheStore.cacheSessions(sessions, serverURL: server, in: context, cachedAt: now.addingTimeInterval(5))
        XCTAssertEqual(changedRows.count, 0, "An unchanged refresh must invoke no cached row setters")
        XCTAssertEqual(saves, 0, "An unchanged refresh must not call save()")

        changedRows.removeAll()
        observeRows()
        var changed = sessions
        changed[250] = SessionSummary(sessionId: "session-250", title: "Renamed")
        try CacheStore.cacheSessions(changed, serverURL: server, in: context, cachedAt: now.addingTimeInterval(10))
        XCTAssertEqual(changedRows, ["session-250"], "Only the changed row should receive property writes")
        XCTAssertEqual(saves, 1)
        XCTAssertEqual(try CacheStore.cachedSessions(serverURL: server, in: context, now: now)[250].title, "Renamed")
    }

    func testMaintenanceWaits60SecondsAndDoesNotThrottleAnotherContext() throws {
        let server = URL(string: "https://maintenance-cache.test")!
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let context = try makeContext()
        try CacheStore.cacheSessions([], serverURL: server, in: context, cachedAt: now)
        let expired = CachedSession(serverURLString: server.absoluteString,
            session: SessionSummary(sessionId: "expired"), cachedAt: now.addingTimeInterval(-CachePolicy.ttl))
        context.insert(expired)
        try context.save()

        try CacheStore.cacheSessions([], serverURL: URL(string: "https://trigger-cache.test")!,
            in: context, cachedAt: now.addingTimeInterval(59))
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<CachedSession>()), 1,
            "Maintenance must not run again before 60 seconds")

        let independent = try makeContext()
        independent.insert(CachedSession(serverURLString: server.absoluteString,
            session: SessionSummary(sessionId: "independent-expired"), cachedAt: now.addingTimeInterval(-CachePolicy.ttl)))
        try independent.save()
        try CacheStore.cacheSessions([], serverURL: URL(string: "https://trigger-cache.test")!,
            in: independent, cachedAt: now.addingTimeInterval(59))
        XCTAssertEqual(try independent.fetchCount(FetchDescriptor<CachedSession>()), 0,
            "One context must not suppress another context's first maintenance")

        try CacheStore.cacheSessions([], serverURL: URL(string: "https://trigger-cache.test")!,
            in: context, cachedAt: now.addingTimeInterval(60))
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<CachedSession>()), 0)
    }

    func testForegroundMaintenanceBypassesThrottleAndSavesExpiredRows() throws {
        let context = try makeContext()
        let server = URL(string: "https://foreground-cache.test")!
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        try CacheStore.cacheSessions([], serverURL: server, in: context, cachedAt: now)
        context.insert(CachedSession(serverURLString: server.absoluteString,
            session: SessionSummary(sessionId: "expired"), cachedAt: now.addingTimeInterval(-CachePolicy.ttl)))
        context.insert(CachedMessage(serverURLString: server.absoluteString, sessionID: "expired",
            message: ChatMessage(role: "user", content: "Expired", timestamp: nil, messageId: "expired"),
            sortIndex: 0, cachedAt: now.addingTimeInterval(-CachePolicy.ttl)))
        try context.save()
        try CacheStore.maintainCache(in: context, now: now.addingTimeInterval(1))
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<CachedSession>()), 0)
        XCTAssertEqual(try context.fetchCount(FetchDescriptor<CachedMessage>()), 0)
        XCTAssertFalse(context.hasChanges, "Foreground cleanup must be persisted without needing a network refresh")
    }

    func testUnchangedRowsRenewExpiryPeriodicallyAndDetailUsesTheSameGuard() throws {
        let context = try makeContext()
        let server = URL(string: "https://expiry-cache.test")!
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let session = SessionSummary(sessionId: "unchanged", title: "Title")
        try CacheStore.cacheSessions([session], serverURL: server, in: context, cachedAt: now)
        let row = try XCTUnwrap(context.fetch(FetchDescriptor<CachedSession>()).first)
        try CacheStore.cacheSession(session, serverURL: server, in: context, cachedAt: now.addingTimeInterval(5))
        XCTAssertEqual(row.cachedAt, now)
        try CacheStore.cacheSessions([session], serverURL: server, in: context, cachedAt: now.addingTimeInterval(60))
        XCTAssertEqual(row.cachedAt, now, "A maintenance pass must not rewrite unchanged session timestamps")
        let renewedAt = now.addingTimeInterval(CachePolicy.ttl / 2)
        try CacheStore.cacheSessions([session], serverURL: server, in: context, cachedAt: renewedAt)
        XCTAssertEqual(row.cachedAt, renewedAt)
        XCTAssertEqual(row.expiresAt, renewedAt.addingTimeInterval(CachePolicy.ttl))
        XCTAssertEqual(try CacheStore.cachedSessions(serverURL: server, in: context,
            now: now.addingTimeInterval(CachePolicy.ttl + 1)).count, 1)
    }

    func testReorderingOnlyUpdatesPositionsAndKeepsDetailMetadata() throws {
        let context = try makeContext()
        let server = URL(string: "https://order-cache.test")!
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let first = SessionSummary(sessionId: "first", title: "First")
        let second = SessionSummary(sessionId: "second", title: "Second")
        try CacheStore.cacheSessions([first, second], serverURL: server, in: context, cachedAt: now)
        let row = try XCTUnwrap(context.fetch(FetchDescriptor<CachedSession>()).first { $0.sessionID == "first" })
        row.branchedFromSessionID = "parent"
        row.branchedFromTitle = "Parent"
        row.runStatusData = Data("detail".utf8)
        try context.save()
        try CacheStore.cacheSessions([second, first], serverURL: server, in: context, cachedAt: now.addingTimeInterval(5))
        XCTAssertEqual(try CacheStore.cachedSessions(serverURL: server, in: context, now: now).compactMap(\.sessionId), ["second", "first"])
        XCTAssertEqual(row.cachedAt, now)
        XCTAssertEqual(row.branchedFromSessionID, "parent")
        XCTAssertEqual(row.runStatusData, Data("detail".utf8))
    }

    private func makeContext() throws -> ModelContext {
        let container = try ModelContainer(for: CachedSession.self, CachedMessage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none))
        let context = ModelContext(container)
        context.autosaveEnabled = false
        return context
    }
}
