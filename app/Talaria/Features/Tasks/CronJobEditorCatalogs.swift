import Foundation
import Observation
import TalariaKit

/// The model catalog, profile list, and skill list behind the task editor's
/// Configuration section. Owned by `CronJobEditorSheet` and loaded from its
/// `.task`, so the requests happen when the editor opens rather than when the
/// task list appears. Create and edit share the same sheet, so they share this
/// loader instead of each view model growing its own copy.
///
/// Each load is independent and non-fatal: a failed catalog leaves the model
/// picker with its custom entry, a failed profile list falls back to free
/// text, and a failed skill list keeps the saved skills plus custom entry.
@MainActor
@Observable
final class CronJobEditorCatalogs {
    private(set) var modelGroups: [ModelCatalogGroup] = []
    /// `nil` while unknown or when `/api/profiles` failed, which keeps the
    /// editor's free-text profile fallback.
    private(set) var profiles: [ProfileSummary]?
    /// Enabled skills only: a disabled skill would be ignored by the run.
    private(set) var skills: [SkillSummary] = []
    private(set) var isLoading = false
    /// Per-catalog failures. A cancelled load (sheet dismissed mid-flight)
    /// is not reported.
    private(set) var modelsErrorMessage: String?
    private(set) var profilesErrorMessage: String?
    private(set) var skillsErrorMessage: String?

    /// The first catalog failure, shown under the Configuration section with
    /// a retry.
    var errorMessage: String? {
        modelsErrorMessage ?? profilesErrorMessage ?? skillsErrorMessage
    }

    private let client: APIClient

    init(client: APIClient) {
        self.client = client
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        async let modelsError = loadModels()
        async let profilesError = loadProfiles()
        async let skillsError = loadSkills()
        (modelsErrorMessage, profilesErrorMessage, skillsErrorMessage) = await (modelsError, profilesError, skillsError)
    }

    private func loadModels() async -> String? {
        do {
            modelGroups = try await client.models().catalogGroups
            return nil
        } catch {
            return Self.failureMessage(error)
        }
    }

    private func loadProfiles() async -> String? {
        do {
            profiles = try await client.profiles().profiles ?? []
            return nil
        } catch {
            return Self.failureMessage(error)
        }
    }

    private func loadSkills() async -> String? {
        do {
            skills = (try await client.skills().skills ?? []).filter { $0.disabled != true }
            return nil
        } catch {
            return Self.failureMessage(error)
        }
    }

    private static func failureMessage(_ error: Error) -> String? {
        APIError.isCancellation(error) ? nil : error.localizedDescription
    }
}
