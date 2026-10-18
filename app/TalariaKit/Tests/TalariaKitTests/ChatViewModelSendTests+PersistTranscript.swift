import SwiftData
import XCTest
@testable import TalariaKit

private let refreshedHistoryTail = "Updated recent response."

// TAL-437: a chat left mid-run, or an app backgrounded mid-run, reopens on its partial answer.
@MainActor
extension ChatViewModelSendTests {
    func testHistoryCacheCoalescesPagesUntilScrollingSettles() async throws {
        let (viewModel, context, server) = try await makePagedHistoryCacheFixture(refreshesRecentTail: true)
        viewModel.handleTranscriptScroll(.userScrollBegin)
        let first = await viewModel.loadOlderMessages(modelContext: context)
        XCTAssertTrue(first)
        XCTAssertEqual(viewModel.messages.count, 100)
        let second = await viewModel.loadOlderMessages(modelContext: context)
        XCTAssertTrue(second)
        XCTAssertEqual(viewModel.messages.count, 150)
        await viewModel.loadMessages(modelContext: context)
        XCTAssertEqual(viewModel.messages.last?.content, refreshedHistoryTail)
        let duringGesture = try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context)
        XCTAssertEqual(duringGesture.map(\.messageId), (100..<150).map { "history-\($0)" })
        XCTAssertEqual(duringGesture.last?.content, "History row 149.",
                       "Even a changed recent response must not rewrite the offline cache during a gesture")
        viewModel.handleTranscriptScroll(.userScrollEnd(isAtBottom: false))
        let cached = try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context)
        XCTAssertEqual(cached.map(\.messageId), (100..<150).map { "history-\($0)" })
        XCTAssertEqual(cached.last?.content, refreshedHistoryTail,
                       "Settling must flush the latest recent window without caching the older pages")
    }

    func testHistoryCachePersistsOnExitBeforeTheGestureSettles() async throws {
        let (viewModel, context, server) = try await makePagedHistoryCacheFixture(refreshesRecentTail: true)
        viewModel.handleTranscriptScroll(.userScrollBegin)
        let loaded = await viewModel.loadOlderMessages(modelContext: context)
        XCTAssertTrue(loaded)
        await viewModel.loadMessages(modelContext: context)
        XCTAssertEqual(viewModel.messages.last?.content, refreshedHistoryTail)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context).last?.content,
                       "History row 149.")
        viewModel.persistTranscript(modelContext: context)
        let cached = try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context)
        XCTAssertEqual(cached.map(\.messageId), (100..<150).map { "history-\($0)" })
        XCTAssertEqual(cached.last?.content, refreshedHistoryTail)
        let savedAt = try XCTUnwrap(context.fetch(FetchDescriptor<CachedMessage>()).first).cachedAt
        viewModel.handleTranscriptScroll(.userScrollEnd(isAtBottom: false))
        XCTAssertEqual(try XCTUnwrap(context.fetch(FetchDescriptor<CachedMessage>()).first).cachedAt, savedAt,
                       "Closing the chat must release its pending save, not replay it after exit")
        let newer = ChatMessage(role: "assistant", content: "Newer cached snapshot.", timestamp: nil, messageId: "newer-cache")
        try CacheStore.cacheMessages([newer], serverURL: server, sessionID: "session-abc", in: context)
        viewModel.handleTranscriptScroll(.userScrollEnd(isAtBottom: false))
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context).map(\.messageId),
                       ["newer-cache"], "A late scroll end after exit must not replace a newer cache snapshot")
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
        let (viewModel, context, server) = try await makePagedHistoryCacheFixture(refreshesRecentTail: true)
        viewModel.handleTranscriptScroll(.userScrollBegin)
        _ = await viewModel.loadOlderMessages(modelContext: context)
        await viewModel.loadMessages(modelContext: context)
        XCTAssertEqual(viewModel.messages.last?.content, refreshedHistoryTail)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context).last?.content,
                       "History row 149.")
        viewModel.handleTranscriptScroll(.reset)
        _ = await viewModel.loadOlderMessages(modelContext: context)
        let cached = try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context)
        XCTAssertEqual(cached.map(\.messageId), (100..<150).map { "history-\($0)" })
        XCTAssertEqual(cached.last?.content, refreshedHistoryTail)
    }

    func testHistoryCacheDoesNotDeferAnAuthoritativeEmptySnapshot() async throws {
        let (viewModel, context, server) = try await makePagedHistoryCacheFixture()
        viewModel.handleTranscriptScroll(.userScrollBegin)
        _ = await viewModel.loadOlderMessages(modelContext: context)
        viewModel.clearTranscript()
        viewModel.cacheCompletedResponse(modelContext: context)
        XCTAssertEqual(try CacheStore.cachedMessages(serverURL: server, sessionID: "session-abc", in: context), [])
    }

    private func makePagedHistoryCacheFixture(refreshesRecentTail: Bool = false) async throws -> (ChatViewModel, ModelContext, URL) {
        let context = try makeContext()
        let server = try XCTUnwrap(URL(string: "https://example.test"))
        let recentReads = LockedCounter()
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            let params = URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems ?? []
            let before = params.first(where: { $0.name == "msg_before" })?.value
            let end = before.flatMap(Int.init) ?? 150
            let changesTail = refreshesRecentTail && before == nil && recentReads.increment() > 1
            let start = max(0, end - 50)
            let messages = (start..<end).map { index in
                ["role": "user", "content": changesTail && index == 149 ? refreshedHistoryTail : "History row \(index).",
                 "message_id": "history-\(index)"]
            }
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

    func testTranscriptReplacementsRefreshTheCachedRecentWindow() async throws {
        for mutation in ["compress", "edit", "regenerate", "retry"] {
            let context = try makeContext()
            let initial = try Self.toolHeavyRecentSessionJSON()
            let replacement = #"{"session":{"session_id":"session-abc","_messages_offset":0,"_messages_truncated":false,"messages":[{"role":"user","content":"Kept prompt","message_id":"kept-user","_display":"row"},{"role":"assistant","content":"Replacement answer","message_id":"kept-answer","_display":"row"}]}}"#
            let reads = LockedCounter()
            let model = try makeViewModel { request in
                switch request.url?.path {
                case "/api/session":
                    return apiTestJSONResponse(reads.increment() == 1 ? initial : replacement, for: request)
                case "/api/session/compress/start":
                    return apiTestJSONResponse(replacement.replacingOccurrences(of: #"{"session":"#, with: #"{"ok":true,"status":"done","session":"#), for: request)
                case "/api/session/truncate":
                    return apiTestJSONResponse(replacement, for: request)
                case "/api/session/retry":
                    return apiTestJSONResponse(#"{"ok":true,"last_user_text":"Retry the prompt"}"#, for: request)
                case "/api/chat/start":
                    return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-replacement"}"#, for: request)
                default:
                    XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
                    throw URLError(.badURL)
                }
            }
            await model.loadMessages(modelContext: context)
            XCTAssertEqual(model.messagesOffset, 200)
            switch mutation {
            case "compress", "retry":
                _ = await model.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: mutation)))
            case "edit":
                let action = try XCTUnwrap(model.actionContext(for: model.messages[96], visibleIndex: 96))
                let sent = await model.editMessage(action, newText: "Edited prompt", confirmToken: "confirmed", modelContext: context)
                XCTAssertTrue(sent)
            default:
                let action = try XCTUnwrap(model.actionContext(for: model.messages[99], visibleIndex: 99))
                let sent = await model.regenerateAssistantResponse(action, confirmToken: "confirmed", modelContext: context)
                XCTAssertTrue(sent)
            }
            XCTAssertEqual(model.messagesOffset, 0, mutation)
            XCTAssertEqual(model.messages.first?.content, "Kept prompt", mutation)
            model.persistTranscript(modelContext: context)
            let cached = try CacheStore.cachedTranscriptWindow(serverURL: URL(string: "https://example.test")!, sessionID: "session-abc", in: context)
            XCTAssertEqual(cached.messages, model.messages, "\(mutation) must not slice the replacement using the old offset")
            XCTAssertEqual(cached.messagesOffset, 0, mutation)
            XCTAssertFalse(cached.hasOlderMessages, mutation)
            ChatViewModel.resetActiveStreamSnapshotsForTesting()
            let reopened = try makeViewModel { apiTestJSONResponse(replacement, for: $0) }
            reopened.prepareInitialMessageLoad(modelContext: context)
            XCTAssertEqual(reopened.messages, model.messages, mutation)
            XCTAssertEqual(reopened.messagesOffset, 0, mutation)
        }
    }

    func testRejectedCacheFirstPlaceholderClearsItsRecentWindowBoundary() async throws {
        let context = try makeContext()
        let initial = try Self.toolHeavyRecentSessionJSON()
        let first = try makeViewModel { apiTestJSONResponse(initial, for: $0) }
        await first.loadMessages(modelContext: context)
        let reopened = try makeViewModel { request in
            if request.url?.path == "/api/session" {
                let response = HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!
                return (response, Data(#"{"error":"Synthetic rejected load"}"#.utf8))
            }
            return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-after-rejection"}"#, for: request)
        }
        await reopened.loadMessages(modelContext: context)
        XCTAssertTrue(reopened.messages.isEmpty)
        XCTAssertNotNil(reopened.errorMessage)
        let sent = await reopened.sendMessage("New prompt after the rejected load", modelContext: context)
        XCTAssertTrue(sent)
        let cached = try CacheStore.cachedTranscriptWindow(serverURL: URL(string: "https://example.test")!, sessionID: "session-abc", in: context)
        XCTAssertEqual(cached.messages.compactMap(\.content), ["New prompt after the rejected load"])
        XCTAssertNil(cached.recentMessagesOffset, "A rejected placeholder cannot certify a recent server window")
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
