import XCTest
import SwiftData
@testable import TalariaKit

// TAL-184: an open chat that fell back to its cached transcript recovers on its own once the
// server answers again, without overlapping equivalent session loads.
@MainActor
extension ChatViewModelSendTests {
    func testOfflineChatRecoversOnARetryTickAndThenStopsRetrying() async throws {
        let context = try makeOfflineRecoveryContext()
        let server = ScriptedSessionServer(reachableFromRead: 3)
        let viewModel = try makeViewModel(handler: server.handle)
        await viewModel.loadMessages(modelContext: context)
        XCTAssertTrue(viewModel.isViewingCachedData)

        let ticks = RecordingRetryTicks(allowed: 4)
        var stateAfterFailedTick: (cached: Bool, content: [String], error: String?)?
        await viewModel.recoverWhenServerReturns(modelContext: context, sleep: ticks.sleep) {
            if server.sessionReads.count == 2 {
                stateAfterFailedTick = (viewModel.isViewingCachedData, viewModel.messages.compactMap(\.content), viewModel.errorMessage)
            }
        }

        XCTAssertEqual(ticks.durations, Array(repeating: .seconds(30), count: 5))
        XCTAssertEqual(stateAfterFailedTick?.cached, true, "A failed retry stays offline")
        XCTAssertEqual(stateAfterFailedTick?.content, ["Cached question", "Cached answer"], "And keeps the cached transcript")
        XCTAssertNil(stateAfterFailedTick?.error, "Without presenting an error")
        XCTAssertEqual(server.sessionReads.count, 3, "One read per tick until one succeeds, then none")
        XCTAssertFalse(viewModel.isViewingCachedData)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Fresh question", "Fresh answer"])
        XCTAssertEqual(server.backgroundReads.count, 1, "Recovery refreshes background work once, like a manual refresh")
    }

    /// TAL-454: offline, the chat shows the branch link its last detail cached; the server's next answer replaces it.
    func testOfflineChatShowsTheCachedBranchLinkUntilTheServerAnswers() async throws {
        let context = try makeOfflineRecoveryContext()
        let serverURL = try XCTUnwrap(URL(string: "https://example.test"))
        try CacheStore.cacheSessions([SessionSummary(sessionId: "session-abc", title: "Planning")], serverURL: serverURL, in: context)
        let link = SessionBranchLink(sessionId: "parent", title: "Plan")
        try CacheStore.cacheBranchedFrom(link, serverURL: serverURL, sessionID: "session-abc", in: context)
        let server = ScriptedSessionServer(reachableFromRead: 2)
        let viewModel = try makeViewModel(handler: server.handle)

        await viewModel.loadMessages(modelContext: context)
        XCTAssertTrue(viewModel.isViewingCachedData)
        XCTAssertEqual(viewModel.branchedFrom, link)

        await viewModel.loadMessages(modelContext: context)
        XCTAssertFalse(viewModel.isViewingCachedData)
        XCTAssertNil(viewModel.branchedFrom, "The server's detail names no parent")
        XCTAssertNil(try CacheStore.cachedBranchedFrom(serverURL: serverURL, sessionID: "session-abc", in: context))
    }

    func testRecoveryLoopEndsWhenCancelled() async throws {
        let server = ScriptedSessionServer(reachableFromRead: 1)
        let viewModel = try makeViewModel(handler: server.handle)

        let loop = Task { await viewModel.recoverWhenServerReturns() }
        loop.cancel()
        await loop.value

        XCTAssertEqual(server.sessionReads.count, 0)
    }

    func testRetryCancelledMidLoadSkipsItsFollowUpWork() async throws {
        let context = try makeOfflineRecoveryContext()
        let streamClient = SpySSEStreamingClient()
        let requestStarted = expectation(description: "retry read started")
        let releaseResponse = DispatchSemaphore(value: 0)
        let server = ScriptedSessionServer(reachableFromRead: 2, hasRunningTurn: true) { read in
            guard read == 2 else { return }
            requestStarted.fulfill()
            XCTAssertEqual(releaseResponse.wait(timeout: .now() + .seconds(5)), .success)
        }
        let viewModel = try makeViewModel(streamClient: streamClient, handler: server.handle)
        await viewModel.loadMessages(modelContext: context)

        let ticks = RecordingRetryTicks(allowed: 1)
        let loop = Task { await viewModel.recoverWhenServerReturns(modelContext: context, sleep: ticks.sleep) }
        await fulfillment(of: [requestStarted], timeout: 5)
        loop.cancel()
        releaseResponse.signal()
        await loop.value

        XCTAssertFalse(viewModel.isViewingCachedData, "The read in flight still lands")
        XCTAssertEqual(server.streamStatusReads.count, 0, "A chat that closed meanwhile does not reconnect to its run")
        XCTAssertTrue(streamClient.startedURLs.isEmpty)
        XCTAssertEqual(server.backgroundReads.count, 0, "Nor restart its background polling")
        XCTAssertEqual(ticks.durations.count, 1, "And retries no more")
    }

    func testForegroundReturnRecoversAnOfflineChatImmediately() async throws {
        let context = try makeOfflineRecoveryContext()
        let server = ScriptedSessionServer(reachableFromRead: 2)
        let viewModel = try makeViewModel(handler: server.handle)
        await viewModel.loadMessages(modelContext: context)
        XCTAssertTrue(viewModel.isViewingCachedData)

        await viewModel.syncWithServer(modelContext: context)

        XCTAssertEqual(server.sessionReads.count, 2)
        XCTAssertFalse(viewModel.isViewingCachedData)
    }

    func testRetryForegroundAndPullToRefreshJoinTheSessionLoadInFlight() async throws {
        let context = try makeOfflineRecoveryContext()
        let requestStarted = expectation(description: "recovery read started")
        let releaseResponse = DispatchSemaphore(value: 0)
        let server = ScriptedSessionServer(reachableFromRead: 2) { read in
            guard read == 2 else { return }
            requestStarted.fulfill()
            XCTAssertEqual(releaseResponse.wait(timeout: .now() + .seconds(5)), .success)
        }
        let viewModel = try makeViewModel(handler: server.handle)
        await viewModel.loadMessages(modelContext: context)
        XCTAssertTrue(viewModel.isViewingCachedData)

        let pullToRefresh = Task { await viewModel.refreshSession(modelContext: context, isUserRefresh: true) }
        await fulfillment(of: [requestStarted], timeout: 5)
        await viewModel.recoverWhenServerReturns(modelContext: context, sleep: RecordingRetryTicks(allowed: 1).sleep)
        let foregroundReturn = Task { await viewModel.syncWithServer(modelContext: context) }
        let initialLoad = Task { await viewModel.refreshSession(modelContext: context) }
        releaseResponse.signal()
        await pullToRefresh.value
        await foregroundReturn.value
        await initialLoad.value

        XCTAssertEqual(server.sessionReads.count, 2, "Every trigger shares the one read in flight")
        XCTAssertFalse(viewModel.isViewingCachedData)
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Fresh question", "Fresh answer"])
    }

    private func makeOfflineRecoveryContext() throws -> ModelContext {
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
        return context
    }
}

/// A server that drops `GET /api/session` with a connectivity error until read `reachableFromRead`.
private final class ScriptedSessionServer: @unchecked Sendable {
    let sessionReads = LockedCounter()
    let backgroundReads = LockedCounter()
    let streamStatusReads = LockedCounter()
    private let reachableFromRead: Int
    private let hasRunningTurn: Bool
    private let onSessionRead: (Int) -> Void

    init(reachableFromRead: Int, hasRunningTurn: Bool = false, onSessionRead: @escaping (Int) -> Void = { _ in }) {
        self.reachableFromRead = reachableFromRead
        self.hasRunningTurn = hasRunningTurn
        self.onSessionRead = onSessionRead
    }

    func handle(_ request: URLRequest) throws -> (HTTPURLResponse, Data) {
        switch request.url?.path {
        case "/api/session":
            let read = sessionReads.increment()
            onSessionRead(read)
            guard read >= reachableFromRead else { throw URLError(.notConnectedToInternet) }
            return apiTestJSONResponse(hasRunningTurn ? Self.runningTranscript : Self.freshTranscript, for: request)
        case "/api/chat/stream/status":
            _ = streamStatusReads.increment()
            return apiTestJSONResponse(#"{"active": true, "stream_id": "stream-live", "replay_available": true}"#, for: request)
        case "/api/background/tasks":
            _ = backgroundReads.increment()
            return apiTestJSONResponse(#"{"session_id":"session-abc","agent_available":true,"tasks":[]}"#, for: request)
        default:
            XCTFail("Unexpected request: \(request.url?.path ?? "nil")")
            throw URLError(.badURL)
        }
    }

    private static let freshTranscript = """
    {"session": {"session_id": "session-abc", "title": "Planning", "messages": [
      {"role": "user", "content": "Fresh question", "timestamp": 1770000100, "message_id": "fresh-user"},
      {"role": "assistant", "content": "Fresh answer", "timestamp": 1770000101, "message_id": "fresh-assistant"}
    ]}}
    """

    private static let runningTranscript = """
    {"session": {"session_id": "session-abc", "title": "Planning", "active_stream_id": "stream-live", "messages": [
      {"role": "user", "content": "Fresh question", "timestamp": 1770000100, "message_id": "fresh-user"}
    ]}}
    """
}

/// Stands in for the retry clock: returns at once for `allowed` ticks, then reports cancellation.
@MainActor
private final class RecordingRetryTicks {
    private(set) var durations: [Duration] = []
    private let allowed: Int

    init(allowed: Int) {
        self.allowed = allowed
    }

    func sleep(_ duration: Duration) async throws {
        durations.append(duration)
        guard durations.count <= allowed else { throw CancellationError() }
    }
}
