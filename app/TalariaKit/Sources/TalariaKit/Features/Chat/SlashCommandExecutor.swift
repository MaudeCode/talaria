import Foundation

public struct ParsedSlashCommand: Equatable {
    public let command: SlashCommand?
    let name: String
    let args: String
}

public enum SlashCommandExecutionResult: Equatable {
    case executed(message: String?)
    case openedSession(SessionSummary)
    case sendAsMessage
    case unsupported(friendlyMessage: String)
    case needsSubArg
}

public enum SlashCommandExecutor {
    public static func parse(_ text: String, catalog: [AgentCommand] = []) -> ParsedSlashCommand? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return nil }

        let withoutSlash = String(trimmed.dropFirst())
        guard !withoutSlash.isEmpty else {
            return ParsedSlashCommand(command: nil, name: "", args: "")
        }

        let parts = withoutSlash.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        let name = parts.first.map(String.init) ?? ""
        let args = parts.dropFirst().first.map {
            String($0).trimmingCharacters(in: .whitespacesAndNewlines)
        } ?? ""

        return ParsedSlashCommand(
            command: SlashCommandCatalog.command(named: name, in: catalog),
            name: name,
            args: args
        )
    }

    @MainActor
    public static func execute(text: String, viewModel: ChatViewModel) async -> SlashCommandExecutionResult {
        let catalog = viewModel.agentCommands
        guard let parsed = parse(text, catalog: catalog) else { return .sendAsMessage }
        guard !parsed.name.isEmpty else { return .needsSubArg }

        guard let command = parsed.command else {
            if let message = unsupportedMessage(for: parsed.name, in: catalog) {
                return .unsupported(friendlyMessage: message)
            }
            if parsed.name.lowercased() == "skill" {
                return .unsupported(friendlyMessage: String(localized: "Use `/skills [query]` to search skills."))
            }
            if let result = await viewModel.executeSkillShortcutCommand(name: parsed.name, args: parsed.args) {
                return result
            }
            // Match WebUI: let the agent/runtime handle unknown, non-blocked slash text.
            return .sendAsMessage
        }

        return await viewModel.executeSlashCommand(command, args: parsed.args)
    }

    /// The message for a command the server catalog lists without iOS (TAL-314): its `unsupported_message`, or a
    /// generic line when the server sends none.
    static func unsupportedMessage(for name: String, in catalog: [AgentCommand]) -> String? {
        guard let entry = catalog.entry(named: name), !entry.runsOnIOS else { return nil }
        return entry.unsupportedMessage ?? String(localized: "This command is not available in the mobile app.")
    }
}
