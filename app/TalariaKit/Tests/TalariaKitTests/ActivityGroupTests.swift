import XCTest
@testable import TalariaKit

/// TAL-2332: the server groups a turn's reasoning and tool rows, counts each group and merges repeated calls; the app
/// splits and names its groups from those fields and never counts calls itself when they are present.
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
}
