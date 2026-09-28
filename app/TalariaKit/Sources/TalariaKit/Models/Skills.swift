import Foundation

public struct SkillsResponse: Decodable, Equatable {
    public let skills: [SkillSummary]?
}

public struct SkillSummary: Decodable, Equatable, Identifiable {
    private let fallbackIdentity = DecodedIdentityToken()
    public var id: String {
        name ?? fallbackIdentity.value
    }

    public let name: String?
    public let category: String?
    public let description: String?
    public let path: String?
    public let disabled: Bool?
    public let tags: [String]?
    public let relatedSkills: [String]?

    enum CodingKeys: String, CodingKey {
        case name
        case category
        case description
        case path
        case disabled
        case tags
        case relatedSkills
    }

    public init(
        name: String?,
        category: String?,
        description: String?,
        path: String?,
        disabled: Bool? = nil,
        tags: [String]? = nil,
        relatedSkills: [String]? = nil
    ) {
        self.name = name
        self.category = category
        self.description = description
        self.path = path
        self.disabled = disabled
        self.tags = tags
        self.relatedSkills = relatedSkills
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = container.decodeLossyStringIfPresent(forKey: .name)
        category = container.decodeLossyStringIfPresent(forKey: .category)
        description = container.decodeLossyStringIfPresent(forKey: .description)
        path = container.decodeLossyStringIfPresent(forKey: .path)
        disabled = container.decodeLossyBoolIfPresent(forKey: .disabled)
        tags = try? container.decodeIfPresent([String].self, forKey: .tags)
        relatedSkills = try? container.decodeIfPresent([String].self, forKey: .relatedSkills)
    }
}

struct ToggleSkillRequest: Encodable, Equatable {
    let name: String
    let enabled: Bool
}

public struct ToggleSkillResponse: Decodable, Equatable {
    let ok: Bool?
    let name: String?
    let enabled: Bool?
}

public struct SkillSlashSuggestion: Identifiable, Equatable {
    public let name: String
    public let category: String?
    public let description: String?

    public var id: String { slashName }
    public var slashName: String { SlashSkillFormatter.slug(for: name) }
}

public struct SkillSlashInvocation: Equatable {
    let skill: SkillSlashSuggestion
    let message: String
}

public enum SlashSkillFormatter {
    static func slug(for name: String) -> String {
        let lower = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let separators = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "_"))
        let collapsedSeparators = lower
            .components(separatedBy: separators)
            .filter { !$0.isEmpty }
            .joined(separator: "-")
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")
        let filteredScalars = collapsedSeparators.unicodeScalars.filter { allowed.contains($0) }
        let filtered = String(String.UnicodeScalarView(filteredScalars))

        var result = ""
        var previousWasHyphen = false
        for character in filtered {
            if character == "-" {
                guard !previousWasHyphen else { continue }
                previousWasHyphen = true
            } else {
                previousWasHyphen = false
            }
            result.append(character)
        }

        return result.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }

    public static func suggestions(from skills: [SkillSummary]) -> [SkillSlashSuggestion] {
        let parsed = skills.compactMap { skill -> SkillSlashSuggestion? in
            guard let rawName = skill.name?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !rawName.isEmpty,
                  !slug(for: rawName).isEmpty
            else {
                return nil
            }

            let category = skill.category?.trimmingCharacters(in: .whitespacesAndNewlines)
            let description = skill.description?.trimmingCharacters(in: .whitespacesAndNewlines)
            return SkillSlashSuggestion(
                name: rawName,
                category: category?.isEmpty == true ? nil : category,
                description: description?.isEmpty == true ? nil : description
            )
        }

        var seen = Set<String>()
        return parsed
            .filter { seen.insert($0.slashName).inserted }
            .sorted { lhs, rhs in
                lhs.slashName.localizedCaseInsensitiveCompare(rhs.slashName) == .orderedAscending
            }
    }

    public static func skillQuery(from args: String) -> String {
        let trimmed = args.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return trimmed.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? ""
    }

    public static func invocation(from args: String, suggestions: [SkillSlashSuggestion]) -> SkillSlashInvocation? {
        let trimmed = args.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard parts.count == 2 else { return nil }

        guard let skill = skill(named: String(parts[0]), in: suggestions) else {
            return nil
        }

        let message = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return nil }
        return SkillSlashInvocation(skill: skill, message: message)
    }

    public static func skill(named name: String, in suggestions: [SkillSlashSuggestion]) -> SkillSlashSuggestion? {
        let requestedSkill = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !requestedSkill.isEmpty else { return nil }
        return suggestions.first { suggestion in
            suggestion.slashName.lowercased() == requestedSkill ||
            suggestion.name.lowercased() == requestedSkill
        }
    }

    public static func messageText(for invocation: SkillSlashInvocation) -> String {
        "/\(invocation.skill.slashName) \(invocation.message)"
    }

    public static func detailMessage(for skill: SkillSlashSuggestion) -> String {
        var lines = [
            "### `/\(skill.slashName)`",
            "",
            "**\(skill.name)**"
        ]

        if let category = skill.category {
            lines.append("")
            lines.append("Category: \(category)")
        }

        if let description = skill.description {
            lines.append("")
            lines.append(description)
        }

        lines.append("")
        lines.append(String(localized: "Send `/\(skill.slashName) <message>` to use this skill."))
        return lines.joined(separator: "\n")
    }

    public static func matching(_ query: String, in suggestions: [SkillSlashSuggestion]) -> [SkillSlashSuggestion] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return suggestions }

        return suggestions.filter { suggestion in
            suggestion.slashName.localizedCaseInsensitiveContains(trimmed) ||
            suggestion.name.localizedCaseInsensitiveContains(trimmed) ||
            (suggestion.category?.localizedCaseInsensitiveContains(trimmed) ?? false) ||
            (suggestion.description?.localizedCaseInsensitiveContains(trimmed) ?? false)
        }
    }

    public static func message(for suggestions: [SkillSlashSuggestion], query: String) -> String {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !suggestions.isEmpty else {
            return String(localized: "No skills are configured on the server.")
        }

        let matches = matching(trimmed, in: suggestions)
        guard !matches.isEmpty else {
            return String(localized: "No skills match `\(trimmed)`.")
        }

        let heading = trimmed.isEmpty ? String(localized: "Available skills:") : String(localized: "Skills matching `\(trimmed)`:")
        let grouped = Dictionary(grouping: matches) { suggestion in
            suggestion.category ?? String(localized: "Uncategorized")
        }
        let sections = grouped
            .sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }
            .map { category, skills in
                let rows = skills
                    .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                    .map { suggestion in
                        if let description = suggestion.description, !description.isEmpty {
                            return "- `\(suggestion.slashName)` - **\(suggestion.name)** - \(description)"
                        }
                        return "- `\(suggestion.slashName)` - **\(suggestion.name)**"
                    }
                    .joined(separator: "\n")

                return "### \(category)\n\(rows)"
            }
            .joined(separator: "\n\n")

        return "\(heading)\n\n\(sections)"
    }
}

public struct SkillDetailResponse: Decodable, Equatable {
    let name: String?
    public let content: String?
    public let linkedFiles: [String]?

    enum CodingKeys: String, CodingKey {
        case name
        case content
        case linkedFiles
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        content = try container.decodeIfPresent(String.self, forKey: .content)
        linkedFiles = Self.decodeLinkedFiles(from: container)
    }

    private static func decodeLinkedFiles(from container: KeyedDecodingContainer<CodingKeys>) -> [String]? {
        if let flat = try? container.decodeIfPresent([String: String].self, forKey: .linkedFiles) {
            let names = flat.keys.sorted()
            return names.isEmpty ? nil : names
        }

        guard let raw = try? container.decodeIfPresent(JSONValue.self, forKey: .linkedFiles) else {
            return nil
        }

        let names = Array(Set(linkedFileNames(from: raw))).sorted()
        return names.isEmpty ? nil : names
    }

    private static func linkedFileNames(from value: JSONValue) -> [String] {
        switch value {
        case .string(let name):
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? [] : [trimmed]
        case .array(let values):
            return values.flatMap(linkedFileNames(from:))
        case .object(let object):
            return object.flatMap { key, value in
                switch value {
                case .array:
                    return linkedFileNames(from: value)
                case .string:
                    return [key]
                default:
                    return linkedFileNames(from: value)
                }
            }
        case .number, .bool, .null:
            return []
        }
    }
}
