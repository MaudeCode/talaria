import Foundation
import Observation

/// Settings > Servers > Auxiliary Models (TAL-388). The server owns the task
/// list, ordering, catalog matching, and display values; this model loads and
/// writes them and keeps the last server state visible when a write fails.
@MainActor
@Observable
public final class AuxiliaryModelsViewModel {
    public private(set) var tasks: [AuxiliaryModelTask] = []
    public private(set) var isLoading = false
    /// The server predates `/api/model/auxiliary` or its typed slot fields.
    public private(set) var isUnavailable = false
    public private(set) var errorMessage: String?
    public private(set) var saveErrorMessage: String?
    public private(set) var savingTaskID: String?
    public private(set) var catalogGroups: [ModelCatalogGroup] = []
    public private(set) var catalogErrorMessage: String?
    public private(set) var isLoadingCatalog = false

    public static let resetTaskID = "__reset__"

    private let client: APIClient
    /// `load()` runs from `.task`, pull-to-refresh, and Try Again; only the newest answer applies.
    private var loadGeneration = 0

    public init(server: URL, client: APIClient? = nil) {
        self.client = client ?? APIClient(baseURL: server)
    }

    public func task(id: String) -> AuxiliaryModelTask? {
        tasks.first { $0.task == id }
    }

    public func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        errorMessage = nil
        do {
            let response = try await client.auxiliaryModels()
            guard generation == loadGeneration else { return }
            apply(response)
        } catch {
            guard generation == loadGeneration else { return }
            if case APIError.http(statusCode: 404, _) = error {
                tasks = []
                isUnavailable = true
            } else if !APIError.isCancellation(error) {
                errorMessage = error.localizedDescription
            }
        }
        isLoading = false
    }

    /// The `/api/models` catalog the server matched `selectedOptionID` against.
    public func loadCatalog() async {
        isLoadingCatalog = true
        catalogErrorMessage = nil
        do {
            catalogGroups = try await client.models().catalogGroups
        } catch {
            if !APIError.isCancellation(error) {
                catalogErrorMessage = error.localizedDescription
            }
        }
        isLoadingCatalog = false
    }

    /// Catalog groups whose models (including overflow rows) match the search text.
    public func pickerGroups(matching query: String) -> [ModelCatalogGroup] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return catalogGroups.compactMap { group in
            let rows = (group.models + group.extraModels).filter { model in
                needle.isEmpty
                    || model.displayName.lowercased().contains(needle)
                    || model.id.lowercased().contains(needle)
                    || group.name.lowercased().contains(needle)
            }
            guard !rows.isEmpty else { return nil }
            return ModelCatalogGroup(id: group.id, name: group.name, providerID: group.providerID, models: rows)
        }
    }

    /// Writes one slot; on failure the previous server state stays and the error is kept for display.
    @discardableResult
    public func save(task: String, model: String, provider: String?) async -> Bool {
        savingTaskID = task
        saveErrorMessage = nil
        defer { savingTaskID = nil }
        do {
            let response = try await client.setAuxiliaryModel(task: task, model: model, provider: provider)
            guard response.ok != false else {
                saveErrorMessage = String(localized: "The server did not confirm the change.")
                return false
            }
            if let auxiliary = response.auxiliary, auxiliary.isSupported {
                loadGeneration += 1
                apply(auxiliary)
            } else {
                await load()
            }
            return true
        } catch {
            if !APIError.isCancellation(error) {
                saveErrorMessage = error.localizedDescription
            }
            return false
        }
    }

    @discardableResult
    public func resetAll() async -> Bool {
        await save(task: Self.resetTaskID, model: "", provider: "auto")
    }

    public func clearSaveError() {
        saveErrorMessage = nil
    }

    private func apply(_ response: AuxiliaryModelsResponse) {
        isUnavailable = !response.isSupported
        tasks = response.isSupported ? response.tasks : []
    }
}
