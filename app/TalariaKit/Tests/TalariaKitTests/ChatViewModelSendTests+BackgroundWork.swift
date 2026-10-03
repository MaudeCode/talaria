import XCTest
@testable import TalariaKit

/// TAL-372: background work is the server's shared record, never a device-local message.
@MainActor
extension ChatViewModelSendTests {
    private final class BackgroundLog: @unchecked Sendable {
        var tasks = #"{"session_id":"session-abc","agent_available":true,"tasks":[]}"#
        var statusReads = 0
        var taskReads = 0
        var dismissed: [String] = []
    }

    private func backgroundViewModel(_ log: BackgroundLog) throws -> ChatViewModel {
        try makeViewModel(
            sessionSummary: try makeSession(),
            pollingIntervals: ChatPollingIntervals(approvalNanoseconds: 1_000_000_000, clarificationNanoseconds: 1_000_000_000, backgroundNanoseconds: 1_000_000)
        ) { request in
            switch request.url?.path ?? "" {
            case "/api/background":
                return apiTestJSONResponse(#"{"ok":true,"task_id":"task-1","stream_id":"stream-bg","session_id":"background-1"}"#, for: request)
            case "/api/background/status":
                // An older App polled this and turned each result into a local assistant message.
                log.statusReads += 1
                return apiTestJSONResponse(#"{"results":[{"task_id":"task-1","prompt":"audit tests","answer":"All tests pass.","completed_at":1}]}"#, for: request)
            case "/api/background/tasks":
                log.taskReads += 1
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
        try await waitUntil { log.statusReads + log.taskReads > 0 }
        await drainMainActor()
        XCTAssertEqual(viewModel.messages.count, before)
        XCTAssertFalse(viewModel.messages.contains { ($0.content ?? "").contains("All tests pass.") })
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

    func testRunningWorkRefreshesUntilItFinishes() async throws {
        let log = BackgroundLog()
        log.tasks = #"{"session_id":"session-abc","agent_available":true,"tasks":[{"task_id":"d1","kind":"delegation","status":"running","title":"Fix CI","pinned":true,"dismissible":false}]}"#
        let viewModel = try backgroundViewModel(log)
        await viewModel.refreshBackgroundTasks()
        XCTAssertEqual(viewModel.pinnedBackgroundTasks.first?.status, .running)
        log.tasks = #"{"session_id":"session-abc","agent_available":true,"tasks":[{"task_id":"d1","kind":"delegation","status":"completed","title":"Fix CI","pinned":false,"dismissible":false}]}"#
        try await waitUntil { viewModel.backgroundTasks.first?.status == .completed }
        let reads = log.taskReads
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(log.taskReads, reads, "Nothing running: the card stops refreshing")
        XCTAssertTrue(viewModel.pinnedBackgroundTasks.isEmpty)
    }
}
