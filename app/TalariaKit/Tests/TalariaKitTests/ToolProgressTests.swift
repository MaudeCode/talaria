import XCTest
@testable import TalariaKit

final class ToolProgressTests: XCTestCase {
    func testSharedProgressFixtureDecodesStreamAndRunningScene() throws {
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("tool-progress")) as? [String: Any])
        let frame = try XCTUnwrap(fixture["running"] as? [String: Any])
        let data = try JSONSerialization.data(withJSONObject: XCTUnwrap(frame["data"]))
        guard case .toolProgress(let event) = SSEEventDecoder.decode(eventType: "tool_progress", data: String(decoding: data, as: UTF8.self)) else {
            return XCTFail("Expected tool progress")
        }
        XCTAssertEqual(event.stableID, "call-index")
        XCTAssertEqual(event.progress?.percent, 42)
        XCTAssertEqual(event.progress?.message, "indexing files")
        let tool = try JSONSerialization.data(withJSONObject: XCTUnwrap(fixture["tool"]))
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        for field in [String(decoding: tool, as: UTF8.self), #"{"id":"call-index","name":"mcp__index","done":false}"#] {
            let message = try decoder.decode(ChatMessage.self, from: Data(#"{"role":"assistant","content":"","_anchor_activity_scene":{"version":"activity_scene_v1","terminal_state":"running","activity_rows":[{"row_id":"row","role":"tool","tool":\#(field)}]}}"#.utf8))
            let call = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message)?.toolCalls.first)
            XCTAssertEqual(call.progress, field.contains("progress") ? event.progress : nil)
        }
        for field in ["", #","progress":null"#, #","progress":"bad""#] {
            let event = try decoder.decode(ToolStreamEvent.self, from: Data("{\"id\":\"call-index\"\(field)}".utf8))
            XCTAssertNil(event.progress)
        }
    }

    func testProgressFormattingUsesExistingStatusDisplayAndHidesCompletedProgress() throws {
        for (json, expected) in [
            (#"{"percent":42,"message":"indexing"}"#, "42% · indexing"),
            (#"{"percent":42,"message":null}"#, "42%"),
            (#"{"percent":null,"message":"indexing"}"#, "indexing"),
            (#"{"percent":null,"message":null}"#, nil)
        ] {
            var call = ToolCall(name: "mcp__index", preview: nil, args: nil,
                                progress: try JSONDecoder().decode(ToolProgress.self, from: Data(json.utf8)))
            XCTAssertEqual(ToolCallStatusDisplay(toolCall: call).progressText, expected)
            call.isCompleted = true
            XCTAssertNil(ToolCallStatusDisplay(toolCall: call).progressText)
        }
    }
}

@MainActor
extension ChatViewModelSendTests {
    func testToolProgressUpdatesReloadedRunningSceneAndClearsWithoutDuplicates() async throws {
        let stream = SpySSEStreamingClient()
        let model = try makeViewModel(streamClient: stream) { request in
            if request.url?.path == "/api/session" {
                return apiTestJSONResponse(#"{"session":{"session_id":"session-abc","active_stream_id":"run-tools","messages":[{"role":"user","content":"Index files","message_id":"prompt"},{"role":"assistant","content":"","message_id":"reply","_anchor_activity_scene":{"version":"activity_scene_v1","terminal_state":"running","activity_rows":[{"row_id":"row","role":"tool","tool":{"id":"call-index","name":"mcp__index","done":false,"progress":{"percent":42,"message":"indexing"}}}]}}]}}"#, for: request)
            }
            return apiTestJSONResponse(#"{"active":true}"#, for: request)
        }
        await model.loadMessages()
        await model.reconnectStreamIfNeeded()
        let message = try XCTUnwrap(model.messages.last)
        func calls() -> [ToolCall] {
            AssistantTurnLayout(message: message, liveRows: model.liveActivityRows, archivedRows: []).rows.flatMap(\.toolCalls)
        }
        XCTAssertEqual(calls().first?.progress?.percent, 42)
        func progress(_ value: String, id: String = "call-index") {
            stream.emit(SSEEventDecoder.decode(eventType: "tool_progress", data: "{\"id\":\"\(id)\",\"progress\":\(value)}"))
        }
        progress(#"{"percent":80,"message":"indexing"}"#)
        XCTAssertEqual(calls().count, 1)
        XCTAssertEqual(calls().first?.progress?.percent, 80)
        progress("null")
        XCTAssertNil(calls().first?.progress)
        progress(#"{"percent":90,"message":null}"#)
        progress(#"{"percent":99,"message":null}"#, id: "unknown")
        XCTAssertEqual(calls().count, 1)
        XCTAssertEqual(calls().first?.progress?.percent, 90)
        stream.emit(SSEEventDecoder.decode(eventType: "tool_complete", data: #"{"id":"call-index","progress":null}"#))
        XCTAssertTrue(calls().first?.isCompleted == true)
        XCTAssertNil(calls().first?.progress)
        progress(#"{"percent":99,"message":null}"#)
        XCTAssertNil(calls().first?.progress)
        stream.emit(SSEEventDecoder.decode(eventType: "tool", data: #"{"id":"second","name":"mcp__index","progress":{"percent":10,"message":null}}"#))
        XCTAssertEqual(model.liveToolCalls.last?.progress?.percent, 10)
        stream.emit(.streamEnd)
        XCTAssertNil(model.liveToolCalls.last?.progress)
    }
}
