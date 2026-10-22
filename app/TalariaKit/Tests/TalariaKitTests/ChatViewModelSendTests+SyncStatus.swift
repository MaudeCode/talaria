import SwiftData
import XCTest
@testable import TalariaKit

// TAL-436: "Syncing messages" tracks a populated transcript's reconcile with the server.
@MainActor
extension ChatViewModelSendTests {
    func testCachedRunCheckStaysHiddenWhenSendAdoptsAnUnconfirmedLoad() async throws {
        let context = try makeContext()
        let server = URL(string: "https://cached-send-run-check.test")!
        try CacheStore.cacheMessages([
            ChatMessage(role: "user", content: "Cached question", timestamp: 1_770_000_001, messageId: "cached-user"),
            ChatMessage(role: "assistant", content: "Cached answer", timestamp: 1_770_000_002, messageId: "cached-answer")
        ], serverURL: server, sessionID: "session-abc", in: context)
        let requests = DeferredRequests()
        DeferredMockURLProtocol.setOnRequest({ _ = requests.append($0) }, forHost: server.host!)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: server.host!) }
        let viewModel = try makeViewModel(server: server, protocolClasses: [DeferredMockURLProtocol.self]) { _ in
            throw URLError(.badURL)
        }
        viewModel.prepareInitialMessageLoad(modelContext: context)
        XCTAssertTrue(viewModel.isSyncingTranscript)
        XCTAssertFalse(viewModel.showsRunStateCheck)
        let load = Task { await viewModel.loadMessages(modelContext: context) }
        try await waitUntil { requests.count == 1 }
        let send = Task { await viewModel.sendMessage("Next question") }
        try await waitUntil { requests.count == 2 }
        XCTAssertFalse(viewModel.showsRunStateCheck, "A routine load must not add a Checking chip beside Starting.")
        requests.request(at: 1).complete(withJSON: #"{"error":"Send failed"}"#, statusCode: 500)
        let sent = await send.value
        XCTAssertFalse(sent)
        XCTAssertFalse(viewModel.showsRunStateCheck, "A failed send must not reveal a redundant check while its load remains held.")
        requests.request(at: 0).complete(withJSON: Self.syncStatusSessionJSON)
        await load.value
        XCTAssertFalse(viewModel.showsRunStateCheck)
    }

    func testRoutineReloadBeforeSendACKDoesNotIntroduceASyncPhase() async throws {
        try await checkSendReloadStatus(acknowledgesFirst: false)
    }

    func testRoutineReloadAfterSendACKDoesNotIntroduceASyncPhase() async throws {
        try await checkSendReloadStatus(acknowledgesFirst: true)
    }

    func testFailedSendDoesNotRevealAnOverlappingSyncPhase() async throws {
        try await checkSendReloadStatus(acknowledgesFirst: false, failsSend: true)
    }

    func testCompletionAnnouncementReconcilesSilentlyButReconnectShowsFreshness() async throws {
        let requests = LockedCounter()
        let held = expectation(description: "completion reconcile held")
        let reconnectHeld = expectation(description: "reconnect resync held")
        let release = DispatchSemaphore(value: 0)
        let viewModel = try makeViewModel { request in
            if request.url?.path == "/api/background/tasks" {
                return apiTestJSONResponse(#"{"tasks":[]}"#, for: request)
            }
            let count = requests.increment()
            if count > 1 {
                (count == 2 ? held : reconnectHeld).fulfill()
                XCTAssertEqual(release.wait(timeout: .now() + .seconds(5)), .success)
            }
            return apiTestJSONResponse(Self.syncStatusSessionJSON, for: request)
        }
        defer { release.signal(); viewModel.cleanupPollingTasks() }
        await viewModel.loadMessages()
        let reconcile = Task { await viewModel.handleSessionsChange(.changed(reason: "session_done", sessionID: "session-abc")) }
        await fulfillment(of: [held], timeout: 10)
        XCTAssertTrue(viewModel.isLoading)
        XCTAssertFalse(viewModel.isSyncingTranscript, "A completion announcement is routine reconciliation, not a send phase.")
        release.signal()
        await reconcile.value
        let reconnect = Task { await viewModel.handleSessionsChange(.resync) }
        await fulfillment(of: [reconnectHeld], timeout: 10)
        XCTAssertTrue(viewModel.isSyncingTranscript, "A reconnect must visibly recheck freshness.")
        release.signal()
        await reconnect.value
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Fresh question", "Fresh answer"])
    }

    private func checkSendReloadStatus(acknowledgesFirst: Bool, failsSend: Bool = false) async throws {
        let host = "send-sync-\(acknowledgesFirst)-\(failsSend).test"
        let requests = DeferredRequests()
        DeferredMockURLProtocol.setOnRequest({ _ = requests.append($0) }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let stream = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: stream, server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]) { _ in throw URLError(.badURL) }
        defer { viewModel.suspendStreamForNavigation(); viewModel.cleanupPollingTasks() }
        let initial = Task { await viewModel.loadMessages() }
        try await waitUntil { requests.count == 1 }
        requests.request(at: 0).complete(withJSON: Self.syncStatusSessionJSON)
        await initial.value

        let reload = Task { await viewModel.loadMessages() }
        try await waitUntil { requests.count == 2 }
        XCTAssertTrue(viewModel.isSyncingTranscript)
        let send = Task { await viewModel.sendMessage("Next question") }
        try await waitUntil { requests.count == 3 }
        XCTAssertFalse(viewModel.isSyncingTranscript, "Submitting a message ends the visible freshness check.")
        let optimisticID = try XCTUnwrap(viewModel.messages.last?.messageId)
        if !acknowledgesFirst && !failsSend {
            requests.request(at: 1).complete(withJSON: Self.syncStatusSessionJSON)
        }
        requests.request(at: 2).complete(withJSON: failsSend ? #"{"error":"Send failed"}"# :
            #"{"session_id":"session-abc","stream_id":"stream-123"}"#, statusCode: failsSend ? 500 : 200)
        let sent = await send.value
        XCTAssertEqual(sent, !failsSend)
        XCTAssertFalse(viewModel.isSyncingTranscript, "An overlapping reload must never become a post-send sync phase.")
        if failsSend {
            XCTAssertNotNil(viewModel.sendErrorMessage)
            XCTAssertFalse(viewModel.messages.contains { $0.messageId == optimisticID })
        } else {
            await viewModel.reconnectStreamIfNeeded()
            stream.emit(.token("Live answer"), lastEventID: "stream-123:1")
            try await waitUntil { viewModel.messages.last?.content == "Live answer" }
            XCTAssertFalse(viewModel.isSyncingTranscript, "Streaming output must remain visible while a reload is held.")
            XCTAssertEqual(viewModel.messages.filter { $0.messageId == optimisticID }.count, 1)
            if !acknowledgesFirst { await reload.value }
            stream.emit(.done(DoneStreamEvent()))
            try await waitUntil { viewModel.activeStreamID == nil }
            XCTAssertFalse(viewModel.isSyncingTranscript, "Completion must not reveal a held routine reload.")
        }
        if acknowledgesFirst || failsSend {
            requests.request(at: 1).complete(withJSON: Self.syncStatusSessionJSON)
        }
        await reload.value
        XCTAssertFalse(viewModel.isLoading)

        // A later foreground/reopen freshness check remains visible, even after a local send.
        let refresh = Task { await viewModel.loadMessages() }
        try await waitUntil { requests.count >= 4 }
        XCTAssertTrue(viewModel.isSyncingTranscript)
        requests.request(at: requests.count - 1).complete(withJSON: Self.syncStatusSessionJSON)
        await refresh.value
        XCTAssertFalse(viewModel.isSyncingTranscript)

        let completionReload = Task { await viewModel.loadMessages(isRoutineReconciliation: true) }
        try await waitUntil { requests.count == 5 }
        XCTAssertTrue(viewModel.isLoading)
        XCTAssertFalse(viewModel.isSyncingTranscript, "Completion-triggered reconciliation is background work.")
        requests.request(at: 4).complete(withJSON: Self.syncStatusSessionJSON)
        await completionReload.value
    }

    func testNewChatReloadDuringTheResponseStaysSilentAfterFastCompletion() async throws {
        let held = expectation(description: "response reload held")
        let release = DispatchSemaphore(value: 0)
        let stream = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: stream, sessionSummary: SessionSummary(title: "New Chat")) { request in
            if request.url?.path == "/api/chat/start" {
                return apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"stream-123"}"#, for: request)
            }
            held.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + .seconds(5)), .success)
            return apiTestJSONResponse(Self.syncStatusSessionJSON, for: request)
        }
        defer { release.signal(); viewModel.suspendStreamForNavigation(); viewModel.cleanupPollingTasks() }
        let sent = await viewModel.sendMessage("First question", waitForSession: {
            viewModel.adoptCreatedSession(SessionSummary(sessionId: "session-abc", title: "New Chat"))
            return true
        })
        XCTAssertTrue(sent)
        await viewModel.reconnectStreamIfNeeded()
        let reload = Task { await viewModel.loadMessages() }
        await fulfillment(of: [held], timeout: 10)
        XCTAssertTrue(viewModel.isLoading)
        XCTAssertFalse(viewModel.isSyncingTranscript)
        stream.emit(.token("First answer"), lastEventID: "stream-123:1")
        try await waitUntil { viewModel.messages.last?.content == "First answer" }
        stream.emit(.done(DoneStreamEvent()))
        try await waitUntil { viewModel.activeStreamID == nil }
        XCTAssertFalse(viewModel.isSyncingTranscript)
        release.signal()
        await reload.value
    }

    func testCacheFirstOpenSyncsUntilTheServerTranscriptArrives() async throws {
        let context = try makeContext()
        try CacheStore.cacheMessages(
            [
                ChatMessage(role: "user", content: "Cached question", timestamp: 1_770_000_001, messageId: "cached-user"),
                ChatMessage(role: "assistant", content: "Cached answer", timestamp: 1_770_000_002, messageId: "cached-assistant")
            ],
            serverURL: try XCTUnwrap(URL(string: "https://example.test")),
            sessionID: "session-abc",
            in: context
        )
        let sessionRequestStarted = expectation(description: "session request started")
        let releaseSessionResponse = DispatchSemaphore(value: 0)
        let viewModel = try makeViewModel { request in
            sessionRequestStarted.fulfill()
            XCTAssertEqual(releaseSessionResponse.wait(timeout: .now() + .seconds(5)), .success)
            return apiTestJSONResponse(Self.syncStatusSessionJSON, for: request)
        }

        viewModel.prepareInitialMessageLoad(modelContext: context)
        XCTAssertTrue(viewModel.isSyncingTranscript, "Cached rows are on screen while the server is still unchecked.")

        let loadTask = Task { @MainActor in
            await viewModel.loadMessages(modelContext: context)
        }
        defer { releaseSessionResponse.signal() }
        await fulfillment(of: [sessionRequestStarted], timeout: 10)
        XCTAssertTrue(viewModel.isSyncingTranscript)

        releaseSessionResponse.signal()
        await loadTask.value
        XCTAssertFalse(viewModel.isSyncingTranscript)
    }

    func testEmptyTranscriptLoadShowsTheSkeletonInsteadOfSyncing() async throws {
        let sessionRequestStarted = expectation(description: "session request started")
        let releaseSessionResponse = DispatchSemaphore(value: 0)
        let viewModel = try makeViewModel { request in
            sessionRequestStarted.fulfill()
            XCTAssertEqual(releaseSessionResponse.wait(timeout: .now() + .seconds(5)), .success)
            return apiTestJSONResponse(Self.syncStatusSessionJSON, for: request)
        }

        let loadTask = Task { @MainActor in
            await viewModel.loadMessages()
        }
        defer { releaseSessionResponse.signal() }
        await fulfillment(of: [sessionRequestStarted], timeout: 10)
        XCTAssertTrue(viewModel.isLoading)
        XCTAssertFalse(viewModel.isSyncingTranscript)

        releaseSessionResponse.signal()
        await loadTask.value
    }

    func testInPlaceReloadSyncsButPullToRefreshLeavesItToTheSystemSpinner() async throws {
        let requests = LockedCounter()
        let pullRequestStarted = expectation(description: "pull-to-refresh request started")
        let reloadRequestStarted = expectation(description: "in-place reload request started")
        let releaseReload = DispatchSemaphore(value: 0)
        let viewModel = try makeViewModel { request in
            switch requests.increment() {
            case 2: pullRequestStarted.fulfill()
            case 3: reloadRequestStarted.fulfill()
            default: return apiTestJSONResponse(Self.syncStatusSessionJSON, for: request)
            }
            XCTAssertEqual(releaseReload.wait(timeout: .now() + .seconds(5)), .success)
            return apiTestJSONResponse(Self.syncStatusSessionJSON, for: request)
        }
        await viewModel.loadMessages()
        XCTAssertFalse(viewModel.messages.isEmpty)
        defer {
            releaseReload.signal()
            releaseReload.signal()
        }

        let pullTask = Task { @MainActor in
            await viewModel.loadMessages(isUserRefresh: true)
        }
        await fulfillment(of: [pullRequestStarted], timeout: 10)
        XCTAssertTrue(viewModel.isLoading)
        XCTAssertFalse(viewModel.isSyncingTranscript, "Pull-to-refresh already shows the system spinner.")
        releaseReload.signal()
        await pullTask.value

        let reloadTask = Task { @MainActor in
            await viewModel.loadMessages()
        }
        await fulfillment(of: [reloadRequestStarted], timeout: 10)
        XCTAssertTrue(viewModel.isSyncingTranscript)
        releaseReload.signal()
        await reloadTask.value
        XCTAssertFalse(viewModel.isSyncingTranscript)
    }

    func testReloadOverlappingPullToRefreshStillLeavesItToTheSystemSpinner() async throws {
        let requests = LockedCounter()
        let pullRequestStarted = expectation(description: "pull-to-refresh request started")
        let releasePull = DispatchSemaphore(value: 0)
        let viewModel = try makeViewModel { request in
            if requests.increment() == 2 {
                pullRequestStarted.fulfill()
                XCTAssertEqual(releasePull.wait(timeout: .now() + .seconds(5)), .success)
            }
            return apiTestJSONResponse(Self.syncStatusSessionJSON, for: request)
        }
        await viewModel.loadMessages()
        defer { releasePull.signal() }

        let pullTask = Task { @MainActor in await viewModel.loadMessages(isUserRefresh: true) }
        await fulfillment(of: [pullRequestStarted], timeout: 10)
        // An automatic reload starts while the pull is in flight. The main actor runs queued jobs in order,
        // so yielding lets the reload run up to its first await, past where it marks itself loading;
        // before per-load tracking that cleared the pull's suppression (red on 657c7e90e).
        let reloadTask = Task { @MainActor in await viewModel.loadMessages() }
        await Task.yield()

        XCTAssertFalse(viewModel.isSyncingTranscript, "The pull-to-refresh spinner is still up.")
        releasePull.signal()
        await pullTask.value
        await reloadTask.value
    }

    // A newer load that fails ends before an older one still on the network; the older one then applies,
    // so the transcript stays loading (and syncing) until the last load ends, not the first.
    func testTranscriptStaysSyncingUntilTheLastOverlappingLoadEnds() async throws {
        let requests = DeferredRequests()
        let host = "tal436-overlapping-loads.test"
        let requestStarted = [
            expectation(description: "initial load started"),
            expectation(description: "older reload started"),
            expectation(description: "newer reload started")
        ]
        DeferredMockURLProtocol.setOnRequest({ request in
            requestStarted[requests.append(request) - 1].fulfill()
        }, forHost: host)
        defer { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let viewModel = try makeViewModel(
            server: URL(string: "https://\(host)")!,
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { request in
            XCTFail("Synchronous handler should not receive \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }

        let initialLoad = Task { @MainActor in await viewModel.loadMessages() }
        await fulfillment(of: [requestStarted[0]], timeout: 10)
        requests.request(at: 0).complete(withJSON: Self.syncStatusSessionJSON)
        await initialLoad.value

        let olderReload = Task { @MainActor in await viewModel.loadMessages() }
        await fulfillment(of: [requestStarted[1]], timeout: 10)
        let newerReload = Task { @MainActor in await viewModel.loadMessages() }
        await fulfillment(of: [requestStarted[2]], timeout: 10)
        requests.request(at: 2).complete(withJSON: #"{"error":"boom"}"#, statusCode: 500)
        await newerReload.value

        XCTAssertTrue(viewModel.isLoading, "The older reload is still on the network.")
        XCTAssertTrue(viewModel.isSyncingTranscript)

        requests.request(at: 1).complete(withJSON: """
        {"session": {"session_id": "session-abc", "title": "Planning", "messages": [
          {"role": "user", "content": "Older reload question", "timestamp": 1770000200, "message_id": "older-user"}
        ]}}
        """)
        await olderReload.value
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertFalse(viewModel.isSyncingTranscript)
    }

    private static let syncStatusSessionJSON = """
    {"session": {"session_id": "session-abc", "title": "Planning", "messages": [
      {"role": "user", "content": "Fresh question", "timestamp": 1770000100, "message_id": "fresh-user"},
      {"role": "assistant", "content": "Fresh answer", "timestamp": 1770000101, "message_id": "fresh-assistant"}
    ]}}
    """
}
