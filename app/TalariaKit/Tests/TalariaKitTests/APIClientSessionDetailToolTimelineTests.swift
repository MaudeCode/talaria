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

/// TAL-2335: a call's outcome decodes from a tool frame and a stored view; an outcome a newer server adds drops alone.
func testToolResultViewDecodesTheServerOutcome() throws {
    let event = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"call-make","name":"terminal","result_view":{"stderr":"boom","exit_code":2,"outcome":{"key":"exit","tone":"error","count":2}}}"#.utf8))
    XCTAssertEqual(event.resultView?.outcome, ToolOutcome(key: .exit, tone: .error, count: 2))
    let failed = ToolResultView(.object(["error": .string("denied"), "outcome": .object(["key": .string("failed"), "tone": .string("error"), "value": .string("Resource not accessible by integration")])]))
    XCTAssertEqual(failed?.outcome, ToolOutcome(key: .failed, tone: .error, value: "Resource not accessible by integration"))
    let newer = try XCTUnwrap(ToolResultView(.object(["text": .string("ok"), "outcome": .object(["key": .string("archived"), "tone": .string("neutral")])])))
    XCTAssertEqual(newer.text, "ok")
    XCTAssertNil(newer.outcome)
}

/// TAL-2318: the server's argument and result rows, from a tool frame and a session detail's call, win over local formatting.
func testTheCardShowsTheServerArgumentAndResultRows() throws {
    let rows = #"[{"key":"names","value":"- a\n- b","multiline":true},{"key":"limit","value":"3","multiline":false}]"#
    let result = #"{"text":"{}","fields":[{"key":"total","value":"2","multiline":false}]}"#
    let event = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"call-list","name":"session_list","args":{"limit":3,"names":["a","b"]},"args_fields":\#(rows),"result_view":\#(result)}"#.utf8))
    let completed = ToolCall(id: "call-list", name: "session_list", preview: nil, args: nil).applyingCompletionPayload(event)
    let message = ChatMessage(role: "assistant", content: "", timestamp: nil, messageId: "calls", toolCalls: [
        .object(["id": .string("call-list"), "name": .string("session_list"), "args": .object(["limit": .number(3)]), "args_fields": try JSONDecoder().decode(JSONValue.self, from: Data(rows.utf8)), "result_view": try JSONDecoder().decode(JSONValue.self, from: Data(result.utf8))])
    ])
    let persisted = try XCTUnwrap(ToolCallGroup.groups(messages: [message], messageOffset: nil).first?.toolCalls.first)
    for call in [completed, persisted] {
        let content = ToolCallDisplayFormatter.content(for: call)
        XCTAssertEqual(content.argumentRows.map(\.key), ["names", "limit"])
        XCTAssertEqual(content.argumentRows.first?.value, "- a\n- b")
        XCTAssertEqual(content.result?.rows, [ToolCallArgumentDisplay(key: "total", value: "2")])
    }
}

/// TAL-2338: the server's raw view rides a call from its start and completion frames; formatted Copy copies the rows shown.
func testTheRowCarriesTheServerRawViewAndCopiesWhatShows() throws {
    let start = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"call-list","name":"session_list","args_fields":[{"key":"limit","value":"3","multiline":false}],"raw_args":"{\n  \"limit\": 3\n}"}"#.utf8))
    let complete = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"call-list","name":"session_list","raw_result":"{\n  \"token\": \"***\"\n}","result_view":{"text":"{}","fields":[{"key":"names","value":"- a\n- b","multiline":true}]}}"#.utf8))
    let running = ToolCall(id: "call-list", name: start.name, preview: nil, args: nil, argsFields: start.argsFields, rawArgs: start.rawArgs)
    let completed = running.applyingCompletionPayload(complete)
    XCTAssertEqual(completed.rawArgs, "{\n  \"limit\": 3\n}")
    XCTAssertEqual(completed.rawResult, "{\n  \"token\": \"***\"\n}")
    XCTAssertEqual(ToolCallDisplayFormatter.copyText(for: completed), "limit: 3\n\nnames:\n- a\n- b")
    // A typed result copies as it shows, not the text it stands in for.
    let memory = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"call-memory","name":"memory","result_view":{"text":"Applied 1 operation(s).","rows":{"title":"User memory","rows":[{"label":"Added","detail":"Prefers short replies"}]}}}"#.utf8))
    let saved = ToolCall(id: "call-memory", name: "memory", preview: nil, args: nil).applyingCompletionPayload(memory)
    XCTAssertEqual(ToolCallDisplayFormatter.copyText(for: saved), "User memory\nAdded: Prefers short replies")
    // A file edit shows only its change, so Copy copies that diff, not the arguments and result it hides.
    let write = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"call-write","name":"write_file","args_fields":[{"key":"path","value":"a.txt","multiline":false}],"result_view":{"text":"{}","fields":[{"key":"bytes_written","value":"3","multiline":false}]},"edit_diff":{"added":1,"removed":0,"diff":"--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+abc","truncated":false,"hunks":[]}}"#.utf8))
    let written = ToolCall(id: "call-write", name: "write_file", preview: nil, args: nil).applyingCompletionPayload(write)
    XCTAssertNotNil(written.editDiff)
    XCTAssertEqual(ToolCallDisplayFormatter.copyText(for: written), "--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+abc")
}

/// TAL-2341: the server's Tool calls switches ride a call from its live frames and from a settled scene row; a call without
/// them (the switch on, or an older server) opens formatted with its media in view.
func testTheRowCarriesTheServerDisplayFlags() throws {
    let complete = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"call-image","name":"image_generate","opens_raw":true,"media_in_details":true}"#.utf8))
    let running = ToolCall(id: "call-image", name: "image_generate", preview: nil, args: nil)
    XCTAssertEqual(running.applyingCompletionPayload(complete).displayFlags, ToolDisplayFlags(opensRaw: true, mediaInDetails: true))
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let row = #"{"row_id":"tool:r","order_index":0,"role":"tool","tool":{"id":"r","name":"read_file","preview":null,"done":true,"is_error":false,"duration":null,"cost_usd":null,"opens_raw":true}}"#
    let message = try decoder.decode(ChatMessage.self, from: Data(#"{"role":"assistant","content":"Done.","message_id":"m","_anchor_activity_scene":{"version":"activity_scene_v1","final_answer":"Done.","activity_rows":[\#(row)]}}"#.utf8))
    let settled = AssistantTurnLayout(message: message, liveRows: [], archivedRows: []).rows.flatMap(\.toolCalls)
    XCTAssertEqual(settled.map(\.displayFlags), [ToolDisplayFlags(opensRaw: true)])
    XCTAssertEqual(ToolCall(id: "plain", name: "read_file", preview: nil, args: nil).applyingCompletionPayload(
        try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"plain","name":"read_file"}"#.utf8))
    ).displayFlags, ToolDisplayFlags())
}

/// TAL-1965: a `decision_review_put` result's review, from a tool frame and from a session detail.
func testTheReviewReferenceDecodesFromAToolResultAndASessionDetail() throws {
    let ref = try DecisionReviewModelTests.fixture("ref")
    let expected = DecisionReviewRef(reviewId: "dr_0a1b2c3d", title: "Workspace defaults", progress: DecisionProgress(total: 3, answered: 2))
    let event = try JSONDecoder().decode(ToolStreamEvent.self, from: Data(#"{"id":"call-review","name":"decision_review_put","result_view":{"text":"opened","decision_review":\#(ref)}}"#.utf8))
    XCTAssertEqual(event.resultView?.decisionReview, expected)
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let detail = try decoder.decode(SessionDetail.self, from: Data(#"{"session_id":"synthetic-session","decision_review":\#(ref)}"#.utf8))
    XCTAssertEqual(detail.decisionReview, expected)
    XCTAssertNil(try decoder.decode(SessionDetail.self, from: Data(#"{"session_id":"s","decision_review":null}"#.utf8)).decisionReview)
}

func testToolStreamEventCarriesAFileEditsDiffOntoItsCall() throws {
    let data = Data(#"{"id":"call-patch","name":"patch","kind":"write","target":"a.txt","edit_diff":{"added":2,"removed":1,"diff":"@@ -1 +1,2 @@\n-a\n+b\n+c","truncated":true}}"#.utf8)
    let event = try JSONDecoder().decode(ToolStreamEvent.self, from: data)
    let expected = ToolEditDiff(added: 2, removed: 1, diff: "@@ -1 +1,2 @@\n-a\n+b\n+c", truncated: true, hunks: DiffHunk.resolved(nil, diff: "@@ -1 +1,2 @@\n-a\n+b\n+c"))
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
    XCTAssertEqual(anchoredGroup.toolCalls.map(\.id), ["terminal-1", "read-file-1"])
    XCTAssertEqual(unanchoredGroup.id, "live-tools-unanchored")
}


func testReasoningDisplayReadsTheServerReasoningAndStripsVisibleAnswerEcho() {
    let finalAnswer = """
    **Terminal:** `/Users/hermes` directory listed.

    **Search files:** 5 `config.yaml` matches found.
    """
    let messages = [
        ChatMessage(
            role: "user",
            content: "Use terminal and search files",
            timestamp: 1_770_000_000,
            messageId: "user-tools"
        ),
        ChatMessage(
            role: "assistant",
            content: nil,
            timestamp: 1_770_000_001,
            messageId: "assistant-tools",
            contentParts: [
                .object([
                    "type": .string("tool_use"),
                    "id": .string("toolu-terminal"),
                    "name": .string("terminal"),
                    "input": .object(["command": .string("ls -la")])
                ]),
                .object([
                    "type": .string("tool_use"),
                    "id": .string("toolu-search"),
                    "name": .string("search_files"),
                    "input": .object(["pattern": .string("config.yaml")])
                ])
            ],
            // The server moves typed thinking parts into the row's one reasoning string (TAL-302).
            reasoning: "The user wants me to use terminal and search_files. I should run a quick command."
        ),
        ChatMessage(
            role: "user",
            content: nil,
            timestamp: 1_770_000_002,
            messageId: "tool-results",
            contentParts: [
                .object([
                    "type": .string("tool_result"),
                    "tool_use_id": .string("toolu-terminal"),
                    "content": .string("81 entries")
                ]),
                .object([
                    "type": .string("tool_result"),
                    "tool_use_id": .string("toolu-search"),
                    "content": .string("5 matches")
                ])
            ]
        ),
        ChatMessage(
            role: "assistant",
            content: nil,
            timestamp: 1_770_000_003,
            messageId: "assistant-post-tools",
            reasoning: "Terminal works. Now run search_files to show that works too."
        ),
        ChatMessage(
            role: "assistant",
            content: finalAnswer,
            timestamp: 1_770_000_004,
            messageId: "assistant-final",
            reasoning: """
            The user wants me to use terminal and search_files. I should run a quick command.
            Terminal works. Now run search_files to show that works too.
            Both tools worked. I should give a concise summary.

            \(finalAnswer)
            """
        )
    ]

    let reasoningGroups = ChatViewModel.reasoningDisplayGroups(messages: messages, archivedGroups: [])
    let transcriptMessages = ChatViewModel.transcriptMessages(from: messages)

    XCTAssertEqual(reasoningGroups.map(\.anchorMessageID), [
        "assistant-tools",
        "assistant-post-tools",
        "assistant-final"
    ])
    XCTAssertEqual(reasoningGroups[0].text, "The user wants me to use terminal and search_files. I should run a quick command.")
    XCTAssertEqual(reasoningGroups[1].text, "Terminal works. Now run search_files to show that works too.")
    XCTAssertTrue(reasoningGroups[2].text.contains("Both tools worked. I should give a concise summary."))
    XCTAssertFalse(reasoningGroups[2].text.contains("**Terminal:**"))
    XCTAssertFalse(transcriptMessages.contains { $0.message.id == "tool-results" })
}
}
