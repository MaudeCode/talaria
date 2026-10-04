import Foundation
import SwiftUI

public struct AgentSlashCommandSuggestion: Identifiable, Equatable {
    public let name: String
    public let description: String
    public let argHint: String?

    public var id: String { name.lowercased() }

    /// Agent-handled catalog entries listed for iOS (TAL-314).
    init?(_ command: AgentCommand) {
        guard command.isCatalogEntry,
              !command.isClientHandled,
              command.runsOnIOS,
              let name = Self.nonEmpty(command.name)
        else {
            return nil
        }

        self.name = name
        description = Self.nonEmpty(command.description) ?? String(localized: "Agent command")
        argHint = Self.nonEmpty(command.argsHint)
    }

    public static func matching(
        _ query: String,
        in commands: [AgentCommand],
        excluding excludedNames: Set<String> = []
    ) -> [AgentSlashCommandSuggestion] {
        let lower = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var seen = excludedNames
        var matches: [AgentSlashCommandSuggestion] = []

        for command in commands {
            guard let suggestion = AgentSlashCommandSuggestion(command) else { continue }

            let key = suggestion.name.lowercased()
            guard !seen.contains(key) else { continue }
            guard command.matches(prefix: lower) else { continue }

            matches.append(suggestion)
            seen.insert(key)
        }

        return matches
    }

    public static func command(named name: String, in commands: [AgentCommand]) -> AgentSlashCommandSuggestion? {
        let lower = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !lower.isEmpty else { return nil }
        guard SlashCommandCatalog.command(named: lower, in: commands) == nil else { return nil }

        return commands.lazy.filter { $0.resolves(lower) }.compactMap(AgentSlashCommandSuggestion.init).first
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

public struct ParsedSlashQuery {
    let query: String
    let catalog: [AgentCommand]

    public init(query: String, catalog: [AgentCommand] = []) {
        self.query = query
        self.catalog = catalog
    }

    public var commandName: String {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return trimmed }
        let withoutSlash = String(trimmed.dropFirst())
        let components = withoutSlash.split(separator: " ", maxSplits: 1)
        return String(components.first ?? "")
    }

    public var argQuery: String {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return "" }
        let withoutSlash = String(trimmed.dropFirst())
        let components = withoutSlash.split(separator: " ", maxSplits: 1)
        guard components.count > 1 else { return "" }
        return String(components[1]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var isSubArgMode: Bool {
        guard let command else { return false }
        guard command.subArgs != .none else { return false }
        let prefix = "/\(commandName)"
        guard query.hasPrefix(prefix) else { return false }
        let afterCommand = String(query.dropFirst(prefix.count))
        return afterCommand.hasPrefix(" ")
    }

    public var command: SlashCommand? {
        SlashCommandCatalog.command(named: commandName, in: catalog)
    }
}
