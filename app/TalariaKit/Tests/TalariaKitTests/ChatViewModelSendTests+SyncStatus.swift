import SwiftData
import XCTest
@testable import TalariaKit

// TAL-436: "Syncing messages" tracks a populated transcript's reconcile with the server.
@MainActor
extension ChatViewModelSendTests {
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
