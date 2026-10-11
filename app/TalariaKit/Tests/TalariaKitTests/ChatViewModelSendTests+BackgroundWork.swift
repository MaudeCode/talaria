import XCTest
@testable import TalariaKit

/// TAL-372: background work is the server's shared record, never a device-local message.
@MainActor
extension ChatViewModelSendTests {
    private final class BackgroundLog: @unchecked Sendable {
        var tasks = #"{"session_id":"session-abc","agent_available":true,"tasks":[]}"#
        var taskReads = 0
        var notFound = 0
        var dismissed: [String] = []
        /// Every request path, in order: background work reads only the routes the server ships.
        var paths: [String] = []
        /// The tasks route answers 404, as for a session the server does not serve.
        var tasksRouteMissing = false
    }

    private func backgroundViewModel(_ log: BackgroundLog) throws -> ChatViewModel {
        try makeViewModel(
            sessionSummary: try makeSession(),
            pollingIntervals: ChatPollingIntervals(approvalNanoseconds: 1_000_000_000, clarificationNanoseconds: 1_000_000_000, backgroundNanoseconds: 1_000_000)
        ) { request in
            log.paths.append(request.url?.path ?? "")
            switch request.url?.path ?? "" {
            case "/api/background":
                return apiTestJSONResponse(#"{"ok":true,"task_id":"task-1","stream_id":"stream-bg","session_id":"background-1"}"#, for: request)
            case "/api/background/tasks":
                log.taskReads += 1
                if log.tasksRouteMissing {
                    log.notFound += 1
                    return apiTestJSONResponse(#"{"error":"not found"}"#, statusCode: 404, for: request)
                }
                return apiTestJSONResponse(log.tasks, for: request)
            case "/api/background/result":
                return apiTestJSONResponse(#"{"task_id":"task-1","text":"All tests pass."}"#, for: request)
            case "/api/background/dismiss":
                if let data = apiTestBodyData(from: request), let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let id = body["task_id"] as? String {
                    log.dismissed.append(id)
                }
                return apiTestJSONResponse(#"{"ok":true,"task":{"task_id":"task-1","kind":"background_command","status":"completed","title":"audit tests","pinned":false,"dismissible":false}}"#, for: request)
            default:
                return apiTestJSONResponse(#"{}"#, for: request)
            }
        }
    }

    func testAFinishedBackgroundTaskIsNeverADeviceLocalAssistantMessage() async throws {
        let log = BackgroundLog()
        log.tasks = #"{"session_id":"session-abc","agent_available":true,"tasks":[{"task_id":"task-1","kind":"background_command","status":"completed","title":"audit tests","result_available":true,"pinned":true,"dismissible":true}]}"#
        let viewModel = try backgroundViewModel(log)
        let before = viewModel.messages.count
        _ = await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "background")), args: "audit tests")
        try await waitUntil { log.taskReads > 0 }
        await drainMainActor()
        XCTAssertEqual(viewModel.messages.count, before)
        XCTAssertFalse(viewModel.messages.contains { ($0.content ?? "").contains("All tests pass.") })
    }

    func testABackgroundStartShowsTheServerRecordAndReadsOnlyTheTasksRoute() async throws {
        let log = BackgroundLog()
        log.tasks = #"{"session_id":"session-abc","agent_available":true,"tasks":[{"task_id":"task-1","kind":"background_command","status":"running","title":"audit tests","pinned":true,"dismissible":false,"active":true}]}"#
        let viewModel = try backgroundViewModel(log)
        _ = await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "background")), args: "audit tests")
        XCTAssertEqual(viewModel.pinnedBackgroundTasks.map(\.taskId), ["task-1"])
        log.tasks = #"{"session_id":"session-abc","agent_available":true,"tasks":[{"task_id":"task-1","kind":"background_command","status":"completed","title":"audit tests","result_available":true,"pinned":true,"dismissible":true}]}"#
        try await waitUntil { viewModel.backgroundTasks.first?.status == .completed }
        XCTAssertEqual(Set(log.paths), ["/api/background", "/api/background/tasks"])
    }

    func testA404FromTheTasksRouteKeepsTheShownRecordsAndStartsNoOtherPolling() async throws {
        let log = BackgroundLog()
        log.tasks = #"{"session_id":"session-abc","agent_available":true,"tasks":[{"task_id":"d1","kind":"delegation","status":"running","title":"Fix CI","pinned":true,"dismissible":false,"active":true}]}"#
        let viewModel = try backgroundViewModel(log)
        await viewModel.refreshBackgroundTasks()
        log.tasksRouteMissing = true
        let before = viewModel.messages.count
        _ = await viewModel.executeSlashCommand(try XCTUnwrap(SlashCommandCatalog.command(named: "background")), args: "audit tests")
        // The start's refresh and the card's poll each read the 404, and the poll stops; any other route fails below.
        try await waitUntil { log.notFound >= 2 || Set(log.paths).count > 2 }
        await drainMainActor()
        let reads = log.paths.count
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(log.paths.count, reads, "Nothing polls after the 404")
        XCTAssertEqual(Set(log.paths), ["/api/background", "/api/background/tasks"])
        XCTAssertEqual(viewModel.pinnedBackgroundTasks.map(\.taskId), ["d1"])
        XCTAssertEqual(viewModel.messages.count, before)
    }

    func testTheCardShowsWhatTheServerPinsWithItsResultAndDismissAsksTheServer() async throws {
        let log = BackgroundLog()
        log.tasks = #"{"session_id":"session-abc","agent_available":true,"tasks":[{"task_id":"task-1","kind":"background_command","status":"completed","title":"audit tests","result_available":true,"pinned":true,"dismissible":true},{"task_id":"d-old","kind":"delegation","status":"completed","title":"Old","pinned":false,"dismissible":false}]}"#
        let viewModel = try backgroundViewModel(log)
        await viewModel.refreshBackgroundTasks()
        XCTAssertEqual(viewModel.backgroundTasks.map(\.taskId), ["task-1", "d-old"])
        XCTAssertEqual(viewModel.pinnedBackgroundTasks.map(\.taskId), ["task-1"])
        let result = await viewModel.backgroundResult(taskID: "task-1")
        XCTAssertEqual(result, "All tests pass.")

        log.tasks = #"{"session_id":"session-abc","agent_available":true,"tasks":[{"task_id":"task-1","kind":"background_command","status":"completed","title":"audit tests","pinned":false,"dismissible":false}]}"#
        await viewModel.dismissBackgroundTask(taskID: "task-1")
        XCTAssertEqual(log.dismissed, ["task-1"])
        XCTAssertTrue(viewModel.pinnedBackgroundTasks.isEmpty)
        XCTAssertEqual(viewModel.backgroundTasks.map(\.taskId), ["task-1"])
    }

    func testActiveWorkRefreshesUntilItSettlesEvenWhileItsStatusIsUnknown() async throws {
        let log = BackgroundLog()
        // The Agent was briefly unreachable: the work shows unknown (and dismissible) but is still active.
        log.tasks = #"{"session_id":"session-abc","agent_available":false,"tasks":[{"task_id":"d1","kind":"delegation","status":"unknown","title":"Fix CI","pinned":true,"dismissible":true,"active":true}]}"#
        let viewModel = try backgroundViewModel(log)
        await viewModel.refreshBackgroundTasks()
        XCTAssertEqual(viewModel.pinnedBackgroundTasks.first?.status, .unknown)
        log.tasks = #"{"session_id":"session-abc","agent_available":true,"tasks":[{"task_id":"d1","kind":"delegation","status":"completed","title":"Fix CI","pinned":false,"dismissible":false}]}"#
        try await waitUntil { viewModel.backgroundTasks.first?.status == .completed }
        let reads = log.taskReads
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(log.taskReads, reads, "Nothing running: the card stops refreshing")
        XCTAssertTrue(viewModel.pinnedBackgroundTasks.isEmpty)
    }
}
