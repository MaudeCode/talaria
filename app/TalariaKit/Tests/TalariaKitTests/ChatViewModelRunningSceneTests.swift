import XCTest
@testable import TalariaKit

/// A running turn with no journal ships its persisted rows as a `running` scene (TAL-374); that is no outcome.
final class ChatViewModelRunningSceneTests: APIClientTestCase {
    @MainActor
    func testARunningSceneIsNotTheTurnsSettledOutcome() async throws {
        let viewModel = try makeScriptedChatViewModel(streamClient: ScriptedSSEStreamingClient()) { request in
            apiTestJSONResponse(
                #"""
                {"session": {"session_id": "session-abc", "active_stream_id": "run-r", "transcript_seq": null, "messages": [
                  {"role": "user", "content": "Earlier", "_turn_id": "legacy:0"},
                  {"role": "assistant", "content": "Earlier answer.", "message_id": "a0", "_turn_id": "legacy:0", "_anchor_activity_scene": {"version": "activity_scene_v1", "activity_rows": [], "final_answer": "Earlier answer.", "terminal_state": "completed"}},
                  {"role": "user", "content": "Read it", "_turn_id": "run-r"},
                  {"role": "assistant", "content": "Reading.", "message_id": "r1", "_turn_id": "run-r", "_anchor_activity_scene": {"version": "activity_scene_v1", "activity_rows": [{"row_id": "r1:prose", "order_index": 0, "role": "prose", "text": "Reading."}], "final_answer": "", "terminal_state": "running", "expanded_by_default": true}}
                ]}}
                """#,
                for: request
            )
        }
        await viewModel.loadMessages()

        XCTAssertEqual(viewModel.streamCoordinatorServerTerminalState(turnID: "legacy:0"), "completed")
        XCTAssertNotEqual(viewModel.streamCoordinatorServerTerminalState(turnID: "run-r"), "running")
    }
}
