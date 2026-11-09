import XCTest
@testable import TalariaKit

// TAL-1761: a running delegated subagent's transcript has no stream of its own; its detail's `refresh_after` says when
// to read it again, and the settled detail clears it.
@MainActor
extension ChatViewModelSendTests {
    func testARunningSubagentRereadsOnTheServersDelayUntilItSettles() async throws {
        let reads = LockedCounter()
        let running = try Self.subagentDetail("running", scene: "running", answer: "")
        let settled = try Self.subagentDetail("settled", scene: "completed", answer: "All fixed.")
        let viewModel = try makeViewModel { request in
            XCTAssertEqual(request.url?.path, "/api/session")
            return apiTestJSONResponse(reads.increment() == 1 ? running : settled, for: request)
        }
        await viewModel.loadMessages()
        XCTAssertEqual(viewModel.serverRefreshAfter, 5)

        let ticks = RecordingRetryTicks(allowed: 5)
        await viewModel.followServerRefresh(sleep: ticks.sleep)

        XCTAssertEqual(ticks.durations, [.seconds(5)], "One reread on the server's delay, then none once it clears")
        XCTAssertEqual(reads.count, 2)
        XCTAssertNil(viewModel.serverRefreshAfter)
        XCTAssertEqual(viewModel.messages.last?.activityScene?.terminalState, "completed", "The settled scene replaces the running one")
        XCTAssertEqual(viewModel.messages.last?.activityScene?.finalAnswer, "All fixed.")
    }

    func testADetailWithoutRefreshAfterSchedulesNoReread() async throws {
        let reads = LockedCounter()
        let viewModel = try makeViewModel { request in
            _ = reads.increment()
            return apiTestJSONResponse(#"{"session":{"session_id":"session-abc","read_only":true,"messages":[{"role":"user","content":"Question"}]}}"#, for: request)
        }
        await viewModel.loadMessages()

        let ticks = RecordingRetryTicks(allowed: 5)
        await viewModel.followServerRefresh(sleep: ticks.sleep)

        XCTAssertNil(viewModel.serverRefreshAfter)
        XCTAssertEqual(ticks.durations, [], "An older server omits the field and nothing rereads")
        XCTAssertEqual(reads.count, 1)
    }

    /// Closing the chat or leaving the app cancels the task that follows the server's delay.
    func testCancellingCancelsThePendingReread() async throws {
        let reads = LockedCounter()
        let running = try Self.subagentDetail("running", scene: "running", answer: "")
        let viewModel = try makeViewModel { request in
            _ = reads.increment()
            return apiTestJSONResponse(running, for: request)
        }
        await viewModel.loadMessages()
        let waiting = expectation(description: "waiting on the server's delay")
        let loop = Task {
            await viewModel.followServerRefresh { duration in
                waiting.fulfill()
                try await Task.sleep(for: duration * 1_000)
            }
        }
        await fulfillment(of: [waiting], timeout: 5)
        loop.cancel()
        await loop.value

        XCTAssertEqual(reads.count, 1, "The pending reread never ran")
    }

    /// The shared fixture's `key` detail with a prompt and a last turn whose scene ended in `scene`.
    private static func subagentDetail(_ key: String, scene: String, answer: String) throws -> String {
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("running-subagent")) as? [String: Any])
        var session = try XCTUnwrap(fixture[key] as? [String: Any])
        session["messages"] = [
            ["role": "user", "content": "Fix the parser", "message_id": "goal", "_turn_id": "turn"],
            ["role": "assistant", "content": answer, "message_id": "reply", "_turn_id": "turn",
             "_anchor_activity_scene": ["version": "activity_scene_v1", "terminal_state": scene, "final_answer": answer,
                                        "expanded_by_default": scene == "running", "activity_rows": [
                                            ["row_id": "tool:read", "order_index": 0, "role": "tool",
                                             "tool": ["id": "read", "name": "read_file", "kind": "read", "target": "parser.swift", "args": [:],
                                                      "done": scene != "running", "is_error": false]]
                                        ]]]
        ]
        return String(decoding: try JSONSerialization.data(withJSONObject: ["session": session]), as: UTF8.self)
    }
}
