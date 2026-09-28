import SwiftUI

public enum CronJobSkillsSelection {
    /// The server's list, plus a row for every selected skill it does not
    /// offer, so a saved selection is always visible and always removable.
    public static func skillsIncludingSelection(
        _ skills: [SkillSummary],
        selection: [String]
    ) -> [SkillSummary] {
        let known = Set(skills.compactMap(\.name))
        let missing = selection.filter { !known.contains($0) }
        return missing.map { SkillSummary(name: $0, category: nil, description: nil, path: nil) } + skills
    }

    /// A skill is findable by every string its row shows.
    public static func filteredSkills(_ skills: [SkillSummary], query: String) -> [SkillSummary] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return skills }

        return skills.filter { skill in
            (skill.name?.localizedCaseInsensitiveContains(query) ?? false)
                || (skill.category?.localizedCaseInsensitiveContains(query) ?? false)
                || (skill.description?.localizedCaseInsensitiveContains(query) ?? false)
        }
    }
}
