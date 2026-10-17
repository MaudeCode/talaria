import SwiftData
import XCTest
@testable import TalariaKit

// TAL-437: a chat left mid-run, or an app backgrounded mid-run, reopens on its partial answer.
@MainActor
extension ChatViewModelSendTests {
    func testHistoryCacheCoalescesPagesUntilScrollingSettles() async throws {
        let (viewModel, context, server) = try await makePagedHistoryCacheFixture()
        viewModel.handleTranscriptScroll(.userScrollBegin)
        let first = await viewModel.loadOlderMessages(modelContext: context)
        XCTAssertTrue(first)
        XCTAssertEqual(viewModel.messages.count, 100)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context).count, 50,
                       "Loading history during a gesture must not synchronously rewrite the offline cache")
        let second = await viewModel.loadOlderMessages(modelContext: context)
        XCTAssertTrue(second)
        XCTAssertEqual(viewModel.messages.count, 150)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context).count, 50)
        viewModel.handleTranscriptScroll(.userScrollEnd(isAtBottom: false))
        let cached = try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context)
        XCTAssertEqual(cached.map(\.messageId), (0..<150).map { "history-\($0)" })
    }

    func testHistoryCachePersistsOnExitBeforeTheGestureSettles() async throws {
        let (viewModel, context, server) = try await makePagedHistoryCacheFixture()
        viewModel.handleTranscriptScroll(.userScrollBegin)
        let loaded = await viewModel.loadOlderMessages(modelContext: context)
        XCTAssertTrue(loaded)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context).count, 50)
        viewModel.persistTranscript(modelContext: context)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context).count, 100)
        let savedAt = try XCTUnwrap(context.fetch(FetchDescriptor<CachedMessage>()).first).cachedAt
        viewModel.handleTranscriptScroll(.userScrollEnd(isAtBottom: false))
        XCTAssertEqual(try XCTUnwrap(context.fetch(FetchDescriptor<CachedMessage>()).first).cachedAt, savedAt,
                       "Closing the chat must also release its pending save, not replay it after exit")
    }

    func testHistoryCacheDoesNotRestoreAnIdentityResetWhileScrolling() async throws {
        let (viewModel, context, server) = try await makePagedHistoryCacheFixture()
        viewModel.handleTranscriptScroll(.userScrollBegin)
        _ = await viewModel.loadOlderMessages(modelContext: context)
        ServerCacheGeneration.advance(for: server)
        try CacheStore.clearCache(for: server, in: context)
        viewModel.handleTranscriptScroll(.userScrollEnd(isAtBottom: false))
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context), [])
    }

    func testHistoryCacheResetReleasesDeferralForTheNextSnapshot() async throws {
        let (viewModel, context, server) = try await makePagedHistoryCacheFixture()
        viewModel.handleTranscriptScroll(.userScrollBegin)
        _ = await viewModel.loadOlderMessages(modelContext: context)
        viewModel.handleTranscriptScroll(.reset)
        _ = await viewModel.loadOlderMessages(modelContext: context)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context).count, 150)
    }

    func testHistoryCacheDoesNotDeferAnAuthoritativeEmptySnapshot() async throws {
        let (viewModel, context, server) = try await makePagedHistoryCacheFixture()
        viewModel.handleTranscriptScroll(.userScrollBegin)
        _ = await viewModel.loadOlderMessages(modelContext: context)
        viewModel.clearTranscript()
        viewModel.cacheCompletedResponse(modelContext: context)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context), [])
    }

    private func makePagedHistoryCacheFixture() async throws -> (ChatViewModel, ModelContext, URL) {
        let context = try makeContext()
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            let params = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
            let end = params.first(where: { $0.name == "msg_before" })?.value.flatMap(Int.init) ?? 150
            let start = max(0, end - 50)
            let messages = (start..<end).map { ["role": "user", "content": "History row \($0).", "message_id": "history-\($0)"] }
            let data = try JSONSerialization.data(withJSONObject: ["session": ["session_id": "session-abc", "messages": messages,
                "_messages_offset": start, "_messages_truncated": start > 0]])
            return apiTestJSONResponse(String(decoding: data, as: UTF8.self), for: request)
        }
        await viewModel.loadMessages(modelContext: context)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context).count, 50)
        return (viewModel, context, server)
    }

    func testLeavingAChatMidRunSavesThePartialAnswerForTheNextOpen() async throws {
        let context = try makeContext()
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
        }
        let didStart = await viewModel.sendMessage("Plan the launch")
        XCTAssertTrue(didStart)
        streamClient.emit(.token("Step one: "), lastEventID: "stream-123:1")
        streamClient.emit(.token("draft the brief."), lastEventID: "stream-123:2")

        viewModel.persistTranscript(modelContext: context)

        let cached = try CacheStore.cachedMessages(
            serverURL: try XCTUnwrap(URL(string: "https://example.test")),
            sessionID: "session-abc",
            in: context
        )
        XCTAssertEqual(cached.compactMap(\.content), ["Plan the launch", "Step one: draft the brief."])
    }

    func testPersistingAnEmptyTranscriptKeepsTheSavedOne() async throws {
        let context = try makeContext()
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheMessages(
            [ChatMessage(role: "user", content: "Saved", timestamp: 1, messageId: "saved")],
            serverURL: server,
            sessionID: "session-abc",
            in: context
        )
        let viewModel = try makeViewModel { request in
            XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        viewModel.persistTranscript(modelContext: context)

        XCTAssertEqual(
            try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context).compactMap(\.content),
            ["Saved"]
        )
    }

    func testAChatClosingAfterASignInSwitchNeverRestoresThePreviousIdentitysTranscript() async throws {
        let context = try makeContext()
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
        }
        _ = await viewModel.sendMessage("Private to the previous profile")
        // A sign-in as another profile clears the server's caches before the old screens close.
        ServerCacheGeneration.advance(for: server)

        viewModel.persistTranscript(modelContext: context)

        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context), [])
    }

    // TAL-183: the departing chat's onDisappear runs after the sign-out reset.
    func testAChatSuspendedAfterASignOutSavesNoActiveStreamSnapshot() async throws {
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            apiTestJSONResponse(#"{"session_id": "session-abc", "stream_id": "stream-123"}"#, for: request)
        }
        _ = await viewModel.sendMessage("Private to the signed-out person")
        streamClient.emit(.token("Partial answer."), lastEventID: "stream-123:1")
        ServerCacheGeneration.advance(for: server)

        viewModel.suspendStreamForNavigation()

        XCTAssertNil(ActiveChatStreamSnapshotStore.shared.snapshot(
            server: server,
            sessionID: "session-abc",
            streamID: "stream-123"
        ))
    }

    func testRemovingOneServersActiveStreamSnapshotsKeepsTheOtherServers() throws {
        let removed = try XCTUnwrap(URL(string: "https://removed.test"))
        let kept = try XCTUnwrap(URL(string: "https://kept.test"))
        let store = ActiveChatStreamSnapshotStore.shared
        for server in [removed, kept] {
            store.save(.synthetic, server: server, sessionID: "session-abc", streamID: "stream-1")
            store.save(.synthetic, server: server, sessionID: "session-def", streamID: "stream-2")
        }

        store.removeAll(for: removed)

        XCTAssertNil(store.snapshot(server: removed, sessionID: "session-abc", streamID: "stream-1"))
        XCTAssertNil(store.snapshot(server: removed, sessionID: "session-def", streamID: "stream-2"))
        XCTAssertEqual(store.snapshot(server: kept, sessionID: "session-abc", streamID: "stream-1"), .synthetic)
        XCTAssertEqual(store.snapshot(server: kept, sessionID: "session-def", streamID: "stream-2"), .synthetic)
    }

    func testAResponseArrivingAfterAResetIsNotCached() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let cache = ResponseCache(server: server, root: root)

        ServerCacheGeneration.advance(for: server)
        cache.entry(ResponseCache.Kind.projects).save(Data(#"{"projects": [{"project_id": "old"}]}"#.utf8))

        XCTAssertNil(ResponseCache(server: server, root: root).entry(ResponseCache.Kind.projects).load(ProjectsResponse.self))
    }
}

extension ActiveChatStreamSnapshot {
    static let synthetic = ActiveChatStreamSnapshot(
        messages: [ChatMessage(role: "user", content: "hello", timestamp: 1, messageId: "m1")],
        messagesOffset: 0,
        displayTitle: "Thread",
        completedToolCallGroups: [],
        completedReasoningGroups: [],
        liveAssistantActivity: AssistantActivityTimeline(),
        activeStreamLastEventID: nil,
        streamingAssistantMessageID: nil,
        toolCallAnchorMessageID: nil,
        reasoningAnchorMessageID: nil,
        contextWindowSnapshot: nil,
        localAttachmentPreviews: [:]
    )
}
