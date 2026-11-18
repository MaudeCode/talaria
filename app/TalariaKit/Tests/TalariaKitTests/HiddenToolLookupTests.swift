import XCTest
@testable import TalariaKit

/// TAL-2331: the server marks a tool lookup `hidden` while Settings hides them; a turn leaves it out of its rows and tool
/// group, live and settled, and shows a lookup whose completion failed.
final class HiddenToolLookupTests: XCTestCase {
    private func message(rows: String?) throws -> ChatMessage {
        let scene = rows.map { #","_anchor_activity_scene":{"version":"activity_scene_v1","final_answer":"Done.","activity_rows":[\#($0)]}"# } ?? ""
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(ChatMessage.self, from: Data(#"{"role":"assistant","content":"Done.","message_id":"m"\#(scene)}"#.utf8))
    }

    private func hiddenTool(_ id: String, _ name: String) -> String {
        #"{"row_id":"tool:\#(id)","order_index":0,"role":"tool","tool":{"id":"\#(id)","name":"\#(name)","preview":null,"done":true,"is_error":false,"duration":null,"cost_usd":null,"hidden":true}}"#
    }

    private func event(_ json: String) throws -> ToolStreamEvent {
        try JSONDecoder().decode(ToolStreamEvent.self, from: Data(json.utf8))
    }

    /// A settled turn with other calls: `SharedContractTests`, on the server's projection.
    func testSettledTurnOfOnlyHiddenCallsHasNoToolGroup() throws {
        let onlyHidden = AssistantTurnLayout(message: try message(rows: hiddenTool("h", "tool_search")), liveRows: [], archivedRows: [])
        XCTAssertEqual(onlyHidden.rows.map(\.kind), ["prose"], "A turn whose only calls are hidden has no tool group")
    }

    func testLiveTurnLeavesOutHiddenCallsAndShowsAFailedLookup() throws {
        let start = try event(#"{"id":"f","name":"tool_describe","hidden":true}"#)
        XCTAssertTrue(start.isHidden)
        XCTAssertFalse(try event(#"{"id":"r","name":"read_file"}"#).isHidden)
        var timeline = AssistantActivityTimeline()
        timeline.appendTool(ToolCall(id: "f", name: start.name, preview: nil, args: nil, isHidden: start.isHidden))
        timeline.appendTool(ToolCall(id: "r", name: "read_file", preview: nil, args: nil))
        let unsettled = try message(rows: nil)
        XCTAssertEqual(AssistantTurnLayout(message: unsettled, liveRows: timeline.rows, archivedRows: []).rows.flatMap(\.toolCalls).map(\.id), ["r"])
        let failed = try event(#"{"id":"f","name":"tool_describe","is_error":true}"#)
        XCTAssertTrue(timeline.updateTool(at: 0) { $0.applyingCompletionPayload(failed) })
        XCTAssertEqual(AssistantTurnLayout(message: unsettled, liveRows: timeline.rows, archivedRows: []).rows.flatMap(\.toolCalls).map(\.id), ["f", "r"])
    }

    /// TAL-2341: each Tool Calls switch and the Live Activity's decode from their server keys; an older server sends none.
    func testToolCallSwitchesDecodeAndAreAbsentFromAnOlderServer() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let decode = { (json: String) in try decoder.decode(SettingsResponse.self, from: Data(json.utf8)) }
        let sent = try decode(#"{"show_tool_lookups":true,"formatted_tool_results":false,"inline_tool_media":false,"tool_row_outcomes":false,"merge_repeated_tool_calls":false,"live_tool_progress":false,"status_chip_current_action":false,"turn_summary":false,"live_activity_current_tool":false}"#)
        XCTAssertEqual(sent.toolCallSettings, [
            .showToolLookups: true, .formattedToolResults: false, .inlineToolMedia: false, .toolRowOutcomes: false,
            .mergeRepeatedToolCalls: false, .liveToolProgress: false, .statusChipCurrentAction: false, .turnSummary: false,
        ])
        XCTAssertEqual(sent.liveActivityCurrentTool, false)
        let older = try decode("{}")
        XCTAssertEqual(older.toolCallSettings, [:])
        XCTAssertNil(older.liveActivityCurrentTool)
    }
}
