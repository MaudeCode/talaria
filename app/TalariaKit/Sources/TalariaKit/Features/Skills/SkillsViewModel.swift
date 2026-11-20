import Foundation
import Observation

@MainActor
@Observable
public final class SkillsViewModel {
    private var loadGeneration = 0
    private var categoryGroups: [SkillCategoryGroup]?
    public private(set) var skills: [SkillSummary] = []
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    public private(set) var lastError: Error?
    public private(set) var togglingSkillNames: Set<String> = []

    private let client: APIClient
    private let responseCache: ResponseCache?

    public convenience init(server: URL, responseCache: ResponseCache? = nil) {
        self.init(client: APIClient(baseURL: server), responseCache: responseCache)
    }

    public init(client: APIClient, responseCache: ResponseCache? = nil) {
        self.client = client
        self.responseCache = responseCache
        // The last list shows at once (TAL-437); `load` replaces it.
        let cached = responseCache?.entry(ResponseCache.Kind.skills).load(SkillsResponse.self)
        skills = cached?.skills ?? []
        categoryGroups = cached?.categoryGroups
    }

    public func load() async {
        // The view model outlives its screen (TAL-643): a rebuilt screen starts a new load while
        // the old one may still be in flight, so only the latest load updates the model.
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        errorMessage = nil
        lastError = nil
        defer {
            if generation == loadGeneration { isLoading = false }
        }

        do {
            let response = try await client.skills(caching: responseCache?.entry(ResponseCache.Kind.skills))
            guard generation == loadGeneration else { return }
            skills = response.skills ?? []
            categoryGroups = response.categoryGroups
        } catch {
            guard generation == loadGeneration, !APIError.isCancellation(error) else { return }
            lastError = error
            errorMessage = error.localizedDescription
        }
    }

    public func filteredGroupedSkills(searchText: String) -> [(category: String?, skills: [SkillSummary])] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = skills.filter { skill in
            guard !query.isEmpty else { return true }
            let name = skill.name?.localizedCaseInsensitiveContains(query) ?? false
            let description = skill.description?.localizedCaseInsensitiveContains(query) ?? false
            let category = skill.category?.localizedCaseInsensitiveContains(query) ?? false
            let tags = skill.tags?.contains { $0.localizedCaseInsensitiveContains(query) } ?? false
            return name || description || category || tags
        }

        // Older servers and previously cached responses have no category groups.
        guard let categoryGroups else { return Self.groupedSkills(for: filtered) }
        var rowsByName: [String: SkillSummary] = [:]
        for skill in filtered {
            if let name = skill.name { rowsByName[name] = skill }
        }
        return categoryGroups.compactMap { group in
            let rows = group.names.compactMap { rowsByName[$0] }
            return rows.isEmpty ? nil : (group.category, rows)
        }
    }

    public func setSkill(_ skill: SkillSummary, enabled: Bool) async {
        guard let name = skill.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return }
        guard togglingSkillNames.insert(name).inserted else { return }

        lastError = nil
        errorMessage = nil
        updateSkill(named: name, disabled: !enabled)
        defer { togglingSkillNames.remove(name) }

        do {
            _ = try await client.toggleSkill(name: name, enabled: enabled)
            await load()
        } catch {
            updateSkill(named: name, disabled: enabled)
            lastError = error
            errorMessage = error.localizedDescription
        }
    }

    private static func groupedSkills(for skills: [SkillSummary]) -> [(category: String?, skills: [SkillSummary])] {
        let grouped = Dictionary(grouping: skills, by: categoryName(for:))
        return grouped
            .sorted {
                $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending
            }
            .map { (category: Optional($0.key), skills: sortedSkills($0.value)) }
    }

    private static func categoryName(for skill: SkillSummary) -> String {
        let category = skill.category?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let category, !category.isEmpty else {
            return String(localized: "Uncategorized")
        }
        return category
    }

    private static func sortedSkills(_ skills: [SkillSummary]) -> [SkillSummary] {
        skills.sorted { lhs, rhs in
            displayName(for: lhs).localizedCaseInsensitiveCompare(displayName(for: rhs)) == .orderedAscending
        }
    }

    private static func displayName(for skill: SkillSummary) -> String {
        let name = skill.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let name, !name.isEmpty else {
            return String(localized: "Unnamed Skill")
        }
        return name
    }

    private func updateSkill(named name: String, disabled: Bool) {
        skills = skills.map { skill in
            guard skill.name?.trimmingCharacters(in: .whitespacesAndNewlines) == name else { return skill }
            return SkillSummary(
                name: skill.name,
                category: skill.category,
                description: skill.description,
                path: skill.path,
                disabled: disabled,
                tags: skill.tags,
                relatedSkills: skill.relatedSkills
            )
        }
    }
}
