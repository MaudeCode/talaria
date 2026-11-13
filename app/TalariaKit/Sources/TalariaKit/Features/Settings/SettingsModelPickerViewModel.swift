import Foundation
import Observation

/// Shared Settings catalog loader, extracting the duplicated default/auxiliary loading paths.
/// ModelsSettingsViewModel's serialized optimistic writer is the sibling for preference writes.
@MainActor
@Observable
public final class SettingsModelPickerViewModel {
    public var searchText = ""
    public var providerID = ""
    public var favoritesOnly = false
    public var showHidden = false
    public private(set) var response: ModelsResponse?
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    public private(set) var preferenceError: String?

    private struct Intent {
        let id: UUID
        let value: Bool
        let profile: String
    }
    private var confirmedGroups: [ModelCatalogGroup] = []
    private var favoriteOverrides: [ModelPreference: Intent] = [:]
    private var hiddenOverrides: [ModelPreference: Intent] = [:]
    private var unresolved: Set<UUID> = []
    private var importAttempts: Set<String> = []
    private var generation = 0
    private var loadedProfile: String?
    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let favorites: ModelFavoritesStore
    @ObservationIgnored private let live: Bool
    @ObservationIgnored private var writeTask: Task<Void, Never>?

    public init(client: APIClient, favorites: ModelFavoritesStore, live: Bool = false) {
        self.client = client
        self.favorites = favorites
        self.live = live
    }

    public var providers: [ModelPickerProvider] { response?.providers ?? [] }
    public var groups: [ModelCatalogGroup] {
        confirmedGroups.compactMap { group in
            let models = group.models.compactMap { option -> ModelCatalogOption? in
                guard let identity = preferenceIdentity(option) else { return option }
                let star = favoriteOverrides[identity].flatMap { $0.profile == response?.profile ? $0.value : nil }
                let hidden = hiddenOverrides[identity].flatMap { $0.profile == response?.profile ? $0.value : nil }
                // Only the user's unconfirmed writes predict membership; confirmed filtering belongs to the server.
                if !showHidden && hidden == true || favoritesOnly && star == false { return nil }
                return option.replacingPreferences(favorite: star, hidden: hidden)
            }
            return models.isEmpty ? nil : group.replacingModels(models)
        }
    }

    @discardableResult
    public func load() async -> Bool {
        generation += 1
        let current = generation
        isLoading = true
        errorMessage = nil
        defer { if generation == current { isLoading = false } }
        do {
            var result = try await fetch()
            guard current == generation, !Task.isCancelled else { return false }
            let profile = try acceptProfile(result)
            if result.favorites == nil && !importAttempts.contains(profile) {
                importAttempts.insert(profile)
                let saved = favorites.favoriteKeys.compactMap { key -> ModelPreference? in
                    guard let provider = key.providerID, !provider.isEmpty else { return nil }
                    return ModelPreference(providerID: provider, model: key.modelID)
                }
                do {
                    let reply = try await client.importModelFavorites(saved, profile: profile)
                    if reply.ok != true { throw APIError.http(statusCode: 400, body: String(localized: "The server did not confirm the change.")) }
                } catch { if !APIError.isCancellation(error) { preferenceError = error.localizedDescription } }
                // Guarded import is never blindly replayed; a read establishes its outcome.
                result = try await fetch()
            }
            guard current == generation, !Task.isCancelled else { return false }
            try apply(result)
            favoriteOverrides = favoriteOverrides.filter { !unresolved.contains($0.value.id) }
            hiddenOverrides = hiddenOverrides.filter { !unresolved.contains($0.value.id) }
            unresolved.removeAll()
            isLoading = false
            if live {
                // Show the confirmed catalog first, as the former default picker did; live lookup never hides it.
                if let updated = try? await fetch(live: true), current == generation, !Task.isCancelled {
                    do {
                        try apply(updated)
                    } catch { errorMessage = error.localizedDescription }
                }
            }
            return true
        } catch {
            if current == generation && !APIError.isCancellation(error) { errorMessage = error.localizedDescription }
            return false
        }
    }

    public func toggleFavorite(_ option: ModelCatalogOption) async { await write(option, isFavorite: true) }
    public func toggleHidden(_ option: ModelCatalogOption) async { await write(option, isFavorite: false) }

    private func apply(_ response: ModelsResponse) throws {
        _ = try acceptProfile(response)
        confirmedGroups = response.catalogGroups
        self.response = response
    }

    /// A mounted picker and its queued row actions retain the profile that supplied them.
    private func acceptProfile(_ response: ModelsResponse) throws -> String {
        guard response.preferencesSupported == true, let profile = response.profile else {
            throw APIError.http(statusCode: 400, body: String(localized: "Update the server to manage model preferences."))
        }
        if let loadedProfile, loadedProfile != profile {
            throw APIError.http(statusCode: 409, body: String(localized: "The active profile changed. Reopen the model picker."))
        }
        loadedProfile = profile
        return profile
    }

    private func preferenceIdentity(_ option: ModelCatalogOption) -> ModelPreference? {
        guard option.preferencesEditable, let provider = option.providerID, let model = option.bareID else { return nil }
        return ModelPreference(providerID: provider, model: model)
    }

    private func fetch(live: Bool = false) async throws -> ModelsResponse {
        try await client.settingsModelPicker(search: searchText, provider: providerID, favorites: favoritesOnly, showHidden: showHidden, live: live)
    }

    private func write(_ option: ModelCatalogOption, isFavorite: Bool) async {
        guard let identity = preferenceIdentity(option), let profile = response?.profile else { return }
        let previousIntent = isFavorite ? favoriteOverrides[identity] : hiddenOverrides[identity]
        let current = previousIntent.flatMap { $0.profile == profile ? $0.value : nil } ?? (isFavorite ? option.isFavorite : option.isHidden)
        let intent = Intent(id: UUID(), value: !current, profile: profile)
        if isFavorite { favoriteOverrides[identity] = intent } else { hiddenOverrides[identity] = intent }
        preferenceError = nil
        let previous = writeTask
        let task = Task { @MainActor in
            await previous?.value
            do {
                let reply = if isFavorite {
                    try await client.setModelFavorite(identity, favorite: intent.value, profile: profile)
                } else {
                    try await client.setModelHidden(identity, hidden: intent.value, profile: profile)
                }
                if reply.ok != true { throw APIError.http(statusCode: 400, body: String(localized: "The server did not confirm the change.")) }
                // An acknowledgement alone does not replace the filtered catalog.
                unresolved.insert(intent.id)
                _ = await load()
            } catch {
                preferenceError = error.localizedDescription
                if APIError.isDefinitiveWriteFailure(error) {
                    clear(identity, id: intent.id, favorite: isFavorite)
                } else {
                    unresolved.insert(intent.id)
                    _ = await load()
                }
            }
        }
        writeTask = task
        await task.value
    }

    private func clear(_ identity: ModelPreference, id: UUID, favorite: Bool) {
        if favorite, favoriteOverrides[identity]?.id == id { favoriteOverrides.removeValue(forKey: identity) }
        if !favorite, hiddenOverrides[identity]?.id == id { hiddenOverrides.removeValue(forKey: identity) }
        unresolved.remove(id)
    }
}
