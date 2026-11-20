import XCTest
@testable import TalariaKit

/// TAL-2333: an approval's held call and a delegation row's subagents, from the shared
/// `contracts/fixtures/tool-approval-and-agents.json` the Web contract tests parse too.
final class ToolApprovalAndAgentsFixtureTests: XCTestCase {
    private func fixture(_ key: String) throws -> Data {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let all = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: root.appendingPathComponent("contracts/fixtures/tool-approval-and-agents.json")))
        return try JSONEncoder().encode(XCTUnwrap(all[key]))
    }

    func testApprovalDecodesItsHeldCallAsARunningToolRowThroughEveryDecoder() throws {
        let snake = JSONDecoder()
        snake.keyDecodingStrategy = .convertFromSnakeCase
        for decoder in [JSONDecoder(), snake] {
            let write = try decoder.decode(PendingApproval.self, from: fixture("approval_write"))
            let tool = try XCTUnwrap(write.tool)
            XCTAssertEqual(tool.kind, .write)
            XCTAssertEqual(tool.target, "/etc/hosts")
            XCTAssertFalse(tool.isCompleted)
            XCTAssertEqual(tool.argsFields?.map(\.key), ["path", "content"])
            XCTAssertEqual(tool.argsFields?.last?.multiline, true)
            XCTAssertEqual(AssistantActivitySummary.label(for: tool), "Editing /etc/hosts")
            XCTAssertEqual(write.description, "Protected path")

            let shell = try XCTUnwrap(decoder.decode(PendingApproval.self, from: fixture("approval_shell")).tool)
            XCTAssertEqual(shell.kind, .shell)
            XCTAssertNil(shell.argsFields)

            let app = try XCTUnwrap(decoder.decode(PendingApproval.self, from: fixture("approval_mcp")).tool)
            XCTAssertEqual(app.app?.name, "Linear")
            XCTAssertEqual(AssistantActivitySummary.label(for: app), "Linear · Create issue")
        }
        XCTAssertNil(try JSONDecoder().decode(PendingApproval.self, from: Data(#"{"approval_id":"old","command":"ls"}"#.utf8)).tool)
    }

    /// TAL-974: an older server sends the Agent's keys without `scope`, so the help names the keys Always would save; a
    /// server with the field never shows them, and a one-time prompt (`scope: null`) offers no help.
    func testScopeHelpNamesAnOlderServersKeysAndNeverTheCurrentServersOwn() throws {
        func sentence(_ json: String) throws -> String? {
            let pending = try JSONDecoder().decode(PendingApproval.self, from: Data(json.utf8))
            return ApprovalPromptState(sessionID: "synthetic-scope", pending: pending, pendingCount: 1).scopeSentence
        }
        XCTAssertEqual(try sentence(#"{"approval_id":"old","pattern_keys":["pipe to shell","network_download"]}"#),
                       "Allow session and Always allow cover these pattern keys: pipe to shell, network_download.")
        XCTAssertNil(try sentence(#"{"approval_id":"old-none","command":"ls"}"#))
        XCTAssertNil(try sentence(#"{"approval_id":"once","pattern_key":"protected_instruction_file","scope":null}"#))
        XCTAssertEqual(try sentence(#"{"approval_id":"new","pattern_key":"execute_code","allowed_choices":["once","session"],"scope":{"kind":"python","subject":null,"always_is_session_only":false}}"#),
                       "Allow session covers every Python script for this session.")
    }

    /// A voice or Shortcuts Allow confirms the server's `allow_text`, never the question or reason shown as `description`;
    /// an older server without the field keeps its command or own description.
    func testAllowOutsideTheCardConfirmsOnlyTheServersAllowText() throws {
        let snake = JSONDecoder()
        snake.keyDecodingStrategy = .convertFromSnakeCase
        func action(_ json: String) throws -> [String?] {
            try [JSONDecoder(), snake].map { try $0.decode(PendingApproval.self, from: Data(json.utf8)).allowAction }
        }
        XCTAssertEqual(try action(#"{"approval_id":"q","description":"Allow?","allow_text":null}"#), [nil, nil])
        XCTAssertEqual(try action(#"{"approval_id":"c","command":"git push","description":"Force push","allow_text":"git push"}"#), ["git push", "git push"])
        XCTAssertEqual(try action(#"{"approval_id":"old","description":"Write /etc/hosts"}"#), ["Write /etc/hosts", "Write /etc/hosts"])
    }

    func testDelegationLinkDecodesEachSubagent() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let link = try decoder.decode(BackgroundLink.self, from: fixture("delegate_background"))
        XCTAssertEqual(link.agentsDetail, [
            .init(taskId: "call-1-1", goal: "Write docs", status: .completed, duration: 75, summary: "Docs written."),
            .init(taskId: "call-1-2", goal: "Write tests", status: .failed, duration: 4.5),
            .init(taskId: "call-1-3", goal: "Run tests", status: .running),
        ])
        let older = try decoder.decode(BackgroundLink.self, from: Data(#"{"task_ids":[],"status":"running","agents":{"total":1,"completed":0,"failed":0,"running":1}}"#.utf8))
        XCTAssertEqual(older.agentsDetail, [])
    }
}
