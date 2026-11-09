import XCTest
@testable import TalariaKit

/// TAL-1580: the server's delegation delivery summary in Background Work, from the shared
/// `contracts/fixtures/delegation-status.json` answers. The App shows what the server decided and reads nothing else.
@MainActor
extension ChatViewModelSendTests {
    /// One `delegation_status` from the shared fixture, as a JSON object.
    static func delegationStatusFixture(_ key: String) throws -> [String: Any] {
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("delegation-status")) as? [String: Any])
        return try XCTUnwrap(fixture[key] as? [String: Any], key)
    }

    /// A `/api/background/tasks` answer with no rows and, unless nil, the fixture's summary (nil is a server older than it).
    static func delegationTasksAnswer(_ status: [String: Any]?) throws -> String {
        var answer: [String: Any] = ["session_id": "session-abc", "tasks": [], "pinned_count": 0, "agent_available": true]
        answer["delegation_status"] = status
        return String(decoding: try JSONSerialization.data(withJSONObject: answer), as: UTF8.self)
    }

    private func decodedDelegationStatus(_ status: [String: Any]?) throws -> DelegationStatus? {
        try APIClient.responseDecoder().decode(BackgroundTasksResponse.self, from: Data(try Self.delegationTasksAnswer(status).utf8)).delegationStatus
    }

    func testDelegationStatusDecodesTheSharedFixturesWithoutReadingMissingCountsAsZero() throws {
        let running = try XCTUnwrap(decodedDelegationStatus(try Self.delegationStatusFixture("running")))
        XCTAssertEqual(running, DelegationStatus(availability: .available, runningCount: 2, awaitingDeliveryCount: 0, memoryLive: true, visible: true, refresh: true))
        let awaiting = try XCTUnwrap(decodedDelegationStatus(try Self.delegationStatusFixture("awaiting_delivery")))
        XCTAssertEqual(awaiting, DelegationStatus(availability: .available, runningCount: 0, awaitingDeliveryCount: 1, memoryLive: false, visible: true, refresh: true))
        let zero = try XCTUnwrap(decodedDelegationStatus(try Self.delegationStatusFixture("available_zero")))
        XCTAssertEqual(zero, DelegationStatus(availability: .available, runningCount: 0, awaitingDeliveryCount: 0, memoryLive: false, visible: true, refresh: false))
        let unknown = try XCTUnwrap(decodedDelegationStatus(try Self.delegationStatusFixture("unknown")))
        XCTAssertEqual(unknown, DelegationStatus(availability: .unknown, runningCount: nil, awaitingDeliveryCount: nil, memoryLive: nil, visible: true, refresh: false))
        let unsupported = try XCTUnwrap(decodedDelegationStatus(try Self.delegationStatusFixture("unsupported")))
        XCTAssertEqual(unsupported.availability, .unsupported)
        XCTAssertNil(unsupported.runningCount)
        XCTAssertNil(unsupported.awaitingDeliveryCount)
        XCTAssertFalse(try XCTUnwrap(decodedDelegationStatus(try Self.delegationStatusFixture("hidden"))).visible)

        XCTAssertNil(try decodedDelegationStatus(nil), "A server older than the summary sends none")
        var future = try Self.delegationStatusFixture("unknown")
        future["availability"] = "paused"
        XCTAssertEqual(try decodedDelegationStatus(future)?.availability, .unrecognized("paused"))
    }

    final class DelegationStatusLog: @unchecked Sendable {
        var tasks: String
        var paths: [String] = []
        var taskReads: Int { paths.filter { $0 == "/api/background/tasks" }.count }
        init(tasks: String) { self.tasks = tasks }
    }

    private func delegationStatusViewModel(_ log: DelegationStatusLog) throws -> ChatViewModel {
        try makeViewModel(
            pollingIntervals: ChatPollingIntervals(approvalNanoseconds: 1_000_000_000, clarificationNanoseconds: 1_000_000_000, backgroundNanoseconds: 10_000_000)
        ) { request in
            let path = request.url?.path ?? ""
            log.paths.append(path)
            switch path {
            case "/api/background/tasks": return apiTestJSONResponse(log.tasks, for: request)
            case "/api/profile/switch": return apiTestJSONResponse(#"{"active":"work"}"#, for: request)
            default: return apiTestJSONResponse(#"{}"#, for: request)
            }
        }
    }

    /// A completion awaiting delivery outlives its row: the App keeps reading while the server says the summary may
    /// change, and only reads. Nothing is routed, claimed or acknowledged.
    func testAServerSummaryAwaitingDeliveryKeepsReadingAfterTheRowsFinish() async throws {
        let log = DelegationStatusLog(tasks: try Self.delegationTasksAnswer(try Self.delegationStatusFixture("awaiting_delivery")))
        let viewModel = try delegationStatusViewModel(log)
        await viewModel.refreshBackgroundTasks()
        try await waitUntil { log.taskReads >= 3 }
        XCTAssertGreaterThanOrEqual(log.taskReads, 3, "No active row remains, yet the server's summary asks for refreshes")
        XCTAssertEqual(Set(log.paths), ["/api/background/tasks"], "Reading the summary wrote something")
        viewModel.cleanupPollingTasks()
    }

    func testTheSummaryShowsWhatTheServerDecidesAndStopsReadingWhenItSettles() async throws {
        let log = DelegationStatusLog(tasks: try Self.delegationTasksAnswer(try Self.delegationStatusFixture("awaiting_delivery")))
        let viewModel = try delegationStatusViewModel(log)
        await viewModel.refreshBackgroundTasks()
        XCTAssertEqual(viewModel.backgroundDelegationSummary?.awaitingDeliveryCount, 1)
        XCTAssertTrue(viewModel.showsBackgroundWorkEntry, "Nothing is pinned, yet the awaiting completion must stay reachable")

        log.tasks = try Self.delegationTasksAnswer(try Self.delegationStatusFixture("available_zero"))
        try await waitUntil { viewModel.backgroundDelegationSummary?.refresh == false }
        XCTAssertEqual(viewModel.backgroundDelegationSummary?.runningCount, 0)
        XCTAssertTrue(viewModel.showsBackgroundWorkEntry, "The server still shows the settled summary")
        let settled = log.taskReads
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(log.taskReads, settled, "A settled summary keeps polling")

        log.tasks = try Self.delegationTasksAnswer(try Self.delegationStatusFixture("hidden"))
        await viewModel.refreshBackgroundTasks()
        XCTAssertNil(viewModel.backgroundDelegationSummary, "The server hid the summary")
        XCTAssertFalse(viewModel.showsBackgroundWorkEntry)

        log.tasks = try Self.delegationTasksAnswer(try Self.delegationStatusFixture("unknown"))
        await viewModel.refreshBackgroundTasks()
        XCTAssertEqual(viewModel.backgroundDelegationSummary?.availability, .unknown)
        log.tasks = "{"
        await viewModel.refreshBackgroundTasks()
        XCTAssertEqual(viewModel.backgroundDelegationSummary?.availability, .unknown, "A failed read keeps what is shown")
        log.tasks = try Self.delegationTasksAnswer(nil)
        await viewModel.refreshBackgroundTasks()
        XCTAssertNil(viewModel.backgroundDelegationSummary, "An older server's answer shows no summary")
    }

    /// A profile switch clears the summary, and a read sent for the old profile that arrives afterwards shows nothing.
    func testASummaryReadBeforeAProfileSwitchNeverShows() async throws {
        let awaiting = try Self.delegationTasksAnswer(try Self.delegationStatusFixture("awaiting_delivery"))
        let reads = DeferredRequests()
        let host = "delegation-profile.test"
        DeferredMockURLProtocol.setOnRequest({ request in
            switch request.request.url?.path ?? "" {
            case "/api/background/tasks": _ = reads.append(request)
            case "/api/profile/switch": request.complete(withJSON: #"{"active":"work"}"#)
            default: request.complete(withJSON: #"{}"#)
            }
        }, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let viewModel = try makeViewModel(
            pollingIntervals: ChatPollingIntervals(approvalNanoseconds: 1_000_000_000, clarificationNanoseconds: 1_000_000_000, backgroundNanoseconds: 60_000_000_000),
            server: try XCTUnwrap(URL(string: "https://\(host)")),
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { _ in
            XCTFail("The deferred transport answers every request")
            throw URLError(.badURL)
        }

        let first = Task { await viewModel.refreshBackgroundTasks() }
        try await waitUntil { reads.count == 1 }
        reads.request(at: 0).complete(withJSON: awaiting)
        await first.value
        XCTAssertNotNil(viewModel.backgroundDelegationSummary)

        let delayed = Task { await viewModel.refreshBackgroundTasks() }
        try await waitUntil { reads.count == 2 }
        let work = try APIClient.responseDecoder().decode(ProfileSummary.self, from: Data(#"{"name":"work"}"#.utf8))
        _ = await viewModel.switchProfile(work, startNewSession: false)
        XCTAssertNil(viewModel.backgroundDelegationSummary, "The old profile's summary still shows")
        reads.request(at: 1).complete(withJSON: awaiting)
        await delayed.value
        XCTAssertNil(viewModel.backgroundDelegationSummary, "A read for the old profile arrived late and showed its summary")
        XCTAssertFalse(viewModel.showsBackgroundWorkEntry)
        viewModel.cleanupPollingTasks()
    }
}
