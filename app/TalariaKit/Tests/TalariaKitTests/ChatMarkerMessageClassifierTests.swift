import XCTest
@testable import TalariaKit

/// The server classifies compaction markers and stamps `_marker_kind` (TAL-305); the app decodes it and never reads the text.
final class ChatMarkerMessageClassifierTests: XCTestCase {
    func testDecodesTheServersCompactionMarker() throws {
        let message = try decode(#"{"role":"user","content":"[CONTEXT COMPACTION] Summary","_marker_kind":"context_compaction"}"#)
        XCTAssertEqual(message.markerKind, .contextCompaction)
        XCTAssertNil(message.markerBody)
    }

    func testDecodesTheServersPreservedTaskListAndItsBody() throws {
        let message = try decode(#"{"role":"user","content":"[Your active task list was preserved across context compression]\n- one","_marker_kind":"preserved_task_list","_marker_body":"- one"}"#)
        XCTAssertEqual(message.markerKind, .preservedTaskList)
        XCTAssertEqual(message.markerBody, "- one")
    }

    func testUnstampedMarkerTextIsAnOrdinaryMessage() throws {
        for content in ["[CONTEXT COMPACTION] typed by hand", "Context compaction is how the Agent shortens history.", "[Your active task list was preserved across context compression]"] {
            XCTAssertNil(try decode(#"{"role":"user","content":"\#(content)"}"#).markerKind, content)
        }
    }

    func testAnUnknownKindFromANewerServerIsAnOrdinaryMessage() throws {
        let message = try decode(#"{"role":"user","content":"x","_marker_kind":"future_kind","_marker_body":"y"}"#)
        XCTAssertNil(message.markerKind)
        XCTAssertNil(message.markerBody)
    }

    func testAnAssistantMarkerStaysOutOfTheTurnAroundIt() {
        let messages = [
            ChatMessage(role: "user", content: "Go", timestamp: 1, messageId: "u", turnId: "t"),
            ChatMessage(role: "assistant", content: "One", timestamp: 2, messageId: "a1", turnId: "t"),
            ChatMessage(role: "assistant", content: "[context compaction] summary", timestamp: 3, messageId: "m", turnId: "t", markerKind: .contextCompaction),
            ChatMessage(role: "assistant", content: "Two", timestamp: 4, messageId: "a2", turnId: "t"),
        ]
        let rows = ChatViewModel.transcriptMessages(from: messages)
        XCTAssertEqual(rows.map { $0.message.messageId }, ["u", "a1", "m", "a2"])
        XCTAssertEqual(rows.map { $0.assistantSegments.count }, [0, 1, 0, 1])
    }

    private func decode(_ json: String) throws -> ChatMessage {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(ChatMessage.self, from: Data(json.utf8))
    }
}
