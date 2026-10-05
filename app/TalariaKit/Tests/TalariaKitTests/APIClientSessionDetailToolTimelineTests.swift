import XCTest
@testable import TalariaKit

extension APIClientSessionDetailTests {
func testToolCallGroupAnchorLookupReturnsGroupsByAnchor() {
    let firstAssistantGroup = ToolCallGroup(
        id: "group-a",
        anchorMessageID: "assistant-a",
        toolCalls: [
            ToolCall(id: "tool-a", name: "read_file", preview: nil, args: nil)
        ]
    )
    let transcriptTailGroup = ToolCallGroup(
        id: "group-tail",
        anchorMessageID: nil,
        toolCalls: [
            ToolCall(id: "tool-tail", name: "terminal", preview: nil, args: nil)
        ]
    )
    let secondAssistantGroup = ToolCallGroup(
        id: "group-b",
        anchorMessageID: "assistant-b",
        toolCalls: [
            ToolCall(id: "tool-b", name: "search_files", preview: nil, args: nil)
        ]
    )
    let secondGroupForFirstAssistant = ToolCallGroup(
        id: "group-a-2",
        anchorMessageID: "assistant-a",
        toolCalls: [
            ToolCall(id: "tool-a-2", name: "apply_patch", preview: nil, args: nil)
        ]
    )

    let lookup = ToolCallGroupAnchorLookup(groups: [
        firstAssistantGroup,
        transcriptTailGroup,
        secondAssistantGroup,
        secondGroupForFirstAssistant
    ])

    XCTAssertEqual(lookup.groups(anchorMessageID: "assistant-a").map(\.id), ["group-a", "group-a-2"])
    XCTAssertEqual(lookup.groups(anchorMessageID: "assistant-b").map(\.id), ["group-b"])
    XCTAssertEqual(lookup.groups(anchorMessageID: nil).map(\.id), ["group-tail"])
    XCTAssertTrue(lookup.groups(anchorMessageID: "missing").isEmpty)
}

func testMessageToolCallsGroupFromTheServerResolvedFields() {
    let messages = [
        ChatMessage(
            role: "assistant",
            content: "",
            timestamp: 1_770_000_001,
            messageId: "assistant-tools",
            toolCalls: [
                .object([
                    "id": .string("call-1"),
                    "function": .object([
                        "name": .string("terminal"),
                        "arguments": .string(#"{"command":"make test"}"#)
                    ]),
                    "done": .bool(true),
                    "is_error": .bool(true),
                    "duration": .number(3.5),
                    "result": .string(#"{"exit_code": 2}"#)
                ]),
                .object([
                    "id": .string("call-2"),
                    "function": .object([
                        "name": .string("read_file"),
                        "arguments": .string(#"{"path":"README.md"}"#)
                    ]),
                    "done": .bool(false),
                    "is_error": .bool(false),
                    "duration": .null,
                    "result": .null
                ])
            ]
        ),
        // A tool row is never paired on the client: the server's `result` is the card's preview.
        ChatMessage(
            role: "tool",
            content: "unpaired",
            timestamp: 1_770_000_002,
            messageId: "tool-result-1",
            toolCallId: "call-2"
        )
    ]

    let groups = ToolCallGroup.groups(messages: messages, messageOffset: nil)

    XCTAssertEqual(groups.count, 1)
    XCTAssertEqual(groups.first?.id, "persisted-tools-assistant-tools")
    XCTAssertEqual(groups.first?.anchorMessageID, "assistant-tools")
    XCTAssertEqual(groups.first?.toolCalls.map(\.id), ["call-1", "call-2"])
    XCTAssertEqual(groups.first?.toolCalls.map(\.name), ["terminal", "read_file"])
    XCTAssertEqual(groups.first?.toolCalls.map(\.preview), [#"{"exit_code": 2}"#, nil])
    XCTAssertEqual(groups.first?.toolCalls.map(\.isError), [true, false])
    XCTAssertEqual(groups.first?.toolCalls.map(\.duration), [3.5, nil])
    XCTAssertEqual(groups.first?.toolCalls.map(\.isCompleted), [true, false])
    XCTAssertEqual(groups.first?.toolCalls.first?.args?["command"], .string("make test"))
    XCTAssertEqual(groups.first?.hasFailedTool, true)
    XCTAssertEqual(groups.first?.isComplete, false)
}

func testOlderServerToolCallsShowCompletedWithoutOutcome() {
    let messages = [
        ChatMessage(
            role: "assistant",
            content: "",
            timestamp: 1_770_000_001,
            messageId: "assistant-tools",
            toolCalls: [
                .object([
                    "id": .string("call-1"),
                    "function": .object(["name": .string("terminal"), "arguments": .string(#"{"command":"pwd"}"#)])
                ])
            ]
        )
    ]

    let call = ToolCallGroup.groups(messages: messages, messageOffset: nil).first?.toolCalls.first

    XCTAssertEqual(call?.isCompleted, true)
    XCTAssertNil(call?.isError)
    XCTAssertNil(call?.duration)
    XCTAssertNil(call?.preview)
}
func testContentArrayDisplaysTextAndPreservesToolParts() throws {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let message = try decoder.decode(ChatMessage.self, from: Data("""
    {
      "role": "assistant",
      "message_id": "assistant-array",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu-1",
          "name": "search_files",
          "input": { "pattern": "*.md" }
        },
        {
          "type": "text",
          "text": "File search finished."
        }
      ]
    }
    """.utf8))

    XCTAssertEqual(message.content, "File search finished.")
    XCTAssertEqual(message.contentParts?.count, 2)
}

func testToolCallStatusDisplayHidesCompletedCollapsedText() {
    let display = ToolCallStatusDisplay(
        toolCall: ToolCall(
            name: "terminal",
            preview: nil,
            args: nil,
            duration: 1.24,
            isCompleted: true
        )
    )

    XCTAssertNil(display.collapsedText)
    XCTAssertEqual(display.detailText, "Completed in 1.2s")
}

func testToolCallStatusDisplayShowsRunningCollapsedText() {
    let display = ToolCallStatusDisplay(
        toolCall: ToolCall(
            name: "search_files",
            preview: nil,
            args: nil,
            isCompleted: false
        )
    )

    XCTAssertEqual(display.collapsedText, "Running")
    XCTAssertEqual(display.detailText, "Running")
}

func testToolCallStatusDisplayShowsFailedCollapsedText() {
    let display = ToolCallStatusDisplay(
        toolCall: ToolCall(
            name: "skill_view",
            preview: nil,
            args: nil,
            duration: 0.8,
            isError: true,
            isCompleted: true
        )
    )

    XCTAssertEqual(display.collapsedText, "Failed")
    XCTAssertEqual(display.detailText, "Failed")
}

func testToolCallDisplayFormatterRendersServerResultSectionsInOrder() {
    func result(_ view: ToolResultView?, kind: ToolDisplayKind? = .web) -> ToolCallResultDisplay? {
        ToolCallDisplayFormatter.content(
            for: ToolCall(name: "tool", preview: "flat preview", args: nil, kind: kind, resultView: view)
        ).result
    }

    let terminal = result(ToolResultView(stdout: "a\nb", stderr: "warn", error: "boom", exitCode: 1))
    XCTAssertEqual(terminal?.title, "Result")
    XCTAssertEqual(terminal?.text, "a\nb\nwarn\nError: boom\nExit code: 1")
    XCTAssertEqual(terminal?.isMonospaced, true)
    XCTAssertEqual(result(ToolResultView(stderr: "only stderr", exitCode: 2))?.text, "only stderr\nExit code: 2")
    XCTAssertEqual(result(ToolResultView(exitCode: 0))?.text, "Exit code: 0")
    XCTAssertEqual(result(ToolResultView(error: "denied"))?.text, "Error: denied")
    let text = result(ToolResultView(text: "line one\nline two"))
    XCTAssertEqual(text?.text, "line one\nline two")
    XCTAssertEqual(text?.isMonospaced, false)
    XCTAssertEqual(result(ToolResultView(text: "Sat Sep 27"), kind: .shell)?.isMonospaced, true)
    // An empty view shows no result, even when a preview exists.
    XCTAssertNil(result(ToolResultView()))
}

func testToolCallDisplayFormatterShowsAnOlderServersPreviewAsSent() {
    let preview = #"{"output":"line one\nline two\n","exit_code":0}"#
    let display = ToolCallDisplayFormatter.content(
        for: ToolCall(name: "terminal", preview: preview, args: nil, kind: .web)
    ).result

    XCTAssertEqual(display?.text, preview)
    XCTAssertEqual(display?.isMonospaced, false)
}

func testToolStreamEventDecodesTheServerResultView() throws {
    let data = Data(#"{"id":"call-make","name":"terminal","preview":"built","result_view":{"stdout":"built","stderr":"warn","exit_code":2}}"#.utf8)
    let event = try JSONDecoder().decode(ToolStreamEvent.self, from: data)
    XCTAssertEqual(event.resultView, ToolResultView(stdout: "built", stderr: "warn", exitCode: 2))
    let completed = ToolCall(id: "call-make", name: "terminal", preview: nil, args: nil).applyingCompletionPayload(event)
    XCTAssertEqual(ToolCallDisplayFormatter.content(for: completed).result?.text, "built\nwarn\nExit code: 2")
}

func testToolStreamEventCarriesAFileEditsDiffOntoItsCall() throws {
    let data = Data(#"{"id":"call-patch","name":"patch","kind":"write","target":"a.txt","edit_diff":{"added":2,"removed":1,"diff":"@@ -1 +1,2 @@\n-a\n+b\n+c","truncated":true}}"#.utf8)
    let event = try JSONDecoder().decode(ToolStreamEvent.self, from: data)
    let expected = ToolEditDiff(added: 2, removed: 1, diff: "@@ -1 +1,2 @@\n-a\n+b\n+c", truncated: true)
    XCTAssertEqual(event.editDiff, expected)
    let completed = ToolCall(id: "call-patch", name: "patch", preview: nil, args: nil).applyingCompletionPayload(event)
    XCTAssertEqual(completed.editDiff, expected)
    // A malformed field is dropped, never fatal to the frame.
    let malformed = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"x","name":"patch","edit_diff":{"diff":"d"}}"#.utf8))
    XCTAssertNil(malformed.editDiff)
    XCTAssertEqual(malformed.name, "patch")
}

func testToolCallDisplayFormatterShowsNestedArgumentsReadably() {
    let rows = ToolCallDisplayFormatter.argumentRows(from: [
        "input": .object([
            "path": .string("Sources"),
            "options": .object([
                "recursive": .bool(true)
            ]),
            "patterns": .array([
                .string("*.swift"),
                .string("*.md")
            ])
        ])
    ])

    XCTAssertEqual(rows.first?.key, "input")
    XCTAssertEqual(rows.first?.value, """
    options:
      recursive: true
    path: Sources
    patterns:
      - *.swift
      - *.md
    """)
}

func testOpenAIToolRowsWithNilMessageIDsUseRawIndexAnchors() {
    let finalAnswer = "Both tools are operational."
    let messages = [
        ChatMessage(
            role: "user",
            content: "Use terminal and search files",
            timestamp: nil,
            messageId: nil
        ),
        ChatMessage(
            role: "assistant",
            content: "",
            timestamp: nil,
            messageId: nil,
            toolCalls: [
                .object([
                    "id": .string("functions.terminal:1"),
                    "function": .object([
                        "name": .string("terminal"),
                        "arguments": .string(#"{"command":"ls -la"}"#)
                    ])
                ])
            ],
            reasoning: "The user wants me to use terminal and search_files. I should run a quick command to show both work."
        ),
        ChatMessage(
            role: "tool",
            content: #"{"success":true,"output":"81 entries"}"#,
            timestamp: nil,
            messageId: nil,
            toolCallId: "functions.terminal:1"
        ),
        ChatMessage(
            role: "assistant",
            content: "",
            timestamp: nil,
            messageId: nil,
            toolCalls: [
                .object([
                    "id": .string("functions.search_files:2"),
                    "function": .object([
                        "name": .string("search_files"),
                        "arguments": .string(#"{"pattern":"config.yaml"}"#)
                    ])
                ])
            ],
            reasoning: "Terminal works. Now run search_files to show that works too."
        ),
        ChatMessage(
            role: "tool",
            content: #"{"success":true,"total_count":5}"#,
            timestamp: nil,
            messageId: nil,
            toolCallId: "functions.search_files:2"
        ),
        ChatMessage(
            role: "assistant",
            content: finalAnswer,
            timestamp: nil,
            messageId: nil,
            reasoning: """
            The user wants me to use terminal and search_files. I should run a quick command to show both work.
            Terminal works. Now run search_files to show that works too.
            Both tools worked. I should give a concise summary.

            \(finalAnswer)
            """
        )
    ]

    let groups = ToolCallGroup.groups(messages: messages, messageOffset: 4)
    let reasoningGroups = ChatViewModel.reasoningDisplayGroups(
        messages: messages,
        messageOffset: 4,
        archivedGroups: []
    )
    let transcriptMessages = ChatViewModel.transcriptMessages(from: messages, messageOffset: 4)

    XCTAssertEqual(transcriptMessages.map(\.anchorID), ["raw:4", "raw:9"])
    XCTAssertEqual(
        transcriptMessages.last?.assistantSegments.map(\.anchorID),
        ["raw:5", "raw:7", "raw:9"]
    )
    let groupedTimeline = AssistantActivityTimeline.persisted(
        assistantSegments: transcriptMessages.last?.assistantSegments ?? [],
        reasoningGroups: reasoningGroups,
        toolCallGroups: groups
    )
    XCTAssertEqual(groupedTimeline.toolCalls.map(\.name), ["terminal", "search_files"])
    XCTAssertEqual(CompletedAssistantTurn(rows: groupedTimeline.rows)?.finalAnswer, finalAnswer)
    XCTAssertEqual(groups.count, 2)
    XCTAssertEqual(groups.map(\.anchorMessageID), ["raw:5", "raw:7"])
    XCTAssertEqual(groups.map { $0.toolCalls.map(\.id) }, [["functions.terminal:1"], ["functions.search_files:2"]])
    XCTAssertEqual(groups.map { $0.toolCalls.map(\.name) }, [["terminal"], ["search_files"]])
    XCTAssertEqual(reasoningGroups.map(\.anchorMessageID), ["raw:5", "raw:7", "raw:9"])
    XCTAssertEqual(reasoningGroups[0].text, "The user wants me to use terminal and search_files. I should run a quick command to show both work.")
    XCTAssertEqual(reasoningGroups[1].text, "Terminal works. Now run search_files to show that works too.")
    XCTAssertTrue(reasoningGroups[2].text.contains("Both tools worked. I should give a concise summary."))
    XCTAssertFalse(reasoningGroups[2].text.contains(finalAnswer))
}

func testLiveToolCallGroupUsesStableAnchorKeyAndPreservesToolIDs() {
    let toolCalls = [
        ToolCall(
            id: "terminal-1",
            name: "terminal",
            preview: "Running tests",
            args: nil,
            isCompleted: false
        ),
        ToolCall(
            id: "read-file-1",
            name: "read_file",
            preview: "File contents",
            args: nil,
            isError: true,
            isCompleted: true
        )
    ]

    let anchoredGroup = ToolCallGroup.live(
        anchorMessageID: "assistant-live",
        toolCalls: toolCalls
    )
    let unanchoredGroup = ToolCallGroup.live(
        anchorMessageID: nil,
        toolCalls: toolCalls
    )

    XCTAssertEqual(anchoredGroup.id, "live-tools-assistant-live")
    XCTAssertEqual(anchoredGroup.anchorMessageID, "assistant-live")
    XCTAssertEqual(anchoredGroup.activityTitle, "Activity: 2 tools")
    XCTAssertEqual(anchoredGroup.toolCalls.map(\.id), ["terminal-1", "read-file-1"])
    XCTAssertEqual(anchoredGroup.isComplete, false)
    XCTAssertEqual(anchoredGroup.hasFailedTool, true)
    XCTAssertEqual(unanchoredGroup.id, "live-tools-unanchored")
}

}
