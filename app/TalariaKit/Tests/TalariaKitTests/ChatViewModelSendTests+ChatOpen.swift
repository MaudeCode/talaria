import XCTest
import SwiftData
@testable import TalariaKit

/// TAL-839: a chat open sends its transcript request while the chat appears, then loads the composer's controls
/// together, so it reaches a ready composer in the fewest serial round trips.
@MainActor
extension ChatViewModelSendTests {
    func testChatOpenSendsTheTranscriptBeforeItAppearsAndReachesAReadyComposerInFourRoundTrips() async throws {
        let trips = HeldRoundTrips()
        let viewModel = try makeHeldViewModel(trips)
        let context = try makeContext()

        // ChatView's open: the chat appears, then `performInitialAsyncWork` runs.
        viewModel.prepareInitialMessageLoad(modelContext: context)
        viewModel.prefetchInitialMessages()
        let beforeAppearance = await trips.nextRoundTrip()
        beforeAppearance.forEach(Self.answerChatOpen)
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(viewModel.messages.isEmpty, "The transcript must not apply before the chat has appeared")

        let isReady = LockedTestValue(false)
        let open = Task {
            await viewModel.loadInitialMessages(modelContext: context)
            await viewModel.reconnectStreamIfNeeded(modelContext: context)
            await viewModel.refreshBackgroundTasks()
            await viewModel.loadComposerStartup()
            isReady.value = true
        }
        var roundTrips: [[String]] = []
        while true {
            let trip = await trips.nextRoundTrip(isDone: { isReady.value })
            guard !trip.isEmpty, roundTrips.count < 12 else { break }
            roundTrips.append(trip.map(\.path).sorted())
            trip.forEach(Self.answerChatOpen)
        }
        await open.value

        XCTAssertEqual(beforeAppearance.map(\.path), ["/api/session"])
        XCTAssertEqual(roundTrips, [
            ["/api/background/tasks"],
            ["/api/profiles", "/api/session/yolo"],
            ["/api/commands", "/api/models", "/api/workspaces"],
            ["/api/reasoning"],
        ])
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Opened"])
        XCTAssertEqual(viewModel.agentCommands.map(\.name), ["status"])
        XCTAssertEqual(viewModel.selectedReasoningEffort, "medium")
        XCTAssertEqual(viewModel.workspaceSuggestions, ["/tmp/workspace"])
    }

    func testInitialLoadRefetchesATranscriptReadBeforeARunStarted() async throws {
        let trips = HeldRoundTrips()
        let viewModel = try makeHeldViewModel(trips)
        let context = try makeContext()
        viewModel.prepareInitialMessageLoad(modelContext: context)
        viewModel.prefetchInitialMessages()
        let prefetch = await trips.nextRoundTrip()
        prefetch.forEach(Self.answerChatOpen)

        // The user sends before the chat finished appearing: the prefetched read predates that run.
        let send = Task { await viewModel.sendMessage("Run this", modelContext: context) }
        let start = await trips.nextRoundTrip()
        XCTAssertEqual(start.map(\.path), ["/api/chat/start"])
        start.forEach { $0.complete(withJSON: #"{"session_id":"session-abc","stream_id":"run-1"}"#) }
        _ = await send.value
        XCTAssertEqual(viewModel.activeStreamID, "run-1")

        let load = Task { await viewModel.loadInitialMessages(modelContext: context) }
        let refetch = await trips.nextRoundTrip()
        XCTAssertEqual(refetch.map(\.path), ["/api/session"], "A read from before the run must be refetched")
        refetch.forEach { $0.complete(withJSON: #"{"session":{"session_id":"session-abc","active_stream_id":"run-1","messages":[{"role":"user","content":"Run this","message_id":"prompt"}]}}"#) }
        await load.value
        XCTAssertEqual(viewModel.activeStreamID, "run-1", "The refetched read must keep the run the prefetch predates")
    }

    func testRefreshDuringThePrefetchCancelsIt() async throws {
        let trips = HeldRoundTrips()
        let viewModel = try makeHeldViewModel(trips)
        let context = try makeContext()
        viewModel.prepareInitialMessageLoad(modelContext: context)
        viewModel.prefetchInitialMessages()
        let prefetched = await trips.nextRoundTrip()
        let prefetch = try XCTUnwrap(prefetched.first)

        let refresh = Task { await viewModel.loadMessages(modelContext: context, isUserRefresh: true) }
        let refreshed = await trips.nextRoundTrip()
        XCTAssertEqual(refreshed.map(\.path), ["/api/session"])
        refreshed.forEach(Self.answerChatOpen)
        await refresh.value
        XCTAssertTrue(prefetch.isStopped, "A refresh must cancel the prefetched request")

        let load = Task { await viewModel.loadInitialMessages(modelContext: context) }
        let reload = await trips.nextRoundTrip()
        XCTAssertEqual(reload.map(\.path), ["/api/session"], "A discarded prefetch must not answer the initial load")
        reload.forEach(Self.answerChatOpen)
        await load.value
        XCTAssertEqual(viewModel.messages.compactMap(\.content), ["Opened"])
    }

    func testLeavingTheChatCancelsThePrefetch() async throws {
        let trips = HeldRoundTrips()
        let viewModel = try makeHeldViewModel(trips)
        viewModel.prepareInitialMessageLoad(modelContext: try makeContext())
        viewModel.prefetchInitialMessages()
        let prefetched = await trips.nextRoundTrip()
        let prefetch = try XCTUnwrap(prefetched.first)

        viewModel.suspendStreamForNavigation()

        for _ in 0..<200 where !prefetch.isStopped {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(prefetch.isStopped, "Leaving the chat must cancel the prefetched request")
    }

    private func makeHeldViewModel(_ trips: HeldRoundTrips) throws -> ChatViewModel {
        let host = "chat-open-\(UUID().uuidString.lowercased()).test"
        DeferredMockURLProtocol.setOnRequest(trips.hold, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        return try makeViewModel(server: try XCTUnwrap(URL(string: "https://\(host)")),
                                 protocolClasses: [DeferredMockURLProtocol.self]) { _ in
            throw URLError(.badURL)
        }
    }

    private static func answerChatOpen(_ request: DeferredMockURLProtocol) {
        switch request.path {
        case "/api/session":
            request.complete(withJSON: #"{"session":{"session_id":"session-abc","messages":[{"role":"assistant","content":"Opened","message_id":"opened"}]}}"#)
        case "/api/profiles":
            request.complete(withJSON: #"{"active":"default","profiles":[{"name":"default","model":"gpt-5.4","is_default":true}]}"#)
        case "/api/models":
            request.complete(withJSON: #"{"default_model":"gpt-5.4","groups":[]}"#)
        case "/api/reasoning":
            request.complete(withJSON: #"{"reasoning_effort":"medium"}"#)
        case "/api/workspaces":
            request.complete(withJSON: #"{"workspaces":[{"path":"/tmp/workspace"}],"last":"/tmp/workspace"}"#)
        case "/api/commands":
            request.complete(withJSON: #"{"commands":[{"name":"status"}]}"#)
        case "/api/session/yolo":
            request.complete(withJSON: #"{"ok":true,"yolo_enabled":false}"#)
        default:
            request.complete(withJSON: "{}")
        }
    }
}
