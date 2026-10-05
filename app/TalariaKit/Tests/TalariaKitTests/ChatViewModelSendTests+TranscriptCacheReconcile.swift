import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UniformTypeIdentifiers
@testable import TalariaKit

@MainActor
extension ChatViewModelSendTests {
    func testReloadPreservesCachedOptimisticUserMessageWhenServerTemporarilyOmitsIt() async throws {
        let context = try makeContext()
        let streamClient = SpySSEStreamingClient()
        let sendingViewModel = try makeViewModel(streamClient: streamClient) { request in
            XCTAssertEqual(request.url?.path, "/api/chat/start")
            return apiTestJSONResponse("""
            {
              "session_id": "session-abc",
              "stream_id": "stream-123"
            }
            """, for: request)
        }

        let didStart = await sendingViewModel.sendMessage("Keep working", modelContext: context)

        XCTAssertTrue(didStart)
        XCTAssertEqual(sendingViewModel.messages.compactMap(\.content), ["Keep working"])
        XCTAssertEqual(
            try CacheStore.cachedMessages(
                serverURL: URL(string: "https://example.test")!,
                sessionID: "session-abc",
                in: context
            ).compactMap(\.content),
            ["Keep working"]
        )

        let reopenedViewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "title": "Planning",
                "messages": [
                  {
                    "role": "assistant",
                    "content": "Recovered transcript.",
                    "timestamp": 1770000100,
                    "message_id": "assistant-1"
                  }
                ]
              }
            }
            """, for: request)
        }

        await reopenedViewModel.loadMessages(modelContext: context)

        XCTAssertEqual(reopenedViewModel.messages.compactMap(\.role), ["user", "assistant"])
        XCTAssertEqual(reopenedViewModel.messages.compactMap(\.content), ["Keep working", "Recovered transcript."])
        XCTAssertEqual(
            try CacheStore.cachedMessages(
                serverURL: URL(string: "https://example.test")!,
                sessionID: "session-abc",
                in: context
            ).compactMap(\.content),
            ["Keep working", "Recovered transcript."]
        )
    }

    @MainActor
    func testLoadMessagesUsesCachedTranscriptForTunnelUnavailableFailure() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        let otherServerURL = try XCTUnwrap(URL(string: "https://other.example.test"))
        let streamClient = SpySSEStreamingClient()
        try CacheStore.cacheMessages(
            [
                ChatMessage(role: "user", content: "Cached question", timestamp: 1_770_000_001, messageId: "cached-user"),
                ChatMessage(role: "assistant", content: "Cached answer", timestamp: 1_770_000_002, messageId: "cached-assistant")
            ],
            serverURL: serverURL,
            sessionID: "session-abc",
            in: context
        )
        try CacheStore.cacheMessages(
            [
                ChatMessage(role: "assistant", content: "Wrong session", timestamp: 1_770_000_003, messageId: "wrong-session")
            ],
            serverURL: serverURL,
            sessionID: "other-session",
            in: context
        )
        try CacheStore.cacheMessages(
            [
                ChatMessage(role: "assistant", content: "Wrong server", timestamp: 1_770_000_004, messageId: "wrong-server")
            ],
            serverURL: otherServerURL,
            sessionID: "session-abc",
            in: context
        )

        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            switch request.url?.path {
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            case "/api/session":
                let response = HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 502,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "text/html"]
                )
                return (try XCTUnwrap(response), Data("bad gateway".utf8))
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let didStart = await viewModel.sendMessage("In-flight request")
        streamClient.emit(.token("Partial response"))

        XCTAssertTrue(didStart)
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertNotNil(viewModel.streamingAssistantMessageID)

        await viewModel.loadMessages(modelContext: context)
        let didSend = await viewModel.sendMessage("New message", modelContext: context)

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Cached question", "Cached answer"])
        XCTAssertEqual(viewModel.messagesOffset, 0)
        XCTAssertTrue(viewModel.isViewingCachedData)
        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertNil(viewModel.streamingAssistantMessageID)
        XCTAssertNil(viewModel.contextWindowSnapshot)
        XCTAssertTrue(viewModel.completedToolCallGroups.isEmpty)
        XCTAssertTrue(viewModel.completedToolCallGroupsForAnchor("cached-assistant").isEmpty)
        XCTAssertTrue(viewModel.completedToolCallGroupsForAnchor(nil).isEmpty)
        XCTAssertTrue(viewModel.completedReasoningGroups.isEmpty)
        XCTAssertTrue(viewModel.liveToolCalls.isEmpty)
        XCTAssertTrue(viewModel.liveReasoningText.isEmpty)
        XCTAssertTrue(viewModel.pinnedLocalNotices.isEmpty)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.lastError)
        XCTAssertFalse(didSend)
        XCTAssertEqual(viewModel.sendErrorMessage, "Reconnect to the server to send a message.")
    }

    @MainActor
    func testLoadMessagesUsesCachedTranscriptForNetworkTimeout() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheMessages(
            [
                ChatMessage(role: "user", content: "Cached question", timestamp: 1_770_000_001, messageId: "cached-user"),
                ChatMessage(role: "assistant", content: "Cached answer", timestamp: 1_770_000_002, messageId: "cached-assistant")
            ],
            serverURL: serverURL,
            sessionID: "session-abc",
            in: context
        )

        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            throw URLError(.timedOut)
        }

        await viewModel.loadMessages(modelContext: context)

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Cached question", "Cached answer"])
        XCTAssertTrue(viewModel.isViewingCachedData)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.lastError)
    }

    @MainActor
    func testLoadMessagesSurfacesTunnelUnavailableFailureWhenCacheIsEmpty() async throws {
        let context = try makeContext()
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 502,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/html"]
            )
            return (try XCTUnwrap(response), Data("bad gateway".utf8))
        }

        await viewModel.loadMessages(modelContext: context)

        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertFalse(viewModel.isViewingCachedData)
        XCTAssertEqual(
            viewModel.errorMessage,
            "The server or Cloudflare tunnel is unavailable. Check that the Mac is awake, hermes-webui is running, and the tunnel is connected."
        )
        XCTAssertNotNil(viewModel.lastError)
    }

    @MainActor
    func testLoadMessagesDoesNotUseCachedTranscriptForRealServerError() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheMessages(
            [
                ChatMessage(role: "assistant", content: "Stale cached answer", timestamp: 1_770_000_001, messageId: "stale")
            ],
            serverURL: serverURL,
            sessionID: "session-abc",
            in: context
        )
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 500,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )
            return (try XCTUnwrap(response), Data(#"{"error":"boom"}"#.utf8))
        }

        await viewModel.loadMessages(modelContext: context)

        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertFalse(viewModel.isViewingCachedData)
        XCTAssertEqual(viewModel.errorMessage, "The Hermes server hit an internal error. Check the server logs, then try again.")
        XCTAssertNotNil(viewModel.lastError)
    }

    @MainActor
    func testLoadMessagesDoesNotReplaceSuccessfulOnlineTranscriptWithStaleCache() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheMessages(
            [
                ChatMessage(role: "assistant", content: "Stale cached answer", timestamp: 1_770_000_001, messageId: "stale")
            ],
            serverURL: serverURL,
            sessionID: "session-abc",
            in: context
        )
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "title": "Fresh planning",
                "messages": [
                  {
                    "role": "user",
                    "content": "Fresh question",
                    "timestamp": 1770000100,
                    "message_id": "fresh-user"
                  },
                  {
                    "role": "assistant",
                    "content": "Fresh answer",
                    "timestamp": 1770000101,
                    "message_id": "fresh-assistant"
                  }
                ]
              }
            }
            """, for: request)
        }

        await viewModel.loadMessages(modelContext: context)

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Fresh question", "Fresh answer"])
        XCTAssertFalse(viewModel.isViewingCachedData)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertEqual(
            try CacheStore.cachedMessages(
                serverURL: serverURL,
                sessionID: "session-abc",
                in: context
            ).compactMap(\.content),
            ["Fresh question", "Fresh answer"]
        )
    }

    @MainActor
    func testLoadMessagesRendersCachedMessagesBeforeNetworkReconcile() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheMessages(
            [
                ChatMessage(role: "user", content: "Cached question", timestamp: 1_770_000_001, messageId: "cached-user"),
                ChatMessage(role: "assistant", content: "Cached answer", timestamp: 1_770_000_002, messageId: "cached-assistant")
            ],
            serverURL: serverURL,
            sessionID: "session-abc",
            in: context
        )

        let sessionRequestStarted = expectation(description: "session request started")
        let releaseSessionResponse = DispatchSemaphore(value: 0)
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            sessionRequestStarted.fulfill()
            XCTAssertEqual(releaseSessionResponse.wait(timeout: .now() + .seconds(5)), .success)
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "title": "Fresh planning",
                "messages": [
                  {
                    "role": "user",
                    "content": "Fresh question",
                    "timestamp": 1770000100,
                    "message_id": "fresh-user"
                  },
                  {
                    "role": "assistant",
                    "content": "Fresh answer",
                    "timestamp": 1770000101,
                    "message_id": "fresh-assistant"
                  }
                ]
              }
            }
            """, for: request)
        }

        let loadTask = Task { @MainActor in
            await viewModel.loadMessages(modelContext: context)
        }
        defer { releaseSessionResponse.signal() }

        // While the network reload is still in flight, the cached transcript is
        // already on screen (no skeleton, since messages is non-empty) and the
        // offline indicator stays off because this is the success-expected window.
        await fulfillment(of: [sessionRequestStarted], timeout: 10)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Cached question", "Cached answer"])
        XCTAssertTrue(viewModel.isLoading)
        XCTAssertFalse(viewModel.isViewingCachedData)

        releaseSessionResponse.signal()
        await loadTask.value

        // After the reload completes it reconciles in place to the fresh server content.
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Fresh question", "Fresh answer"])
        XCTAssertFalse(viewModel.isViewingCachedData)
        XCTAssertNil(viewModel.errorMessage)
    }

    @MainActor
    func testPrepareInitialMessageLoadPrimesCacheWithoutStartingNetwork() throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheMessages(
            [
                ChatMessage(role: "user", content: "Cached question", timestamp: 1_770_000_001, messageId: "cached-user"),
                ChatMessage(role: "assistant", content: "Cached answer", timestamp: 1_770_000_002, messageId: "cached-assistant")
            ],
            serverURL: serverURL,
            sessionID: "session-abc",
            in: context
        )

        let viewModel = try makeViewModel { request in
            XCTFail("Cache preparation must not start a request: \(request.url?.absoluteString ?? "nil")")
            throw URLError(.badURL)
        }

        viewModel.prepareInitialMessageLoad(modelContext: context)

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Cached question", "Cached answer"])
        XCTAssertTrue(viewModel.isLoading)
        XCTAssertFalse(viewModel.isViewingCachedData)
    }

    // TAL-250, TAL-436: a row without a run state (a deep link) is checked while its cached transcript shows; the
    // "Syncing messages" pill says so, so the transcript's own check chip stays hidden. A failed load keeps the
    // transcript and ends the sync without claiming the run finished.
    @MainActor
    func testUnknownRunStateSyncsUntilTheFirstLoadAnswersAndFailureKeepsTheTranscript() async throws {
        let context = try makeContext()
        try cacheQuestionAndAnswer(in: context)
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 500,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )
            return (try XCTUnwrap(response), Data(#"{"error":"boom"}"#.utf8))
        }

        viewModel.prepareInitialMessageLoad(modelContext: context)
        XCTAssertTrue(viewModel.isSyncingTranscript)
        XCTAssertFalse(viewModel.showsRunStateCheck, "The syncing pill already says the server is being checked.")

        await viewModel.loadMessages(modelContext: context)

        XCTAssertFalse(viewModel.isSyncingTranscript)
        XCTAssertFalse(viewModel.showsRunStateCheck)
        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Cached question", "Cached answer"])
        XCTAssertNotNil(viewModel.errorMessage)
    }

    // TAL-250: an idle row paints without the check; when its detail reveals a run, the server's run is adopted.
    @MainActor
    func testStaleIdleRowAdoptsTheRunItsDetailReveals() async throws {
        let context = try makeContext()
        try cacheQuestionAndAnswer(in: context)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let idleRow = try decoder.decode(SessionSummary.self, from: Data(#"""
        {"session_id":"session-abc","title":"Planning","is_streaming":false}
        """#.utf8))
        let viewModel = try makeViewModel(sessionSummary: idleRow) { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return apiTestJSONResponse("""
            {"session": {"session_id": "session-abc", "title": "Planning", "active_stream_id": "stream-other-client",
              "messages": [
                {"role": "user", "content": "Cached question", "timestamp": 1770000001, "message_id": "cached-user"},
                {"role": "assistant", "content": "Cached answer", "timestamp": 1770000002, "message_id": "cached-assistant"},
                {"role": "user", "content": "Started elsewhere", "timestamp": 1770000100, "message_id": "user-2"}
              ]}}
            """, for: request)
        }

        viewModel.prepareInitialMessageLoad(modelContext: context)
        XCTAssertFalse(viewModel.showsRunStateCheck)

        await viewModel.loadMessages(modelContext: context)

        XCTAssertEqual(viewModel.activeStreamID, "stream-other-client")
        XCTAssertFalse(viewModel.showsRunStateCheck)
        XCTAssertEqual(viewModel.messages.last?.content, "Started elsewhere")
    }

    @MainActor
    private func cacheQuestionAndAnswer(in context: ModelContext) throws {
        try CacheStore.cacheMessages(
            [
                ChatMessage(role: "user", content: "Cached question", timestamp: 1_770_000_001, messageId: "cached-user"),
                ChatMessage(role: "assistant", content: "Cached answer", timestamp: 1_770_000_002, messageId: "cached-assistant")
            ],
            serverURL: try XCTUnwrap(URL(string: "https://example.test")),
            sessionID: "session-abc",
            in: context
        )
    }

    @MainActor
    func testPrepareInitialMessageLoadBoundsLargeCachedTranscriptToNewestPage() throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        let cachedMessages = (0..<75).map { index in
            ChatMessage(
                role: index.isMultiple(of: 2) ? "user" : "assistant",
                content: "Cached message \(index)",
                timestamp: Double(1_770_000_000 + index),
                messageId: "cached-\(index)"
            )
        }
        try CacheStore.cacheMessages(
            cachedMessages,
            serverURL: serverURL,
            sessionID: "session-abc",
            in: context
        )

        let viewModel = try makeViewModel { request in
            XCTFail("Cache preparation must not start a request: \(request.url?.absoluteString ?? "nil")")
            throw URLError(.badURL)
        }

        viewModel.prepareInitialMessageLoad(modelContext: context)

        XCTAssertEqual(viewModel.messages.count, 50)
        XCTAssertEqual(viewModel.messages.first?.content, "Cached message 25")
        XCTAssertEqual(viewModel.messages.last?.content, "Cached message 74")
        XCTAssertTrue(viewModel.isLoading)
        XCTAssertFalse(viewModel.isViewingCachedData)
    }

    @MainActor
    func testLoadMessagesKeepsTranscriptEmptyDuringNetworkWhenCacheIsEmpty() async throws {
        let context = try makeContext()

        let sessionRequestStarted = expectation(description: "session request started")
        let releaseSessionResponse = DispatchSemaphore(value: 0)
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            sessionRequestStarted.fulfill()
            XCTAssertEqual(releaseSessionResponse.wait(timeout: .now() + .seconds(5)), .success)
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "title": "Fresh planning",
                "messages": [
                  {
                    "role": "user",
                    "content": "Fresh question",
                    "timestamp": 1770000100,
                    "message_id": "fresh-user"
                  }
                ]
              }
            }
            """, for: request)
        }

        let loadTask = Task { @MainActor in
            await viewModel.loadMessages(modelContext: context)
        }
        defer { releaseSessionResponse.signal() }

        // With no cache, nothing is painted before the network resolves, so the
        // first-open skeleton path (isLoading && messages.isEmpty) is preserved.
        await fulfillment(of: [sessionRequestStarted], timeout: 10)
        XCTAssertTrue(viewModel.messages.isEmpty)
        XCTAssertTrue(viewModel.isLoading)

        releaseSessionResponse.signal()
        await loadTask.value

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Fresh question"])
    }

    @MainActor
    func testCacheFirstReconcileBumpsScrollTokenForSmoothSettle() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheMessages(
            [
                ChatMessage(role: "user", content: "Cached question", timestamp: 1_770_000_001, messageId: "cached-user"),
                ChatMessage(role: "assistant", content: "Cached answer", timestamp: 1_770_000_002, messageId: "cached-assistant")
            ],
            serverURL: serverURL,
            sessionID: "session-abc",
            in: context
        )

        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "title": "Fresh planning",
                "messages": [
                  {
                    "role": "user",
                    "content": "Fresh question",
                    "timestamp": 1770000100,
                    "message_id": "fresh-user"
                  },
                  {
                    "role": "assistant",
                    "content": "Fresh answer",
                    "timestamp": 1770000101,
                    "message_id": "fresh-assistant"
                  }
                ]
              }
            }
            """, for: request)
        }

        XCTAssertEqual(viewModel.cacheFirstReconcileScrollToken, 0)
        await viewModel.loadMessages(modelContext: context)

        // The cache-first reconcile fired exactly once so the view can snap back to the
        // bottom as the taller server transcript replaces the lighter cached render.
        XCTAssertEqual(viewModel.cacheFirstReconcileScrollToken, 1)
    }

    @MainActor
    func testColdOpenWithoutCacheDoesNotBumpReconcileScrollToken() async throws {
        let context = try makeContext()
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "title": "Fresh planning",
                "messages": [
                  {
                    "role": "user",
                    "content": "Fresh question",
                    "timestamp": 1770000100,
                    "message_id": "fresh-user"
                  }
                ]
              }
            }
            """, for: request)
        }

        await viewModel.loadMessages(modelContext: context)

        // No cache was rendered first, so there is nothing to re-pin and the token stays put.
        XCTAssertEqual(viewModel.cacheFirstReconcileScrollToken, 0)
    }

    @MainActor
    func testCacheFirstRevertPreservesOptimisticSendOnNonCacheableError() async throws {
        let context = try makeContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheMessages(
            [
                ChatMessage(role: "user", content: "Cached question", timestamp: 1_770_000_001, messageId: "cached-user"),
                ChatMessage(role: "assistant", content: "Cached answer", timestamp: 1_770_000_002, messageId: "cached-assistant")
            ],
            serverURL: serverURL,
            sessionID: "session-abc",
            in: context
        )

        let sessionRequestStarted = expectation(description: "session request started")
        let releaseSessionResponse = DispatchSemaphore(value: 0)
        let viewModel = try makeViewModel { request in
            switch request.url?.path {
            case "/api/session":
                sessionRequestStarted.fulfill()
                XCTAssertEqual(releaseSessionResponse.wait(timeout: .now() + .seconds(5)), .success)
                let response = HTTPURLResponse(
                    url: try XCTUnwrap(request.url),
                    statusCode: 500,
                    httpVersion: nil,
                    headerFields: ["Content-Type": "application/json"]
                )
                return (try XCTUnwrap(response), Data(#"{"error":"boom"}"#.utf8))
            case "/api/chat/start":
                return apiTestJSONResponse("""
                {
                  "session_id": "session-abc",
                  "stream_id": "stream-123"
                }
                """, for: request)
            default:
                XCTFail("Unexpected request path: \(request.url?.path ?? "nil")")
                throw URLError(.badURL)
            }
        }

        let loadTask = Task { @MainActor in
            await viewModel.loadMessages(modelContext: context)
        }
        defer { releaseSessionResponse.signal() }

        // The reload renders the cache then suspends on /api/session. Kick off a send
        // *without* awaiting it (its optimistic user message is appended synchronously
        // before the network call) so the transcript is mutated while the reload is
        // still in flight.
        await fulfillment(of: [sessionRequestStarted], timeout: 10)
        let sendTask = Task { @MainActor in
            await viewModel.sendMessage("In-flight question", modelContext: context)
        }
        try await waitUntil { viewModel.messages.compactMap(\.content).contains("In-flight question") }
        XCTAssertTrue(viewModel.messages.compactMap(\.content).contains("In-flight question"))

        // Now let the reload fail with a non-cacheable error: the cache-first revert
        // must NOT wipe the optimistic send made during the load window (#289, Codex P2).
        releaseSessionResponse.signal()
        await loadTask.value
        _ = await sendTask.value

        XCTAssertTrue(
            viewModel.messages.compactMap(\.content).contains("In-flight question"),
            "Optimistic send made during the cache-first window must survive a non-cacheable reload failure"
        )
    }

    @MainActor
    func testSuccessfulReloadDoesNotReplaceResponseStartedWhileRequestIsInFlight() async throws {
        let requests = DeferredRequests()
        let host = "tal116-stream-first.test"
        let sessionRequestStarted = expectation(description: "session request started")
        let chatStartRequestStarted = expectation(description: "chat start request started")
        DeferredMockURLProtocol.setOnRequest({ request in
            _ = requests.append(request)
            switch request.request.url?.path {
            case "/api/session": sessionRequestStarted.fulfill()
            case "/api/chat/start": chatStartRequestStarted.fulfill()
            default: XCTFail("Unexpected request path: \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        let loadTask = Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [sessionRequestStarted], timeout: 10)

        let sendTask = Task { @MainActor in
            await viewModel.sendMessage("In-flight question")
        }
        await fulfillment(of: [chatStartRequestStarted], timeout: 10)
        requests.request(at: 1).complete(withJSON: """
        {
          "session_id": "session-abc",
          "stream_id": "stream-123"
        }
        """)
        let didStart = await sendTask.value
        XCTAssertTrue(didStart)
        streamClient.emit(.token("Partial response"))

        requests.request(at: 0).complete(withJSON: """
        {
          "session": {
            "session_id": "session-abc",
            "messages": [
              {
                "role": "user",
                "content": "Old question",
                "timestamp": 1770000001,
                "message_id": "old-user"
              }
            ]
          }
        }
        """)
        await loadTask.value

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["In-flight question", "Partial response"])
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
        XCTAssertNotNil(viewModel.streamingAssistantMessageID)
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testReloadPreservesOptimisticTurnWhileChatStartIsPending() async throws {
        try await assertPendingStartReloadPreservesNewResponse(
            host: "tal116-session-first.test",
            eventsOnStart: [.token("Partial response")],
            expectedMessages: ["Old question", "Pending question", "Partial response"],
            expectedActiveStreamID: "stream-123"
        )
    }

    @MainActor
    func testReloadPreservesRepeatedOptimisticTurnWhileChatStartIsPending() async throws {
        try await assertPendingStartReloadPreservesNewResponse(
            host: "tal116-repeated-prompt.test",
            loadedUserContent: "Pending question",
            loadedUserTimestamp: Date().timeIntervalSince1970 - 30,
            eventsOnStart: [.token("Partial response")],
            expectedMessages: ["Pending question", "Pending question", "Partial response"],
            expectedActiveStreamID: "stream-123"
        )
    }

    @MainActor
    func testReloadDoesNotReplaceResponseCompletedBeforeWaiterResumes() async throws {
        try await assertPendingStartReloadPreservesNewResponse(
            host: "tal116-fast-completion.test",
            eventsOnStart: [.token("Partial response"), .done(DoneStreamEvent(session: nil))],
            expectedMessages: ["Pending question", "Partial response"],
            expectedActiveStreamID: nil
        )
    }

    private func assertPendingStartReloadPreservesNewResponse(
        host: String,
        loadedUserContent: String = "Old question",
        loadedUserTimestamp: Double = 1_770_000_001,
        eventsOnStart: [SSEEvent],
        expectedMessages: [String],
        expectedActiveStreamID: String?
    ) async throws {
        let requests = DeferredRequests()
        let sessionRequestStarted = expectation(description: "session request started")
        let chatStartRequestStarted = expectation(description: "chat start request started")
        DeferredMockURLProtocol.setOnRequest({ request in
            _ = requests.append(request)
            switch request.request.url?.path {
            case "/api/session": sessionRequestStarted.fulfill()
            case "/api/chat/start": chatStartRequestStarted.fulfill()
            default: XCTFail("Unexpected request path: \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let streamClient = SpySSEStreamingClient()
        streamClient.eventsOnStart = eventsOnStart
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        let loadTask = Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [sessionRequestStarted], timeout: 10)
        let sendTask = Task { @MainActor in
            await viewModel.sendMessage("Pending question")
        }
        await fulfillment(of: [chatStartRequestStarted], timeout: 10)

        requests.request(at: 0).complete(withJSON: """
        {
          "session": {
            "session_id": "session-abc",
            "messages": [
              {
                "role": "user",
                "content": "\(loadedUserContent)",
                "timestamp": \(loadedUserTimestamp),
                "message_id": "old-user"
              }
            ]
          }
        }
        """)
        try await waitUntil { viewModel.messageSendWaiterCount == 1 }
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Pending question"])

        requests.request(at: 1).complete(withJSON: """
        {
          "session_id": "session-abc",
          "stream_id": "stream-123"
        }
        """)
        let didStart = await sendTask.value
        XCTAssertTrue(didStart)
        await loadTask.value
        XCTAssertEqual(viewModel.messages.compactMap(\.content), expectedMessages)
        XCTAssertEqual(viewModel.activeStreamID, expectedActiveStreamID)
    }

    @MainActor
    func testNewestReloadWinsWhenTwoLoadsWaitForTheSameChatStart() async throws {
        let (viewModel, requests, sendTask, _) = try await startTwoReloadsAndPendingSend(host: "tal116-newest-load.test")

        requests.request(at: 0).complete(withJSON: Self.olderReloadJSON)
        try await waitUntil { viewModel.messageSendWaiterCount == 1 }
        requests.request(at: 1).complete(withJSON: Self.newestReloadJSON)
        try await waitUntil { viewModel.messageSendWaiterCount == 2 }
        requests.request(at: 2).complete(withJSON: Self.pendingChatStartJSON)

        try await assertNewestReloadWon(viewModel, sendTask: sendTask)
    }

    @MainActor
    func testNewestReloadWinsWhenItsResponseArrivesFirst() async throws {
        let (viewModel, requests, sendTask, _) = try await startTwoReloadsAndPendingSend(host: "tal400-newest-first.test")

        requests.request(at: 1).complete(withJSON: Self.newestReloadJSON)
        try await waitUntil { viewModel.messageSendWaiterCount == 1 }
        requests.request(at: 0).complete(withJSON: Self.olderReloadJSON)
        try await waitUntil { viewModel.messageSendWaiterCount == 2 }
        requests.request(at: 2).complete(withJSON: Self.pendingChatStartJSON)

        try await assertNewestReloadWon(viewModel, sendTask: sendTask)
    }

    /// TAL-400: the newest reload's response lands after the chat start, so the run supersedes it.
    /// The older reload parked on the send must not apply its staler transcript afterwards.
    @MainActor
    func testOlderReloadDoesNotApplyAfterNewestReloadIsSupersededByTheStartedRun() async throws {
        let (viewModel, requests, sendTask, streamClient) = try await startTwoReloadsAndPendingSend(
            host: "tal400-newest-late.test"
        )

        requests.request(at: 0).complete(withJSON: Self.olderReloadJSON)
        try await waitUntil { viewModel.messageSendWaiterCount == 1 }
        requests.request(at: 2).complete(withJSON: Self.pendingChatStartJSON)
        let didStart = await sendTask.value
        XCTAssertTrue(didStart)
        requests.request(at: 1).complete(withJSON: Self.newestReloadJSON)
        try await waitUntil { !viewModel.isLoading }

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Pending question"])
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")

        // The superseded load still answered the cold open, so its run-state check must not outlive the run.
        streamClient.emit(.done(DoneStreamEvent(session: try makeSessionDetail("""
        {
          "session_id": "session-abc",
          "messages": [
            {"role": "user", "content": "Pending question", "message_id": "u-1"},
            {"role": "assistant", "content": "Pending answer", "message_id": "a-1"}
          ]
        }
        """))))
        XCTAssertNil(viewModel.activeStreamID)
        XCTAssertFalse(viewModel.showsRunStateCheck)
    }

    private static let olderReloadJSON = """
    {
      "session": {
        "session_id": "session-abc",
        "messages": [
          {"role": "user", "content": "Older question", "timestamp": 1, "message_id": "old-user"},
          {"role": "assistant", "content": "Older response", "timestamp": 2, "message_id": "old-assistant"}
        ]
      }
    }
    """

    private static let newestReloadJSON = """
    {
      "session": {
        "session_id": "session-abc",
        "messages": [
          {"role": "user", "content": "Newest question", "timestamp": 3, "message_id": "new-user"},
          {"role": "assistant", "content": "Newest response", "timestamp": 4, "message_id": "new-assistant"}
        ]
      }
    }
    """

    private static let pendingChatStartJSON = """
    {
      "session_id": "session-abc",
      "stream_id": "stream-123"
    }
    """

    /// Cold-opens the chat, starts two reloads, then a send, and returns once all three requests are in flight:
    /// request 0 is the older `/api/session`, request 1 the newer one, request 2 `/api/chat/start`.
    private func startTwoReloadsAndPendingSend(
        host: String
    ) async throws -> (ChatViewModel, DeferredRequests, Task<Bool, Never>, SpySSEStreamingClient) {
        let requests = DeferredRequests()
        let firstSessionRequestStarted = expectation(description: "first session request started")
        let secondSessionRequestStarted = expectation(description: "second session request started")
        let chatStartRequestStarted = expectation(description: "chat start request started")
        DeferredMockURLProtocol.setOnRequest({ request in
            let requestCount = requests.append(request)
            switch request.request.url?.path {
            case "/api/session":
                (requestCount == 1 ? firstSessionRequestStarted : secondSessionRequestStarted).fulfill()
            case "/api/chat/start":
                chatStartRequestStarted.fulfill()
            default:
                XCTFail("Unexpected request path: \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }
        viewModel.prepareInitialMessageLoad(modelContext: try makeContext())
        Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [firstSessionRequestStarted], timeout: 10)
        Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [secondSessionRequestStarted], timeout: 10)
        let sendTask = Task { @MainActor in
            await viewModel.sendMessage("Pending question")
        }
        await fulfillment(of: [chatStartRequestStarted], timeout: 10)
        return (viewModel, requests, sendTask, streamClient)
    }

    @MainActor
    private func assertNewestReloadWon(_ viewModel: ChatViewModel, sendTask: Task<Bool, Never>) async throws {
        let didStart = await sendTask.value
        XCTAssertTrue(didStart)
        try await waitUntil { !viewModel.isLoading }

        XCTAssertEqual(
            viewModel.messages.compactMap(\.content),
            ["Newest question", "Newest response", "Pending question"]
        )
        XCTAssertEqual(viewModel.activeStreamID, "stream-123")
    }

    @MainActor
    func testNewestReloadFailureWinsWhenTwoLoadsFail() async throws {
        let requests = DeferredRequests()
        let host = "tal116-newest-failure.test"
        let firstSessionRequestStarted = expectation(description: "first session request started")
        let secondSessionRequestStarted = expectation(description: "second session request started")
        DeferredMockURLProtocol.setOnRequest({ request in
            XCTAssertEqual(request.request.url?.path, "/api/session")
            let requestCount = requests.append(request)
            (requestCount == 1 ? firstSessionRequestStarted : secondSessionRequestStarted).fulfill()
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let viewModel = try makeViewModel(
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }
        let firstLoadTask = Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [firstSessionRequestStarted], timeout: 10)
        let secondLoadTask = Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [secondSessionRequestStarted], timeout: 10)

        requests.request(at: 0).complete(withJSON: #"{"error":"older failure"}"#, statusCode: 500)
        await drainMainActor()
        requests.request(at: 1).complete(withJSON: #"{"error":"newer failure"}"#, statusCode: 401)
        await firstLoadTask.value
        await secondLoadTask.value

        guard let lastError = viewModel.lastError as? APIError,
              case .unauthorized = lastError else {
            return XCTFail("Expected the newer unauthorized error")
        }
        XCTAssertEqual(viewModel.errorMessage, APIError.unauthorized.localizedDescription)
    }

    @MainActor
    func testPendingSecondSendDoesNotMakeOlderReloadCurrentAgain() async throws {
        let requests = DeferredRequests()
        let host = "tal116-two-responses.test"
        let sessionRequestStarted = expectation(description: "session request started")
        let firstChatStartRequestStarted = expectation(description: "first chat start request started")
        let secondChatStartRequestStarted = expectation(description: "second chat start request started")
        DeferredMockURLProtocol.setOnRequest({ request in
            let requestCount = requests.append(request)
            switch request.request.url?.path {
            case "/api/session":
                sessionRequestStarted.fulfill()
            case "/api/chat/start":
                (requestCount == 2 ? firstChatStartRequestStarted : secondChatStartRequestStarted).fulfill()
            default:
                XCTFail("Unexpected request path: \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        let loadTask = Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [sessionRequestStarted], timeout: 10)

        let firstSendTask = Task { @MainActor in
            await viewModel.sendMessage("Question A")
        }
        await fulfillment(of: [firstChatStartRequestStarted], timeout: 10)
        requests.request(at: 1).complete(withJSON: """
        {
          "session_id": "session-abc",
          "stream_id": "stream-a"
        }
        """)
        let firstDidStart = await firstSendTask.value
        XCTAssertTrue(firstDidStart)
        streamClient.emit(.token("Answer A"))
        streamClient.emit(.done(DoneStreamEvent(session: nil)))

        let secondSendTask = Task { @MainActor in
            await viewModel.sendMessage("Question B")
        }
        await fulfillment(of: [secondChatStartRequestStarted], timeout: 10)
        requests.request(at: 0).complete(withJSON: """
        {
          "session": {
            "session_id": "session-abc",
            "messages": [
              {
                "role": "user",
                "content": "Old question",
                "timestamp": 1770000001,
                "message_id": "old-user"
              }
            ]
          }
        }
        """)
        await drainMainActor()
        requests.request(at: 2).complete(withJSON: """
        {
          "session_id": "session-abc",
          "stream_id": "stream-b"
        }
        """)
        let secondDidStart = await secondSendTask.value
        XCTAssertTrue(secondDidStart)
        await loadTask.value

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Question A", "Answer A", "Question B"])
        XCTAssertEqual(viewModel.activeStreamID, "stream-b")
    }

    @MainActor
    func testDuplicateStartRecoveryDiscardsOlderOuterReload() async throws {
        let requests = DeferredRequests()
        let host = "tal116-duplicate-start.test"
        let outerSessionRequestStarted = expectation(description: "outer session request started")
        let chatStartRequestStarted = expectation(description: "chat start request started")
        let recoverySessionRequestStarted = expectation(description: "recovery session request started")
        DeferredMockURLProtocol.setOnRequest({ request in
            let requestCount = requests.append(request)
            switch request.request.url?.path {
            case "/api/session":
                (requestCount == 1 ? outerSessionRequestStarted : recoverySessionRequestStarted).fulfill()
            case "/api/chat/start":
                chatStartRequestStarted.fulfill()
            default:
                XCTFail("Unexpected request path: \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        let loadTask = Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [outerSessionRequestStarted], timeout: 10)
        let sendTask = Task { @MainActor in
            await viewModel.sendMessage("Rejected duplicate")
        }
        await fulfillment(of: [chatStartRequestStarted], timeout: 10)

        requests.request(at: 0).complete(withJSON: """
        {
          "session": {
            "session_id": "session-abc",
            "messages": [
              {
                "role": "user",
                "content": "Old question",
                "timestamp": 1770000001,
                "message_id": "old-user"
              }
            ]
          }
        }
        """)
        await drainMainActor()
        requests.request(at: 1).complete(
            withJSON: #"{"error":"session already has an active stream","active_stream_id":"stream-existing"}"#,
            statusCode: 409
        )
        await fulfillment(of: [recoverySessionRequestStarted], timeout: 10)
        requests.request(at: 2).complete(withJSON: """
        {
          "session": {
            "session_id": "session-abc",
            "active_stream_id": "stream-existing",
            "messages": [
              {
                "role": "user",
                "content": "Existing question",
                "timestamp": 1770000002,
                "message_id": "existing-user"
              },
              {
                "role": "assistant",
                "content": "Partial response",
                "timestamp": 1770000003,
                "message_id": "existing-assistant"
              }
            ]
          }
        }
        """)
        let didStart = await sendTask.value
        XCTAssertFalse(didStart)
        await loadTask.value

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Existing question", "Partial response"])
        XCTAssertEqual(viewModel.activeStreamID, "stream-existing")
        XCTAssertEqual(streamClient.startedURLs.count, 1)
    }

    @MainActor
    func testDuplicateStartRecoveryUsesOuterResponseWhenNestedLoadFails() async throws {
        let requests = DeferredRequests()
        let host = "tal116-duplicate-start-load-failure.test"
        let outerSessionRequestStarted = expectation(description: "outer session request started")
        let chatStartRequestStarted = expectation(description: "chat start request started")
        let recoverySessionRequestStarted = expectation(description: "recovery session request started")
        DeferredMockURLProtocol.setOnRequest({ request in
            let requestCount = requests.append(request)
            switch request.request.url?.path {
            case "/api/session":
                (requestCount == 1 ? outerSessionRequestStarted : recoverySessionRequestStarted).fulfill()
            case "/api/chat/start":
                chatStartRequestStarted.fulfill()
            default:
                XCTFail("Unexpected request path: \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        let loadTask = Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [outerSessionRequestStarted], timeout: 10)
        let sendTask = Task { @MainActor in
            await viewModel.sendMessage("Rejected duplicate")
        }
        await fulfillment(of: [chatStartRequestStarted], timeout: 10)

        requests.request(at: 0).complete(withJSON: """
        {
          "session": {
            "session_id": "session-abc",
            "messages": [
              {
                "role": "user",
                "content": "Existing question",
                "timestamp": 1770000001,
                "message_id": "existing-user"
              },
              {
                "role": "assistant",
                "content": "Existing partial response",
                "timestamp": 1770000002,
                "message_id": "existing-assistant"
              }
            ]
          }
        }
        """)
        await drainMainActor()
        requests.request(at: 1).complete(
            withJSON: #"{"error":"session already has an active stream","active_stream_id":"stream-existing"}"#,
            statusCode: 409
        )
        await fulfillment(of: [recoverySessionRequestStarted], timeout: 10)
        requests.request(at: 2).fail(with: URLError(.timedOut))

        let didStart = await sendTask.value
        XCTAssertFalse(didStart)
        await loadTask.value

        XCTAssertEqual(
            viewModel.messages.compactMap(\.content),
            ["Existing question", "Existing partial response"]
        )
        XCTAssertEqual(viewModel.activeStreamID, "stream-existing")
        XCTAssertEqual(streamClient.startedURLs.count, 1)
        XCTAssertNil(viewModel.lastError)
        XCTAssertNil(viewModel.errorMessage)
    }

    @MainActor
    func testSuccessfulReloadStillAppliesWhenConcurrentChatStartFails() async throws {
        let requests = DeferredRequests()
        let host = "tal116-start-failure.test"
        let sessionRequestStarted = expectation(description: "session request started")
        let chatStartRequestStarted = expectation(description: "chat start request started")
        DeferredMockURLProtocol.setOnRequest({ request in
            _ = requests.append(request)
            switch request.request.url?.path {
            case "/api/session": sessionRequestStarted.fulfill()
            case "/api/chat/start": chatStartRequestStarted.fulfill()
            default: XCTFail("Unexpected request path: \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let viewModel = try makeViewModel(
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }
        let loadTask = Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [sessionRequestStarted], timeout: 10)

        let sendTask = Task { @MainActor in
            await viewModel.sendMessage("Rejected question")
        }
        await fulfillment(of: [chatStartRequestStarted], timeout: 10)
        requests.request(at: 1).complete(withJSON: #"{"error":"start failed"}"#)
        let didStart = await sendTask.value
        XCTAssertFalse(didStart)

        requests.request(at: 0).complete(withJSON: """
        {
          "session": {
            "session_id": "session-abc",
            "messages": [
              {
                "role": "assistant",
                "content": "Authoritative transcript",
                "timestamp": 1770000001,
                "message_id": "assistant-1"
              }
            ]
          }
        }
        """)
        await loadTask.value

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Authoritative transcript"])
        XCTAssertNil(viewModel.activeStreamID)
    }

    @MainActor
    func testReloadFailureWaitsForConcurrentChatStartFailureBeforeUsingCache() async throws {
        let context = try makeContext()
        let requests = DeferredRequests()
        let host = "tal116-both-fail.test"
        let serverURL = URL(string: "https://\(host)")!
        try CacheStore.cacheMessages(
            [ChatMessage(role: "assistant", content: "Cached transcript", timestamp: 1_770_000_001, messageId: "cached-1")],
            serverURL: serverURL,
            sessionID: "session-abc",
            in: context
        )
        let sessionRequestStarted = expectation(description: "session request started")
        let chatStartRequestStarted = expectation(description: "chat start request started")
        DeferredMockURLProtocol.setOnRequest({ request in
            _ = requests.append(request)
            switch request.request.url?.path {
            case "/api/session": sessionRequestStarted.fulfill()
            case "/api/chat/start": chatStartRequestStarted.fulfill()
            default: XCTFail("Unexpected request path: \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let viewModel = try makeViewModel(
            server: serverURL,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }
        let loadTask = Task { @MainActor in
            await viewModel.loadMessages(modelContext: context)
        }
        await fulfillment(of: [sessionRequestStarted], timeout: 10)
        let sendTask = Task { @MainActor in
            await viewModel.sendMessage("Rejected question", modelContext: context)
        }
        await fulfillment(of: [chatStartRequestStarted], timeout: 10)

        requests.request(at: 0).fail(with: URLError(.timedOut))
        await drainMainActor()
        requests.request(at: 1).complete(withJSON: #"{"error":"start failed"}"#)
        let didStart = await sendTask.value
        XCTAssertFalse(didStart)
        await loadTask.value

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Cached transcript"])
        XCTAssertTrue(viewModel.isViewingCachedData)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.activeStreamID)
    }

    @MainActor
    func testStreamEndDoesNotInvalidateCompletionTranscriptReload() async throws {
        let requests = DeferredRequests()
        let host = "tal116-completion.test"
        let chatStartRequestStarted = expectation(description: "chat start request started")
        let sessionRequestStarted = expectation(description: "session request started")
        let titleRequestCompleted = expectation(description: "title request completed")
        DeferredMockURLProtocol.setOnRequest({ request in
            _ = requests.append(request)
            switch request.request.url?.path {
            case "/api/chat/start": chatStartRequestStarted.fulfill()
            case "/api/session":
                let includesMessages = URLComponents(
                    url: request.request.url!,
                    resolvingAgainstBaseURL: false
                )?.queryItems?.first(where: { $0.name == "messages" })?.value == "1"
                if includesMessages {
                    sessionRequestStarted.fulfill()
                } else {
                    request.complete(withJSON: #"{"session":{"session_id":"session-abc","title":"Updated"}}"#)
                    titleRequestCompleted.fulfill()
                }
            default: XCTFail("Unexpected request path: \(request.request.url?.path ?? "nil")")
            }
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(
            streamClient: streamClient,
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        let sendTask = Task { @MainActor in
            await viewModel.sendMessage("Question")
        }
        await fulfillment(of: [chatStartRequestStarted], timeout: 10)
        requests.request(at: 0).complete(withJSON: """
        {
          "session_id": "session-abc",
          "stream_id": "stream-123"
        }
        """)
        let didStart = await sendTask.value
        XCTAssertTrue(didStart)
        streamClient.emit(.token("Partial response"))
        streamClient.emit(.done(DoneStreamEvent(session: nil)))
        XCTAssertTrue(viewModel.responseCompletionNeedsTranscriptRefresh)

        let loadTask = Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [sessionRequestStarted], timeout: 10)
        streamClient.emit(.streamEnd)
        requests.request(at: 1).complete(withJSON: """
        {
          "session": {
            "session_id": "session-abc",
            "messages": [
              {
                "role": "user",
                "content": "Question",
                "timestamp": 1770000001,
                "message_id": "user-1"
              },
              {
                "role": "assistant",
                "content": "Final response",
                "timestamp": 1770000002,
                "message_id": "assistant-1"
              }
            ]
          }
        }
        """)
        await loadTask.value
        await fulfillment(of: [titleRequestCompleted], timeout: 10)

        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Question", "Final response"])
        XCTAssertFalse(viewModel.responseCompletionNeedsTranscriptRefresh)
        XCTAssertNil(viewModel.activeStreamID)
    }

    @MainActor
    func testReloadDoesNotDuplicateCachedOptimisticAttachmentMessageWhenServerReturnsIt() async throws {
        let context = try makeContext()
        let serverURL = URL(string: "https://example.test")!
        try CacheStore.cacheMessages(
            [
                ChatMessage(
                    role: "user",
                    content: "Summarize it",
                    timestamp: 1_770_000_000,
                    messageId: "local-attachment",
                    attachments: [
                        MessageAttachment(
                            name: "photo.png",
                            path: "/tmp/workspace/photo.png",
                            mime: "image/png",
                            size: 4,
                            isImage: true
                        )
                    ]
                )
            ],
            serverURL: serverURL,
            sessionID: "session-abc",
            in: context
        )

        let reopenedViewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return apiTestJSONResponse("""
            {
              "session": {
                "session_id": "session-abc",
                "messages": [
                  {
                    "role": "user",
                    "content": "Summarize it\\n\\n[Attached files: /tmp/workspace/photo.png]",
                    "timestamp": 1770000001,
                    "message_id": "user-1"
                  },
                  {
                    "role": "assistant",
                    "content": "Recovered transcript.",
                    "timestamp": 1770000100,
                    "message_id": "assistant-1"
                  }
                ]
              }
            }
            """, for: request)
        }

        await reopenedViewModel.loadMessages(modelContext: context)

        XCTAssertEqual(reopenedViewModel.messages.compactMap(\.role), ["user", "assistant"])
        XCTAssertEqual(reopenedViewModel.messages.first?.messageId, "user-1")
        XCTAssertEqual(reopenedViewModel.messages.filter { $0.role == "user" }.count, 1)
    }
}
