import XCTest
@testable import Talaria

extension APIClientSessionDetailTests {
func testAssistantActivitySummaryUsesNaturalCategoryPhrasesWithoutCounts() {
    let tools = [
        ToolCall(name: "skill_view", preview: nil, args: nil, kind: .skill, isCompleted: true),
        ToolCall(name: "read_file", preview: nil, args: nil, kind: .read, isCompleted: true),
        ToolCall(name: "terminal", preview: nil, args: nil, kind: .shell, isCompleted: true),
        ToolCall(name: "terminal", preview: nil, args: nil, kind: .shell, isCompleted: true)
    ]

    XCTAssertEqual(
        AssistantActivitySummary.title(for: tools),
        "Loaded a tool, read a file, ran commands"
    )
    XCTAssertFalse(AssistantActivitySummary.title(for: tools).contains("2"))

    let runningTools = tools + [
        ToolCall(name: "write_file", preview: nil, args: nil, kind: .write, isCompleted: false)
    ]
    XCTAssertEqual(
        AssistantActivitySummary.title(for: runningTools),
        "Loaded a tool, read a file, ran commands, editing a file"
    )
    XCTAssertEqual(AssistantTurnSummary.title(duration: nil), "Worked")
    XCTAssertEqual(AssistantTurnSummary.title(duration: 12.4), "Worked for 12s")
    XCTAssertEqual(AssistantTurnSummary.title(duration: 83), "Worked for 1m 23s")
}

func testAssistantActivitySummaryRendersTheServerKindAndTarget() {
    func label(_ name: String, _ kind: ToolDisplayKind?, _ target: String?, isError: Bool? = nil, isCompleted: Bool = true) -> String {
        // Args disagree with the server fields: the label must never pick or classify from them.
        AssistantActivitySummary.label(for: ToolCall(
            name: name,
            preview: nil,
            args: ["command": .string("rm -rf /"), "path": .string("wrong.txt")],
            kind: kind,
            target: target,
            isError: isError,
            isCompleted: isCompleted
        ))
    }

    XCTAssertEqual(label("terminal", .shell, "git log -1 --oneline"), "Ran git log -1 --oneline")
    XCTAssertEqual(label("read_file", .read, "Sources/Chat/ChatTranscriptView.swift"), "Read Sources/Chat/ChatTranscriptView.swift")
    XCTAssertEqual(label("write_file", .write, "static/ui.js", isCompleted: false), "Editing static/ui.js")
    XCTAssertEqual(label("search_files", .search, "ToolCallDisplayFormatter"), "Searched for ToolCallDisplayFormatter")
    XCTAssertEqual(label("web_search", .web, "OpenAI Responses API"), "Checked OpenAI Responses API")
    XCTAssertEqual(label("skill_view", .skill, "talaria-ios-testing"), "Loaded talaria-ios-testing skill")
    XCTAssertEqual(label("delegate_task", .delegate, "review the activity renderer"), "Delegated review the activity renderer")
    XCTAssertEqual(label("terminal", .shell, "git status", isError: true), "Failed to run git status")
    // The server's redacted target is shown as sent.
    XCTAssertEqual(
        label("terminal", .shell, "curl -H 'Authorization: Bearer synthe...cdef' https://example.com"),
        "Ran curl -H 'Authorization: Bearer synthe...cdef' https://example.com"
    )
    // `merge_pull_request` is whatever the server says, never a search guessed from its name.
    XCTAssertEqual(label("merge_pull_request", .unknown, ""), "Called a tool")
    // An unknown tool with a server target reads like Web's: the generic run verb and the target.
    XCTAssertEqual(label("merge_pull_request", .unknown, "gh pr merge 1"), "Ran gh pr merge 1")
    XCTAssertEqual(label("merge_pull_request", .unknown, "gh pr merge 1", isError: true), "Failed to run gh pr merge 1")
    // An older server sends no kind or target: a generic tool, never a client guess from the name or args.
    XCTAssertEqual(label("terminal", nil, nil), "Called a tool")
    XCTAssertEqual(label("terminal", .shell, nil), "Ran a command")
}

func testAssistantActivityHeaderTracksCurrentInnerActivity() {
    let reasoning = AssistantActivityRow(
        id: "reasoning",
        content: .reasoning(.init(
            text: "I should inspect the repository.",
            titles: ["Inspecting the repository"]
        ))
    )
    let runningTool = ToolCall(
        name: "terminal",
        preview: nil,
        args: ["command": .string("git status")],
        kind: .shell,
        target: "git status",
        isCompleted: false
    )
    let activeRows = [
        reasoning,
        AssistantActivityRow(id: "tools", content: .tools([runningTool]))
    ]

    XCTAssertEqual(
        AssistantActivityHeaderSummary.title(for: [reasoning], isActive: true),
        "Inspecting the repository"
    )
    XCTAssertEqual(
        AssistantActivityHeaderSummary.title(for: activeRows, isActive: true),
        "Running git status"
    )
    XCTAssertEqual(
        AssistantActivityHeaderSummary.titles(for: activeRows, isActive: true),
        []
    )

    let completedRows = [
        reasoning,
        AssistantActivityRow(
            id: "tools",
            content: .tools([ToolCall(
                name: "terminal",
                preview: nil,
                args: ["command": .string("git status")],
                kind: .shell,
                target: "git status",
                isCompleted: true
            )])
        )
    ]
    XCTAssertEqual(
        AssistantActivityHeaderSummary.title(for: completedRows, isActive: false),
        "Ran a command"
    )
}

func testActivityDisclosureGroupingOnlyWrapsMultipleItems() {
    let reasoning = AssistantActivityRow(
        id: "reasoning",
        content: .reasoning(.init(text: "Inspecting the repository."))
    )
    let firstTool = ToolCall(name: "terminal", preview: nil, args: nil, isCompleted: true)
    let secondTool = ToolCall(name: "read_file", preview: nil, args: nil, isCompleted: true)

    XCTAssertFalse(AssistantActivityGroupPolicy.requiresGroup(for: [reasoning]))
    XCTAssertFalse(AssistantActivityGroupPolicy.requiresGroup(for: [
        AssistantActivityRow(id: "one-tool", content: .tools([firstTool]))
    ]))
    XCTAssertTrue(AssistantActivityGroupPolicy.requiresGroup(for: [
        reasoning,
        AssistantActivityRow(id: "one-tool", content: .tools([firstTool]))
    ]))
    XCTAssertTrue(AssistantActivityGroupPolicy.requiresGroup(for: [
        AssistantActivityRow(id: "two-tools", content: .tools([firstTool, secondTool]))
    ]))
}
}
