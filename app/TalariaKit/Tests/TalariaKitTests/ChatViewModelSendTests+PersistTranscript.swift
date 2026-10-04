import SwiftData
import XCTest
@testable import TalariaKit

// TAL-437: a chat left mid-run, or an app backgrounded mid-run, reopens on its partial answer.
@MainActor
extension ChatViewModelSendTests {
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
        localAttachmentPreviews: [:],
        pinnedLocalNotices: []
    )
}
