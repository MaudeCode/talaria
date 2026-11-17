import XCTest
@testable import TalariaKit

final class ToolProgressTests: XCTestCase {
    /// TAL-2340: a running call's timer counts from the server's start in the run chip's units, and leaves once it ends.
    func testRunningCallTimerCountsFromTheServerStartUntilItEnds() throws {
        let english = Locale(identifier: "en_US")
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let event = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"bg","name":"terminal","started_at":1700000000}"#.utf8))
        var call = ToolCall(id: "bg", name: "terminal", preview: nil, args: nil)
        call.timerStart = event.startedAt
        XCTAssertEqual(ToolCallStatusDisplay.runningElapsed(for: call, now: start.addingTimeInterval(34.6), locale: english), "34s")
        XCTAssertEqual(ToolCallStatusDisplay.runningElapsed(for: call, now: start.addingTimeInterval(125), locale: english), "2m")
        // A row without the server's start never shows a clock that would restart when the row is rebuilt.
        XCTAssertNil(ToolCallStatusDisplay.runningElapsed(for: ToolCall(id: "old", name: "terminal", preview: nil, args: nil), now: start))
        let completion = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"bg","name":"terminal","duration":35.2,"process_id":"proc_0123456789ab"}"#.utf8))
        let done = call.applyingCompletionPayload(completion)
        XCTAssertNil(ToolCallStatusDisplay.runningElapsed(for: done, now: start.addingTimeInterval(40), locale: english))
        XCTAssertEqual(done.processID, "proc_0123456789ab")
    }

    /// TAL-2340: a settled scene row names the background process its call started.
    func testSceneToolRowNamesTheProcessItStarted() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let message = try decoder.decode(ChatMessage.self, from: Data(#"{"role":"assistant","content":"","_anchor_activity_scene":{"version":"activity_scene_v1","terminal_state":"completed","activity_rows":[{"row_id":"tool:bg","role":"tool","tool":{"id":"bg","name":"terminal","done":true,"process_id":"proc_0123456789ab"}},{"row_id":"tool:fg","role":"tool","tool":{"id":"fg","name":"terminal","done":true}}]}}"#.utf8))
        let calls = try XCTUnwrap(AssistantActivityTimeline.authoritativeScene(message: message)?.toolCalls)
        XCTAssertEqual(calls.map(\.processID), ["proc_0123456789ab", nil])
    }

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
        let model = try makeReloadedToolProgressModel(stream: stream)
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

    /// TAL-2340: a live call keeps the server's start for its timer and, on completion, the process it started.
    func testLiveToolFramesCarryTheServerStartAndTheStartedProcess() async throws {
        let stream = SpySSEStreamingClient()
        let model = try makeReloadedToolProgressModel(stream: stream)
        await model.loadMessages()
        await model.reconnectStreamIfNeeded()
        stream.emit(SSEEventDecoder.decode(eventType: "tool", data: #"{"id":"bg","name":"terminal","started_at":1700000000}"#))
        XCTAssertEqual(model.liveToolCalls.last?.timerStart, 1_700_000_000)
        stream.emit(SSEEventDecoder.decode(eventType: "tool_complete", data: #"{"id":"bg","name":"terminal","duration":0.2,"process_id":"proc_0123456789ab"}"#))
        let call = try XCTUnwrap(model.liveToolCalls.last)
        XCTAssertEqual([call.isCompleted ? "done" : "running", call.processID], ["done", "proc_0123456789ab"])
    }

    func testTerminationClearsReloadedSceneProgressWithoutAnotherToolFrame() async throws {
        for (name, terminal) in [("stream_end", SSEEvent.streamEnd), ("cancelled", .cancelled), ("error", .error("synthetic failure"))] {
            let stream = SpySSEStreamingClient()
            let model = try makeReloadedToolProgressModel(stream: stream)
            await model.loadMessages()
            await model.reconnectStreamIfNeeded()
            let originalScene = try XCTUnwrap(model.messages.last?.activityScene)
            func calls() -> [ToolCall] {
                guard let message = model.messages.first(where: { $0.messageId == "reply" }) else { return [] }
                let liveAnchors = [model.streamingAssistantMessageID, model.toolCallAnchorMessageID, model.reasoningAnchorMessageID]
                return AssistantTurnLayout(
                    message: message,
                    liveRows: liveAnchors.contains("reply") ? model.liveActivityRows : [],
                    archivedRows: model.archivedActivityRowsForAnchor("reply")
                ).rows.flatMap(\.toolCalls)
            }
            XCTAssertTrue(model.liveToolCalls.isEmpty)
            XCTAssertEqual(calls().first?.progress?.percent, 42)
            stream.emit(terminal)
            XCTAssertNil(model.activeStreamID)
            XCTAssertEqual(calls().count, 1, name)
            let call = try XCTUnwrap(calls().first)
            XCTAssertNil(ToolCallStatusDisplay(toolCall: call).progressText, "\(name) retained the persisted scene's progress")
            XCTAssertEqual(model.messages.first(where: { $0.messageId == "reply" })?.activityScene, originalScene)
        }
    }
}
