import XCTest
@testable import TalariaKit

/// TAL-2332: the server groups a turn's reasoning and tool rows, counts each group and merges repeated calls; the app
/// splits and names its groups from those fields and never counts calls itself when they are present. A server-merged
/// run shows as one row of its calls, and live frames carry their group and its latest record.
final class ActivityGroupTests: XCTestCase {
    private func message(rows: String, groups: String) throws -> ChatMessage {
        let scene = #"{"version":"activity_scene_v1","final_answer":"Done.","activity_rows":[\#(rows)],"activity_groups":[\#(groups)]}"#
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(ChatMessage.self, from: Data(#"{"role":"assistant","content":"Done.","message_id":"m","_anchor_activity_scene":\#(scene)}"#.utf8))
    }

    private func tool(_ id: String, kind: String = "read", group: String, merged: String = "") -> String {
        #"{"row_id":"tool:\#(id)","role":"tool","group_id":"\#(group)"\#(merged),"tool":{"id":"\#(id)","name":"read_file","kind":"\#(kind)","target":"\#(id).txt","preview":null,"done":true,"is_error":false,"duration":null,"cost_usd":null}}"#
    }

    private func segments(_ message: ChatMessage) -> [[AssistantActivityRow]] {
        let layout = AssistantTurnLayout(message: message, liveRows: [], archivedRows: [])
        return CompletedAssistantTurn(rows: layout.rows)?.workSegments.compactMap { segment in
            guard case .activity(let rows) = segment.content else { return nil }
            return rows
        } ?? []
    }

    func testSplitsAndNamesGroupsFromTheServerRecord() throws {
        // The record counts more than these rows show (a paged-out call) and a failure; the header follows the record.
        let groups = #"{"group_id":"group:0","parts":[{"kind":"talaria","count":5,"failed":0}],"failed":0,"running":false},"#
            + #"{"group_id":"group:1","parts":[{"kind":"read","count":3,"failed":1},{"kind":"web","count":1,"failed":0}],"failed":1,"running":false}"#
        let message = try message(rows: [tool("a", group: "group:0"), tool("b", group: "group:0"), tool("c", group: "group:1")].joined(separator: ","), groups: groups)
        let split = segments(message)
        XCTAssertEqual(split.map { $0.flatMap(\.toolCalls).map(\.id) }, [["a", "b"], ["c"]], "Two server groups with no prose between them stay two groups")
        XCTAssertEqual(split.map { AssistantActivityHeaderSummary.title(for: $0, isActive: false) }, ["Used Talaria tools", "Failed to read a file, searched the web"])
    }

    func testMergedRunShowsAsOneRowOfItsCalls() throws {
        let rows = [
            tool("a", group: "group:0", merged: #","merged_count":3"#),
            tool("b", group: "group:0", merged: #","merged_into":"tool:a""#),
            tool("c", group: "group:0", merged: #","merged_into":"tool:a""#),
            tool("d", kind: "shell", group: "group:0"),
        ].joined(separator: ",")
        let message = try message(rows: rows, groups: #"{"group_id":"group:0","parts":[{"kind":"read","count":3,"failed":0},{"kind":"shell","count":1,"failed":0}],"failed":0,"running":false}"#)
        let calls = segments(message).flatMap { $0.flatMap(\.toolCalls) }
        let runs = ToolCallRun.runs(calls)
        XCTAssertEqual(runs.map { $0.calls.map(\.id) }, [["a", "b", "c"], ["d"]])
        XCTAssertEqual(runs.map(\.mergedCount), [3, nil])
        XCTAssertEqual(AssistantActivitySummary.mergedTitle(for: runs[0].calls[0], count: 3), "Read files")
        // A merged row and one other call still make two rows, so the group keeps its header.
        XCTAssertTrue(AssistantActivityGroupPolicy.requiresGroup(for: segments(message)[0]))
        // A call whose merged row is not loaded shows on its own.
        XCTAssertEqual(ToolCallRun.runs(Array(calls.dropFirst())).map(\.calls.count), [1, 1, 1])
    }

    func testLiveFramesCarryTheGroupAndItsLatestRecord() throws {
        let decode = { (json: String) in try JSONDecoder().decode(ToolStreamEvent.self, from: Data(json.utf8)) }
        let start = try decode(#"{"id":"a","name":"read_file","kind":"read","group_id":"group:0","group":{"group_id":"group:0","parts":[{"kind":"read","count":1,"failed":0}],"failed":0,"running":true}}"#)
        let next = try decode(#"{"id":"b","name":"web_search","kind":"web","group_id":"group:0","group":{"group_id":"group:0","parts":[{"kind":"read","count":1,"failed":0},{"kind":"web","count":1,"failed":0}],"failed":0,"running":true}}"#)
        let reasoning = try JSONDecoder().decode(ReasoningStreamEvent.self, from: Data(#"{"text":"plan","group_id":"group:1"}"#.utf8))
        XCTAssertEqual(reasoning.groupID, "group:1")
        var timeline = AssistantActivityTimeline()
        timeline.appendReasoning("look", groupID: "group:0")
        timeline.appendTool(ToolCall(id: "a", name: start.name, preview: nil, args: nil, kind: start.kind), groupID: start.groupID, group: start.group)
        timeline.appendTool(ToolCall(id: "b", name: next.name, preview: nil, args: nil, kind: next.kind), groupID: next.groupID, group: next.group)
        timeline.appendReasoning(reasoning.text, groupID: reasoning.groupID)
        XCTAssertEqual(timeline.rows.map(\.groupID), ["group:0", "group:0", "group:1"])
        XCTAssertEqual(timeline.rows.first?.group, next.group, "Every row of a group takes its latest record")
        XCTAssertEqual(AssistantActivityHeaderSummary.title(for: Array(timeline.rows.prefix(2)), isActive: false), "Reading a file, searching the web")
    }
}
