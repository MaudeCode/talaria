import XCTest
@testable import TalariaKit

/// TAL-1337: an owner chat's processes and subagents in Background Work, from the server's shared
/// `contracts/fixtures/web-native-work.json` answers. The owner alone decides what a control did: the App sends each
/// control once, rereads the roster, and keeps no answer that belongs to another profile or an older owner.
@MainActor
extension ChatViewModelSendTests {
    final class OwnerWorkLog: @unchecked Sendable {
        var tasks: String
        var stop = #"{"outcome":"stopped"}"#
        var stopStatus = 200
        var steer = #"{"outcome":"queued"}"#
        var bodies: [String: [[String: Any]]] = [:]
        var taskReads = 0

        init(tasks: String) { self.tasks = tasks }
        func count(_ path: String) -> Int { bodies[path]?.count ?? 0 }
    }

    /// One `/api/background/tasks` answer (or the lost stop's 503) from the shared fixture, as JSON.
    static func ownerWorkFixture(_ key: String) throws -> String {
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("web-native-work")) as? [String: Any])
        let tasks = try XCTUnwrap(fixture["background_tasks"] as? [String: Any])
        return String(decoding: try JSONSerialization.data(withJSONObject: try XCTUnwrap(tasks[key])), as: UTF8.self)
    }

    private func ownerWorkViewModel(_ log: OwnerWorkLog) throws -> ChatViewModel {
        try makeViewModel(
            pollingIntervals: ChatPollingIntervals(approvalNanoseconds: 1_000_000_000, clarificationNanoseconds: 1_000_000_000, backgroundNanoseconds: 60_000_000_000)
        ) { request in
            let path = request.url?.path ?? ""
            if let data = apiTestBodyData(from: request), let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                log.bodies[path, default: []].append(body)
            } else {
                log.bodies[path, default: []].append([:])
            }
            switch path {
            case "/api/background/tasks":
                log.taskReads += 1
                return apiTestJSONResponse(log.tasks, for: request)
            case "/api/background/stop":
                return apiTestJSONResponse(log.stop, statusCode: log.stopStatus, for: request)
            case "/api/background/steer":
                return apiTestJSONResponse(log.steer, for: request)
            case "/api/profile/switch":
                return apiTestJSONResponse(#"{"active":"work"}"#, for: request)
            default:
                return apiTestJSONResponse(#"{}"#, for: request)
            }
        }
    }

    private func task(_ viewModel: ChatViewModel, _ title: String) throws -> BackgroundWorkTask {
        try XCTUnwrap(viewModel.backgroundTasks.first { $0.title == title }, title)
    }

    func testOwnerRostersShowTheActionsTheirOwnerAllowsAndSayWhenTheOwnerCannotBeRead() async throws {
        let log = OwnerWorkLog(tasks: try Self.ownerWorkFixture("available"))
        let viewModel = try ownerWorkViewModel(log)
        await viewModel.refreshBackgroundTasks()

        XCTAssertEqual(viewModel.backgroundOwnerWork, .available)
        XCTAssertEqual(viewModel.pinnedBackgroundTasks.map(\.title), ["Check the tests", "Read the logs", "npm run dev"])
        let resident = try task(viewModel, "Read the logs")
        XCTAssertEqual([resident.canStop, resident.canSteer, resident.resultAvailable], [true, true, true])
        // A rebuilt parent's child is listed and running, but nobody may control or tail it.
        let rebuilt = try task(viewModel, "Check the tests")
        XCTAssertEqual(rebuilt.status, .running)
        XCTAssertEqual([rebuilt.canStop, rebuilt.canSteer, rebuilt.resultAvailable], [false, false, false])
        let process = try task(viewModel, "npm run dev")
        XCTAssertEqual([process.canStop, process.canSteer], [true, false])
        XCTAssertFalse(try task(viewModel, "make build").canStop)

        log.tasks = try Self.ownerWorkFixture("unsupported")
        await viewModel.refreshBackgroundTasks()
        XCTAssertEqual(viewModel.backgroundOwnerWork, .unsupported)
        XCTAssertTrue(viewModel.backgroundTasks.isEmpty)
        log.tasks = try Self.ownerWorkFixture("unavailable")
        await viewModel.refreshBackgroundTasks()
        XCTAssertEqual(viewModel.backgroundOwnerWork, .unavailable)
    }

    func testStopAndSteerReachOnlyTheListedRowAndEveryAnswerRereadsTheOwnersRoster() async throws {
        let log = OwnerWorkLog(tasks: try Self.ownerWorkFixture("available"))
        let viewModel = try ownerWorkViewModel(log)
        await viewModel.refreshBackgroundTasks()
        let child = try task(viewModel, "Read the logs").taskId

        var reads = log.taskReads
        let stopped = await viewModel.stopBackgroundTask(taskID: child)
        XCTAssertEqual(stopped, .stopped)
        XCTAssertEqual(log.bodies["/api/background/stop"]?.last as? [String: String], ["session_id": "session-abc", "task_id": child])
        XCTAssertGreaterThan(log.taskReads, reads, "The owner's next roster shows what the stop did")

        let queued = await viewModel.steerBackgroundTask(taskID: child, text: "Look at stderr too")
        XCTAssertEqual(queued, .queued)
        XCTAssertEqual(log.bodies["/api/background/steer"]?.last as? [String: String], ["session_id": "session-abc", "task_id": child, "text": "Look at stderr too"])
        log.steer = #"{"outcome":"rejected"}"#
        let rejected = await viewModel.steerBackgroundTask(taskID: child, text: "Look at stderr too")
        XCTAssertEqual(rejected, .rejected)

        log.stop = #"{"outcome":"not_running"}"#
        let notRunning = await viewModel.stopBackgroundTask(taskID: child)
        XCTAssertEqual(notRunning, .notRunning)
        log.stop = #"{"outcome":"not_found"}"#
        reads = log.taskReads
        let notFound = await viewModel.stopBackgroundTask(taskID: child)
        XCTAssertEqual(notFound, .notFound)
        XCTAssertGreaterThan(log.taskReads, reads)
        XCTAssertEqual(log.count("/api/background/stop"), 3)
        XCTAssertEqual(log.count("/api/background/steer"), 2)
    }

    func testAStopWhoseOutcomeWasLostIsSentOnceAndTheOwnerSettlesTheRow() async throws {
        let log = OwnerWorkLog(tasks: try Self.ownerWorkFixture("available"))
        let viewModel = try ownerWorkViewModel(log)
        await viewModel.refreshBackgroundTasks()
        let server = try task(viewModel, "npm run dev").taskId

        let lost = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try Self.ownerWorkFixture("stop_unconfirmed").utf8)) as? [String: Any])
        log.stopStatus = try XCTUnwrap(lost["status"] as? Int)
        log.stop = String(decoding: try JSONSerialization.data(withJSONObject: try XCTUnwrap(lost["body"])), as: UTF8.self)
        // The owner's roster after the lost answer: the process did stop.
        log.tasks = try Self.ownerWorkFixture("settled_after_unconfirmed_stop")

        let outcome = await viewModel.stopBackgroundTask(taskID: server)
        XCTAssertEqual(outcome, .unconfirmed)
        XCTAssertEqual(log.count("/api/background/stop"), 1, "A stop whose outcome is unknown is never resent")
        let row = try task(viewModel, "npm run dev")
        XCTAssertEqual(row.taskId, server)
        XCTAssertEqual(row.status, .cancelled)
        XCTAssertFalse(row.canStop)
        XCTAssertFalse(row.active)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(log.count("/api/background/stop"), 1)
    }

    /// A view model whose requests wait until the test answers them, so replies can arrive in any order.
    private func deferredOwnerWorkViewModel(host: String, _ onRequest: @escaping (DeferredMockURLProtocol) -> Void) throws -> ChatViewModel {
        DeferredMockURLProtocol.setOnRequest(onRequest, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        return try makeViewModel(
            pollingIntervals: ChatPollingIntervals(approvalNanoseconds: 1_000_000_000, clarificationNanoseconds: 1_000_000_000, backgroundNanoseconds: 60_000_000_000),
            server: try XCTUnwrap(URL(string: "https://\(host)")),
            protocolClasses: [DeferredMockURLProtocol.self]
        ) { _ in
            XCTFail("The deferred transport answers every request")
            throw URLError(.badURL)
        }
    }

    func testARosterReadBeforeTheOwnerRestartedNeverReplacesTheNewerOne() async throws {
        let available = try Self.ownerWorkFixture("available")
        // The owner restarted between the two reads: the same work under its new authority has new ids.
        let restarted = available.replacingOccurrences(of: "owner-work-", with: "owner-work-e2-")
        let reads = DeferredRequests()
        let viewModel = try deferredOwnerWorkViewModel(host: "owner-restart.test") { request in
            guard request.request.url?.path == "/api/background/tasks" else { return request.complete(withJSON: #"{}"#) }
            _ = reads.append(request)
        }

        let older = Task { await viewModel.refreshBackgroundTasks() }
        try await waitUntil { reads.count == 1 }
        let newer = Task { await viewModel.refreshBackgroundTasks() }
        try await waitUntil { reads.count == 2 }
        reads.request(at: 1).complete(withJSON: restarted)
        await newer.value
        XCTAssertTrue(viewModel.backgroundTasks.allSatisfy { $0.taskId.hasPrefix("owner-work-e2-") })
        reads.request(at: 0).complete(withJSON: available)
        await older.value
        XCTAssertFalse(viewModel.backgroundTasks.isEmpty)
        XCTAssertTrue(viewModel.backgroundTasks.allSatisfy { $0.taskId.hasPrefix("owner-work-e2-") }, "The older roster arrived late and changes nothing")
    }

    func testAnswersThatArriveAfterAProfileSwitchChangeNothing() async throws {
        let available = try Self.ownerWorkFixture("available")
        let stops = DeferredRequests()
        let reads = LockedTestValue(0)
        let viewModel = try deferredOwnerWorkViewModel(host: "owner-profile.test") { request in
            switch request.request.url?.path ?? "" {
            case "/api/background/tasks":
                reads.value += 1
                request.complete(withJSON: available)
            case "/api/background/stop":
                _ = stops.append(request)
            case "/api/profile/switch":
                request.complete(withJSON: #"{"active":"work"}"#)
            default:
                request.complete(withJSON: #"{}"#)
            }
        }
        await viewModel.refreshBackgroundTasks()
        let child = try task(viewModel, "Read the logs").taskId

        let stop = Task { await viewModel.stopBackgroundTask(taskID: child) }
        try await waitUntil { stops.count == 1 }
        guard stops.count == 1 else { return }
        let work = try APIClient.responseDecoder().decode(ProfileSummary.self, from: Data(#"{"name":"work"}"#.utf8))
        _ = await viewModel.switchProfile(work, startNewSession: false)
        let readsBefore = reads.value
        stops.request(at: 0).complete(withJSON: #"{"outcome":"not_found"}"#)
        let outcome = await stop.value
        XCTAssertNil(outcome, "The old profile's answer is not shown in the new one")
        XCTAssertEqual(reads.value, readsBefore, "Nor does it reread on the old profile's behalf")
    }
}
