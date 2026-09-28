import Foundation
import SwiftUI

public struct AgentSlashCommandSuggestion: Identifiable, Equatable {
    public let name: String
    public let description: String
    public let argHint: String?

    public var id: String { name.lowercased() }

    init?(_ command: AgentCommand) {
        guard command.cliOnly != true,
              command.gatewayOnly != true,
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
            guard lower.isEmpty || key.hasPrefix(lower) else { continue }

            matches.append(suggestion)
            seen.insert(key)
        }

        return matches
    }

    public static func command(named name: String, in commands: [AgentCommand]) -> AgentSlashCommandSuggestion? {
        let lower = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !lower.isEmpty else { return nil }
        guard SlashCommandCatalog.command(named: lower) == nil else { return nil }

        return commands.lazy.compactMap(AgentSlashCommandSuggestion.init).first { suggestion in
            suggestion.name.lowercased() == lower
        }
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

public struct ParsedSlashQuery {
    let query: String

    public init(query: String) {
        self.query = query
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
        guard let command = SlashCommandCatalog.command(named: commandName) else { return false }
        guard command.subArgs != .none else { return false }
        let prefix = "/\(command.name)"
        guard query.hasPrefix(prefix) else { return false }
        let afterCommand = String(query.dropFirst(prefix.count))
        return afterCommand.hasPrefix(" ")
    }

    public var command: SlashCommand? {
        SlashCommandCatalog.command(named: commandName)
    }
}
