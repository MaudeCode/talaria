import Foundation
import Observation

/// The collection sibling of ServerSettingsStore: profile identity and removals need row effects, not setting keys.
@MainActor
@Observable
public final class ProfilesSettingsModel {
    public var errorMessage: String?
    public private(set) var isLoading = false
    private var confirmed = ProfilesResponse(profiles: [], active: nil)
    private var effects: [(id: UUID, action: Action)] = []
    private var unresolved: Set<UUID> = []
    private var generation = 0
    private var pendingWrites = 0
    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private var writeTask: Task<ProfileSwitchResponse?, Never>?

    private enum Action {
        case edit(String, String?, String)
        case delete(String)
        case use(String)

        var name: String {
            switch self {
            case let .edit(name, _, _), let .delete(name), let .use(name): name
            }
        }
    }

    public init(client: APIClient) { self.client = client }

    public var profiles: [ProfileSummary] {
        var rows = confirmed.profiles ?? []
        for effect in effects {
            switch effect.action {
            case let .delete(name): rows.removeAll { $0.name == name }
            case let .edit(name, displayName, description):
                if let index = rows.firstIndex(where: { $0.name == name }) {
                    if let displayName { rows[index].botDisplayName = displayName }
                    rows[index].description = description
                }
            case .use: break
            }
        }
        return rows
    }

    public var activeName: String? {
        for effect in effects.reversed() {
            if case let .use(name) = effect.action { return name }
        }
        return confirmed.active
    }
    public var isSingleProfileMode: Bool { confirmed.singleProfileMode == true }

    public func canDelete(_ profile: ProfileSummary) -> Bool {
        !isSingleProfileMode && profile.name != nil && profile.isDefault == false
            && profile.isActive != true && (profile.isActive == false || activeName != nil)
            && profile.name != activeName
    }

    public func load() async {
        while pendingWrites > 0 { _ = await writeTask?.value }
        generation += 1
        let current = generation
        isLoading = true
        defer { if generation == current { isLoading = false } }
        do {
            let response = try await client.profiles()
            guard current == generation else { return }
            confirmed = response
            effects.removeAll { unresolved.contains($0.id) }
            unresolved.removeAll()
        } catch {
            guard current == generation, !APIError.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    public func appendCreated(_ profile: ProfileSummary) {
        guard !(confirmed.profiles ?? []).contains(where: { $0.name == profile.name }) else { return }
        confirmed = ProfilesResponse(profiles: (confirmed.profiles ?? []) + [profile], active: confirmed.active,
                                     singleProfileMode: confirmed.singleProfileMode)
    }

    @discardableResult
    public func edit(_ profile: ProfileSummary, displayName: String, description: String) -> Task<ProfileSwitchResponse?, Never>? {
        guard let name = profile.name, !isSingleProfileMode,
              displayName.unicodeScalars.count <= ProfileNameRules.displayNameLimit,
              description.unicodeScalars.count <= ProfileNameRules.descriptionLimit else { return nil }
        return mutate(.edit(name, profile.displayNameOverridden == true ? nil : displayName, description))
    }

    @discardableResult
    public func delete(_ profile: ProfileSummary) -> Task<ProfileSwitchResponse?, Never>? {
        guard canDelete(profile), let name = profile.name else { return nil }
        return mutate(.delete(name))
    }

    @discardableResult
    public func use(_ profile: ProfileSummary) -> Task<ProfileSwitchResponse?, Never>? {
        guard let name = profile.name else { return nil }
        return mutate(.use(name))
    }

    private func mutate(_ action: Action) -> Task<ProfileSwitchResponse?, Never> {
        let id = UUID()
        effects.append((id, action))
        generation += 1
        isLoading = false
        errorMessage = nil
        pendingWrites += 1
        let previous = writeTask
        let task = Task { () -> ProfileSwitchResponse? in
            _ = await previous?.value
            defer { pendingWrites -= 1 }
            do {
                var switched: ProfileSwitchResponse?
                switch action {
                case let .edit(name, displayName, description):
                    let response = try await client.updateProfile(name: name, displayName: displayName, description: description)
                    if response.ok == false || response.error != nil {
                        throw APIError.http(statusCode: 400, body: response.error)
                    }
                    if let row = response.profile {
                        replace(row)
                    } else { confirmed = try await client.profiles() }
                case let .delete(name):
                    let response = try await client.deleteProfile(name: name)
                    if response.ok == false || response.error != nil {
                        throw APIError.http(statusCode: 400, body: response.error)
                    }
                    confirmed = ProfilesResponse(profiles: confirmed.profiles?.filter { $0.name != name }, active: confirmed.active,
                                                 singleProfileMode: confirmed.singleProfileMode)
                case let .use(name):
                    let response = try await client.switchProfile(name: name)
                    if let error = response.error { throw APIError.http(statusCode: 400, body: error) }
                    switched = response
                    confirmed = ProfilesResponse(profiles: response.profiles ?? confirmed.profiles,
                                                 active: response.active ?? name,
                                                 singleProfileMode: confirmed.singleProfileMode)
                    // Only the list owns presentation fields such as name_differs.
                    confirmed = (try? await client.profiles()) ?? confirmed
                }
                effects.removeAll { $0.id == id || (unresolved.contains($0.id) && $0.action.name == action.name) }
                unresolved.formIntersection(Set(effects.map(\.id)))
                return switched
            } catch {
                if APIError.isDefinitiveWriteFailure(error) {
                    effects.removeAll { $0.id == id }
                } else {
                    // Reconcile once. A failed read retains this display until a later successful refresh.
                    do {
                        confirmed = try await client.profiles()
                        effects.removeAll { $0.id == id || unresolved.contains($0.id) }
                        unresolved.removeAll()
                    } catch { unresolved.insert(id) }
                }
                errorMessage = error.localizedDescription
                return nil
            }
        }
        writeTask = task
        return task
    }

    private func replace(_ row: ProfileSummary) {
        var rows = confirmed.profiles ?? []
        if let index = rows.firstIndex(where: { $0.name == row.name }) { rows[index] = row }
        confirmed = ProfilesResponse(profiles: rows, active: confirmed.active, singleProfileMode: confirmed.singleProfileMode)
    }
}
