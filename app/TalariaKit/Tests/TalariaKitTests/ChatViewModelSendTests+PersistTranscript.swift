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

    func testRecentWindowSurvivesDiskRelaunchWithoutAnActiveStreamSnapshot() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let configuration = ModelConfiguration(url: root.appendingPathComponent("cache.store"), cloudKitDatabase: .none)
        let body = try Self.toolHeavyRecentSessionJSON()
        func saveFirstProcess() async throws -> [ChatMessage] {
            let container = try ModelContainer(for: CachedSession.self, CachedMessage.self, configurations: configuration)
            let context = ModelContext(container)
            let first = try makeViewModel { apiTestJSONResponse(body, for: $0) }
            await first.loadMessages(modelContext: context)
            first.persistTranscript(modelContext: context)
            return first.messages
        }
        let expected = try await saveFirstProcess()
        ChatViewModel.resetActiveStreamSnapshotsForTesting()
        let container = try ModelContainer(for: CachedSession.self, CachedMessage.self, configurations: configuration)
        let context = ModelContext(container)
        let reopened = try makeViewModel { request in
            throw URLError(.notConnectedToInternet)
        }
        reopened.prepareInitialMessageLoad(modelContext: context)
        XCTAssertEqual(reopened.messages, expected)
        XCTAssertEqual(reopened.messagesOffset, 200)
        XCTAssertTrue(reopened.hasOlderMessages)
        XCTAssertEqual(reopened.displayedTranscriptMessages.first?.renderID, "transcript:200")
        XCTAssertEqual(reopened.displayedTranscriptMessages.last?.renderID, "transcript:299")
        XCTAssertNotNil(reopened.messages.last?.activityScene)

        await reopened.loadMessages(modelContext: context)
        XCTAssertTrue(reopened.isViewingCachedData)
        XCTAssertEqual(reopened.messages, expected, "Offline fallback must use the same complete window")
        XCTAssertEqual(reopened.messagesOffset, 200)
        XCTAssertTrue(reopened.hasOlderMessages)
    }

    func testOlderPagesDoNotEnlargeTheRecentWindowOnReopen() async throws {
        let context = try makeContext()
        let recent = try Self.toolHeavyRecentSessionJSON()
        let viewModel = try makeViewModel { request in
            let before = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "msg_before" }
            if before != nil {
                return apiTestJSONResponse("""
                {"session":{"session_id":"session-abc","_messages_offset":198,"_messages_truncated":true,"messages":[
                  {"role":"user","content":"Older question","message_id":"older-question","_display":"row"},
                  {"role":"assistant","content":"Older answer","message_id":"older-answer","_display":"row"}
                ]}}
                """, for: request)
            }
            return apiTestJSONResponse(recent, for: request)
        }
        await viewModel.loadMessages(modelContext: context)
        let expected = viewModel.messages
        let expectedIDs = viewModel.displayedTranscriptMessages.map(\.renderID)
        let loadedOlder = await viewModel.loadOlderMessages(modelContext: context)
        XCTAssertTrue(loadedOlder)
        XCTAssertEqual(viewModel.messages.count, 102)
        XCTAssertEqual(viewModel.messagesOffset, 198)
        viewModel.persistTranscript(modelContext: context)
        let reopened = try makeViewModel { apiTestJSONResponse(recent, for: $0) }
        reopened.prepareInitialMessageLoad(modelContext: context)
        XCTAssertEqual(reopened.messages, expected)
        XCTAssertEqual(reopened.messagesOffset, 200)
        XCTAssertEqual(reopened.displayedTranscriptMessages.map(\.renderID), expectedIDs)
    }

    func testRecentWindowRetainsNewerPartialAnswerDuringHeldUpdatedReload() async throws {
        let context = try makeContext()
        let stream = SpySSEStreamingClient()
        let body = try Self.toolHeavyRecentSessionJSON(activeStreamID: "stream-recent")
        let first = try makeViewModel(streamClient: stream) { request in
            if request.url?.path == "/api/chat/stream/status" {
                return apiTestJSONResponse(#"{"active":true,"stream_id":"stream-recent"}"#, for: request)
            }
            return apiTestJSONResponse(body, for: request)
        }
        await first.loadMessages(modelContext: context)
        await first.reconnectStreamIfNeeded(modelContext: context)
        XCTAssertEqual(stream.startedURLs.count, 1)
        stream.emit(.token(" A newer partial answer."), lastEventID: "stream-recent:1")
        first.persistTranscript(modelContext: context)
        let expected = first.messages
        XCTAssertTrue(expected.last?.content?.hasSuffix(" A newer partial answer.") == true)
        first.suspendStreamForNavigation()

        let arrived = expectation(description: "updated detail held")
        let release = DispatchSemaphore(value: 0)
        let reopenedStream = SpySSEStreamingClient()
        let reopened = try makeViewModel(streamClient: reopenedStream) { request in
            arrived.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + .seconds(10)), .success)
            return apiTestJSONResponse(body.replacingOccurrences(of: "Cached work 24", with: "Updated cached work 24"), for: request)
        }
        reopened.prepareInitialMessageLoad(modelContext: context)
        XCTAssertEqual(reopened.messages, expected)
        let load = Task { await reopened.loadMessages(modelContext: context) }
        defer { release.signal() }
        await fulfillment(of: [arrived], timeout: 5)
        release.signal()
        await load.value
        XCTAssertEqual(reopened.messages.last?.content, expected.last?.content)
        XCTAssertEqual(reopened.messages.last?.activityScene?.activityRows?.first?.text, "Updated cached work 24")
        XCTAssertEqual(reopened.messages.count, expected.count)
        XCTAssertEqual(Set(reopened.messages.map(\.id)).count, expected.count)
        XCTAssertEqual(reopened.messagesOffset, 200)
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
