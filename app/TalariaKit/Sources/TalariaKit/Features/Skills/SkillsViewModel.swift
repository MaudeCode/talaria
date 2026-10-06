import Foundation
import Observation

@MainActor
@Observable
public final class SkillsViewModel {
    private var loadGeneration = 0
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
        skills = responseCache?.entry(ResponseCache.Kind.skills).load(SkillsResponse.self)?.skills ?? []
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
        } catch {
            guard generation == loadGeneration, !APIError.isCancellation(error) else { return }
            lastError = error
            errorMessage = error.localizedDescription
        }
    }

    var groupedSkills: [(category: String, skills: [SkillSummary])] {
        Self.groupedSkills(for: skills)
    }

    public func filteredGroupedSkills(searchText: String) -> [(category: String, skills: [SkillSummary])] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return groupedSkills }

        let filtered = skills.filter { skill in
            let name = skill.name?.localizedCaseInsensitiveContains(query) ?? false
            let description = skill.description?.localizedCaseInsensitiveContains(query) ?? false
            let category = skill.category?.localizedCaseInsensitiveContains(query) ?? false
            let tags = skill.tags?.contains { $0.localizedCaseInsensitiveContains(query) } ?? false
            return name || description || category || tags
        }

        guard !filtered.isEmpty else { return [] }

        return Self.groupedSkills(for: filtered)
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

    static func groupedSkills(for skills: [SkillSummary]) -> [(category: String, skills: [SkillSummary])] {
        let grouped = Dictionary(grouping: skills, by: categoryName(for:))
        return grouped
            .sorted {
                $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending
            }
            .map { (category: $0.key, skills: sortedSkills($0.value)) }
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
