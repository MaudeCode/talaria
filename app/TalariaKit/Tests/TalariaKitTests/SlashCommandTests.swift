import XCTest
@testable import TalariaKit

final class SlashCommandTests: XCTestCase {

    // MARK: - Handlers

    func testCommandNamedReturnsCorrectCommand() {
        let command = SlashCommandCatalog.command(named: "help")
        XCTAssertEqual(command?.name, "help")
        XCTAssertEqual(command?.handler, .clientSide(.help))
    }

    func testBranchCommandIsMobileSafeAdvancedCommand() {
        let command = SlashCommandCatalog.command(named: "branch")
        XCTAssertEqual(command?.name, "branch")
        XCTAssertEqual(command?.handler, .serverSide(.branch))
        XCTAssertEqual(command?.noEcho, true)
    }

    func testUndoCommandIsMobileSafeAdvancedCommand() {
        let command = SlashCommandCatalog.command(named: "undo")
        XCTAssertEqual(command?.name, "undo")
        XCTAssertEqual(command?.handler, .serverSide(.undo))
        XCTAssertEqual(command?.noEcho, true)
    }

    func testRetryCommandIsMobileSafeAdvancedCommand() {
        let command = SlashCommandCatalog.command(named: "retry")
        XCTAssertEqual(command?.name, "retry")
        XCTAssertEqual(command?.handler, .serverSide(.retry))
        XCTAssertEqual(command?.noEcho, true)
    }

    func testCompressCommandIsMobileSafeAdvancedCommand() {
        let command = SlashCommandCatalog.command(named: "compress")
        XCTAssertEqual(command?.name, "compress")
        XCTAssertEqual(command?.handler, .serverSide(.compress))
        XCTAssertEqual(command?.noEcho, true)
        XCTAssertEqual(command?.argHint, "focus topic")
    }

    func testSkillsCommandIsMobileSafeSearchCommand() {
        let command = SlashCommandCatalog.command(named: "skills")
        XCTAssertEqual(command?.name, "skills")
        XCTAssertEqual(command?.handler, .serverSide(.skills))
        XCTAssertEqual(command?.noEcho, false)
        XCTAssertEqual(command?.argHint, "query")
        XCTAssertEqual(command?.subArgs, .skills)
    }

    func testBusyInputCommandsAreMobileSafeCommands() {
        let queue = SlashCommandCatalog.command(named: "queue")
        XCTAssertEqual(queue?.handler, .serverSide(.queue))
        XCTAssertEqual(queue?.noEcho, true)
        XCTAssertEqual(queue?.argHint, "message")

        let steer = SlashCommandCatalog.command(named: "steer")
        XCTAssertEqual(steer?.handler, .serverSide(.steer))
        XCTAssertEqual(steer?.noEcho, true)
        XCTAssertEqual(steer?.argHint, "message")

        let interrupt = SlashCommandCatalog.command(named: "interrupt")
        XCTAssertEqual(interrupt?.handler, .serverSide(.interrupt))
        XCTAssertEqual(interrupt?.noEcho, true)
        XCTAssertEqual(interrupt?.argHint, "message")

        let status = SlashCommandCatalog.command(named: "status")
        XCTAssertEqual(status?.handler, .serverSide(.status))
        XCTAssertEqual(status?.noEcho, false)
        XCTAssertNil(status?.argHint)
    }

    func testGoalCommandIsMobileSafePersistentGoalCommand() {
        let command = SlashCommandCatalog.command(named: "goal")
        XCTAssertEqual(command?.name, "goal")
        XCTAssertEqual(command?.handler, .serverSide(.goal))
        XCTAssertEqual(command?.noEcho, true)
        XCTAssertEqual(command?.argHint, "[status|pause|resume|clear|text]")
        XCTAssertEqual(command?.subArgs, .goalActions)
        XCTAssertEqual(SlashCommandCatalog.goalActions, ["status", "pause", "resume", "clear"])
    }

    func testSideTaskCommandsAreMobileSafeCommands() {
        let btw = SlashCommandCatalog.command(named: "btw")
        XCTAssertEqual(btw?.handler, .serverSide(.btw))
        XCTAssertEqual(btw?.noEcho, true)
        XCTAssertEqual(btw?.argHint, "question")

        let background = SlashCommandCatalog.command(named: "background")
        XCTAssertEqual(background?.handler, .serverSide(.background))
        XCTAssertEqual(background?.noEcho, true)
        XCTAssertEqual(background?.argHint, "prompt")
    }

    func testCommandNamedIsCaseInsensitive() {
        let lower = SlashCommandCatalog.command(named: "model")
        let upper = SlashCommandCatalog.command(named: "MODEL")
        XCTAssertEqual(lower?.name, upper?.name)
    }

    func testCommandNamedReturnsNilForUnknown() {
        XCTAssertNil(SlashCommandCatalog.command(named: "nope"))
    }

    // MARK: - Reasoning levels

    func testReasoningLevelsContainsExpectedValues() {
        let levels = SlashCommandCatalog.reasoningLevels
        XCTAssertTrue(levels.contains("show"))
        XCTAssertTrue(levels.contains("hide"))
        XCTAssertTrue(levels.contains("none"))
        XCTAssertTrue(levels.contains("minimal"))
        XCTAssertTrue(levels.contains("low"))
        XCTAssertTrue(levels.contains("medium"))
        XCTAssertTrue(levels.contains("high"))
        XCTAssertTrue(levels.contains("xhigh"))
    }

    // MARK: - ParsedSlashQuery

    func testParsedQueryExtractsCommandName() {
        let parsed = ParsedSlashQuery(query: "/model gpt-4")
        XCTAssertEqual(parsed.commandName, "model")
    }

    func testParsedQueryExtractsArgQuery() {
        let parsed = ParsedSlashQuery(query: "/model gpt-4")
        XCTAssertEqual(parsed.argQuery, "gpt-4")
    }

    func testParsedQueryNoArgs() {
        let parsed = ParsedSlashQuery(query: "/help")
        XCTAssertEqual(parsed.commandName, "help")
        XCTAssertEqual(parsed.argQuery, "")
    }

    func testParsedQueryMultipleSpaces() {
        let parsed = ParsedSlashQuery(query: "/model   gpt-4")
        XCTAssertEqual(parsed.commandName, "model")
        XCTAssertEqual(parsed.argQuery, "gpt-4")
    }

    func testParsedQueryIsSubArgModeForModels() {
        let parsed = ParsedSlashQuery(query: "/model g")
        XCTAssertTrue(parsed.isSubArgMode)
    }

    func testParsedQueryIsNotSubArgModeForHelp() {
        let parsed = ParsedSlashQuery(query: "/help")
        XCTAssertFalse(parsed.isSubArgMode)
    }

    func testParsedQueryIsNotSubArgModeWithoutSpace() {
        let parsed = ParsedSlashQuery(query: "/model")
        XCTAssertFalse(parsed.isSubArgMode)
    }

    func testParsedQueryIsSubArgModeWithTrailingSpace() {
        let parsed = ParsedSlashQuery(query: "/model ")
        XCTAssertTrue(parsed.isSubArgMode)
    }

    func testParsedQueryReturnsCommand() {
        let parsed = ParsedSlashQuery(query: "/model gpt-4")
        XCTAssertEqual(parsed.command?.name, "model")
    }

    func testParsedQueryTreatsGoalActionsAsSubArgs() {
        let parsed = ParsedSlashQuery(query: "/goal sta")
        XCTAssertEqual(parsed.command?.name, "goal")
        XCTAssertEqual(parsed.command?.subArgs, .goalActions)
        XCTAssertEqual(parsed.argQuery, "sta")
        XCTAssertTrue(parsed.isSubArgMode)
    }

    func testParsedQueryReturnsNilCommandForUnknown() {
        let parsed = ParsedSlashQuery(query: "/nope")
        XCTAssertNil(parsed.command)
    }

    // MARK: - Skill slash suggestions

    func testSkillSuggestionsTrimAndSortNames() {
        let suggestions = SlashSkillFormatter.suggestions(from: [
            SkillSummary(name: " zed ", category: " coding ", description: " Last ", path: nil),
            SkillSummary(name: nil, category: "coding", description: "Missing name", path: nil),
            SkillSummary(name: "alpha", category: "", description: "", path: nil)
        ])

        XCTAssertEqual(suggestions.map(\.name), ["alpha", "zed"])
        XCTAssertNil(suggestions[0].category)
        XCTAssertEqual(suggestions[1].category, "coding")
        XCTAssertEqual(suggestions[1].description, "Last")
    }

    func testSkillSuggestionsBuildWebUIStyleSlugs() {
        XCTAssertEqual(SlashSkillFormatter.slug(for: "Claude Code"), "claude-code")
        XCTAssertEqual(SlashSkillFormatter.slug(for: "docs_search!!"), "docs-search")
        XCTAssertEqual(SlashSkillFormatter.slug(for: "--Swift---Refactor--"), "swift-refactor")
    }

    func testSkillMatchingFindsPartialSkillName() {
        let suggestions = SlashSkillFormatter.suggestions(from: [
            SkillSummary(name: "claude-code", category: "coding", description: "Use Claude Code", path: nil),
            SkillSummary(name: "swift-refactor", category: "coding", description: "Refactor Swift", path: nil)
        ])

        XCTAssertEqual(SlashSkillFormatter.matching("claude", in: suggestions).map(\.name), ["claude-code"])
    }

    func testSkillInvocationSplitsRecognizedSkillAndMessage() throws {
        let suggestions = SlashSkillFormatter.suggestions(from: [
            SkillSummary(name: "Claude Code", category: "coding", description: "Use Claude Code", path: nil)
        ])

        let invocation = SlashSkillFormatter.invocation(
            from: "claude-code open claude code and check for updates",
            suggestions: suggestions
        )

        XCTAssertEqual(invocation?.skill.name, "Claude Code")
        XCTAssertEqual(invocation?.skill.slashName, "claude-code")
        XCTAssertEqual(invocation?.message, "open claude code and check for updates")
        XCTAssertEqual(SlashSkillFormatter.messageText(for: try XCTUnwrap(invocation)), "/claude-code open claude code and check for updates")
    }

    func testSkillInvocationDoesNotTreatSkillOnlyAsMessage() {
        let suggestions = SlashSkillFormatter.suggestions(from: [
            SkillSummary(name: "Claude Code", category: "coding", description: "Use Claude Code", path: nil)
        ])

        XCTAssertNil(SlashSkillFormatter.invocation(from: "claude-code", suggestions: suggestions))
        XCTAssertNil(SlashSkillFormatter.invocation(from: "claude-code ", suggestions: suggestions))
        XCTAssertEqual(SlashSkillFormatter.skillQuery(from: "claude-code "), "claude-code")
    }

    func testSkillInvocationRequiresRecognizedSkillBeforeMessage() {
        let suggestions = SlashSkillFormatter.suggestions(from: [
            SkillSummary(name: "claude-code", category: "coding", description: nil, path: nil)
        ])

        XCTAssertNil(SlashSkillFormatter.invocation(from: "claude maybe a search", suggestions: suggestions))
    }

    func testSkillMessageGroupsByCategory() {
        let suggestions = SlashSkillFormatter.suggestions(from: [
            SkillSummary(name: "swift-refactor", category: "coding", description: "Refactor Swift", path: nil),
            SkillSummary(name: "doc-search", category: "research", description: nil, path: nil)
        ])

        let message = SlashSkillFormatter.message(for: suggestions, query: "")
        XCTAssertTrue(message.contains("Available skills:"))
        XCTAssertTrue(message.contains("### coding"))
        XCTAssertTrue(message.contains("- `swift-refactor` - **swift-refactor** - Refactor Swift"))
        XCTAssertTrue(message.contains("### research"))
        XCTAssertTrue(message.contains("- `doc-search` - **doc-search**"))
    }

    func testSkillDetailMessageShowsSingleSkillUsage() {
        let skill = SkillSlashSuggestion(
            name: "Spotify",
            category: "media",
            description: "Control Spotify playback."
        )

        let message = SlashSkillFormatter.detailMessage(for: skill)

        XCTAssertTrue(message.contains("### `/spotify`"))
        XCTAssertTrue(message.contains("**Spotify**"))
        XCTAssertTrue(message.contains("Category: media"))
        XCTAssertTrue(message.contains("Control Spotify playback."))
        XCTAssertTrue(message.contains("Send `/spotify <message>` to use this skill."))
    }

    // MARK: - Agent slash suggestions

    func testAgentCommandSuggestionsIncludeNonCLICommands() {
        let suggestions = AgentSlashCommandSuggestion.matching("res", in: [
            AgentCommand(
                name: "resume",
                description: "Resume a previously-named session",
                argsHint: "name",
                handler: "agent",
                clients: ["web", "ios"]
            )
        ])

        XCTAssertEqual(suggestions.map(\.name), ["resume"])
        XCTAssertEqual(suggestions.first?.description, "Resume a previously-named session")
        XCTAssertEqual(suggestions.first?.argHint, "name")
    }

    func testAgentCommandSuggestionsHideOtherClientsOldRowsAndDuplicateCommands() {
        let suggestions = AgentSlashCommandSuggestion.matching("s", in: [
            AgentCommand(name: "status", description: "Agent status", handler: "agent", clients: ["web", "ios"]),
            AgentCommand(name: "shell", description: "CLI only", cliOnly: true, handler: "agent", clients: []),
            AgentCommand(name: "sethome", description: "Older server row"),
            AgentCommand(name: "session", description: nil, handler: "agent", clients: ["web", "ios"])
        ], excluding: ["status"])

        XCTAssertEqual(suggestions.map(\.name), ["session"])
        XCTAssertEqual(suggestions.first?.description, "Agent command")
    }

    func testAgentCommandLookupRecognizesVisibleMetadataCommand() {
        let commands = [
            AgentCommand(name: "resume", description: "Resume a previously-named session", handler: "agent", clients: ["web", "ios"]),
            AgentCommand(name: "model", description: "Built-in model command", handler: "client", clients: ["web", "ios"]),
            AgentCommand(name: "browser", description: "CLI only", cliOnly: true, handler: "agent", clients: [])
        ]

        XCTAssertEqual(AgentSlashCommandSuggestion.command(named: "RESUME", in: commands)?.name, "resume")
        XCTAssertNil(AgentSlashCommandSuggestion.command(named: "model", in: commands))
        XCTAssertNil(AgentSlashCommandSuggestion.command(named: "browser", in: commands))
    }
}
