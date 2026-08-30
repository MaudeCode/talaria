import XCTest
@testable import Talaria

extension APIClientSessionDetailTests {
func testAssistantActivitySummaryUsesNaturalCategoryPhrasesWithoutCounts() {
    let tools = [
        ToolCall(name: "skill_view", preview: nil, args: nil, isCompleted: true),
        ToolCall(name: "read_file", preview: nil, args: nil, isCompleted: true),
        ToolCall(name: "terminal", preview: nil, args: nil, isCompleted: true),
        ToolCall(name: "terminal", preview: nil, args: nil, isCompleted: true)
    ]

    XCTAssertEqual(
        AssistantActivitySummary.title(for: tools),
        "Loaded a tool, read a file, ran commands"
    )
    XCTAssertFalse(AssistantActivitySummary.title(for: tools).contains("2"))

    let runningTools = tools + [
        ToolCall(name: "write_file", preview: nil, args: nil, isCompleted: false)
    ]
    XCTAssertEqual(
        AssistantActivitySummary.title(for: runningTools),
        "Loaded a tool, read a file, ran commands, editing a file"
    )
    XCTAssertEqual(AssistantTurnSummary.title(duration: nil), "Worked")
    XCTAssertEqual(AssistantTurnSummary.title(duration: 12.4), "Worked for 12s")
    XCTAssertEqual(AssistantTurnSummary.title(duration: 83), "Worked for 1m 23s")
}

func testAssistantActivitySummaryUsesSafeSpecificCollapsedLabels() {
    XCTAssertEqual(
        AssistantActivitySummary.label(for: ToolCall(
            name: "terminal",
            preview: nil,
            args: ["command": .string("git log -1 --oneline")],
            isCompleted: true
        )),
        "Ran git log -1 --oneline"
    )
    XCTAssertEqual(
        AssistantActivitySummary.label(for: ToolCall(
            name: "read_file",
            preview: nil,
            args: ["path": .string("Sources/Chat/ChatTranscriptView.swift")],
            isCompleted: true
        )),
        "Read ChatTranscriptView.swift"
    )
    XCTAssertEqual(
        AssistantActivitySummary.label(for: ToolCall(
            name: "write_file",
            preview: nil,
            args: ["file_path": .string("static/ui.js")],
            isCompleted: false
        )),
        "Editing ui.js"
    )
    XCTAssertEqual(
        AssistantActivitySummary.label(for: ToolCall(
            name: "search_files",
            preview: nil,
            args: ["pattern": .string("ToolCallDisplayFormatter")],
            isCompleted: true
        )),
        "Searched for ToolCallDisplayFormatter"
    )
    XCTAssertEqual(
        AssistantActivitySummary.label(for: ToolCall(
            name: "web_search",
            preview: nil,
            args: ["query": .string("OpenAI Responses API")],
            isCompleted: true
        )),
        "Checked OpenAI Responses API"
    )
    XCTAssertEqual(
        AssistantActivitySummary.label(for: ToolCall(
            name: "skill_view",
            preview: nil,
            args: ["name": .string("talaria-ios-testing")],
            isCompleted: true
        )),
        "Loaded talaria-ios-testing skill"
    )
    XCTAssertEqual(
        AssistantActivitySummary.label(for: ToolCall(
            name: "delegate_task",
            preview: nil,
            args: ["task": .string("review the activity renderer")],
            isCompleted: true
        )),
        "Delegated review the activity renderer"
    )
    XCTAssertEqual(
        AssistantActivitySummary.label(for: ToolCall(
            name: "terminal",
            preview: nil,
            args: ["command": .string("echo first\necho second")],
            isCompleted: true
        )),
        "Ran echo first"
    )
    XCTAssertEqual(
        AssistantActivitySummary.label(for: ToolCall(
            name: "terminal",
            preview: nil,
            args: ["command": .string("curl -H 'Authorization: Bearer private-token' https://example.com")],
            isCompleted: true
        )),
        "Ran a command"
    )
    XCTAssertEqual(
        AssistantActivitySummary.label(for: ToolCall(
            name: "terminal",
            preview: nil,
            args: ["command": .string("git status")],
            isError: true,
            isCompleted: true
        )),
        "Failed to run git status"
    )
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
