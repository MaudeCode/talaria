import Foundation

struct ChatComposerConfigState: Equatable, Sendable {
    var currentWorkspace: String?
    var currentModel: String?
    var currentModelProvider: String?
    var currentProfile: String?
    var selectedProfileName: String?
    var selectedReasoningEffort: String?
    /// Model-aware effort vocabulary (`supported_efforts`); `nil` on older
    /// servers → composer falls back to the full static list (issue #18).
    var supportedReasoningEfforts: [String]?
    /// `supports_reasoning_effort`; `false` hides the effort control, `nil`
    /// (older servers) keeps it visible.
    var supportsReasoningEffort: Bool?
    var modelCatalogGroups: [ModelCatalogGroup]
    var agentCommands: [AgentCommand]
    var workspaceRoots: [WorkspaceRoot]
    var workspaceSuggestions: [String]
    var profileOptions: [ProfileSummary]
    var isSingleProfileMode: Bool

    init(
        currentWorkspace: String? = nil,
        currentModel: String? = nil,
        currentModelProvider: String? = nil,
        currentProfile: String? = nil,
        selectedProfileName: String? = nil,
        selectedReasoningEffort: String? = nil,
        supportedReasoningEfforts: [String]? = nil,
        supportsReasoningEffort: Bool? = nil,
        modelCatalogGroups: [ModelCatalogGroup] = [],
        agentCommands: [AgentCommand] = [],
        workspaceRoots: [WorkspaceRoot] = [],
        workspaceSuggestions: [String] = [],
        profileOptions: [ProfileSummary] = [],
        isSingleProfileMode: Bool = false
    ) {
        self.currentWorkspace = currentWorkspace
        self.currentModel = currentModel
        self.currentModelProvider = currentModelProvider
        self.currentProfile = currentProfile
        self.selectedProfileName = selectedProfileName
        self.selectedReasoningEffort = selectedReasoningEffort
        self.supportedReasoningEfforts = supportedReasoningEfforts
        self.supportsReasoningEffort = supportsReasoningEffort
        self.modelCatalogGroups = modelCatalogGroups
        self.agentCommands = agentCommands
        self.workspaceRoots = workspaceRoots
        self.workspaceSuggestions = workspaceSuggestions
        self.profileOptions = profileOptions
        self.isSingleProfileMode = isSingleProfileMode
    }
}

struct ChatComposerConfigLoadResult: Sendable {
    let state: ChatComposerConfigState
    let configurationError: Error?
}

struct ChatComposerConfigLoader {
    private let client: APIClient
    private let cache: ResponseCache?

    init(client: APIClient, cache: ResponseCache? = nil) {
        self.client = client
        self.cache = cache
    }

    /// The catalogs the last load saw, so a chat's profile, model, workspace and command choices
    /// show before they load (TAL-437). It fills only empty catalogs and the selected profile
    /// name, which the live load always resolves again; current selections stay as they are,
    /// because the live load fills those only while they are empty.
    static func cachedState(from initialState: ChatComposerConfigState, cache: ResponseCache) -> ChatComposerConfigState {
        var state = initialState
        if state.profileOptions.isEmpty,
           let profiles = cache.entry(ResponseCache.Kind.profiles).load(ProfilesResponse.self) {
            state.profileOptions = profiles.profiles ?? []
            state.isSingleProfileMode = profiles.singleProfileMode ?? false
            state.selectedProfileName = selectedProfileName(currentProfile: state.currentProfile, profiles: profiles)
        }
        if state.modelCatalogGroups.isEmpty,
           let models = cache.entry(ResponseCache.Kind.models).load(ModelsResponse.self) {
            state.modelCatalogGroups = models.catalogGroups
        }
        if state.workspaceRoots.isEmpty,
           let workspaces = cache.entry(ResponseCache.Kind.workspaces).load(WorkspacesResponse.self) {
            state.workspaceRoots = workspaces.workspaces ?? []
            state.workspaceSuggestions = state.workspaceRoots.compactMap(\.path)
        }
        if state.agentCommands.isEmpty,
           let commands = cache.entry(ResponseCache.Kind.commands).load(CommandsResponse.self) {
            state.agentCommands = commands.commands ?? []
        }
        return state
    }

    private static func selectedProfileName(currentProfile: String?, profiles: ProfilesResponse) -> String? {
        nonEmpty(currentProfile) ?? nonEmpty(profiles.active) ?? profiles.effectiveDefaultProfileName
    }

    func loadConfiguration(from initialState: ChatComposerConfigState) async -> ChatComposerConfigLoadResult {
        var state = initialState
        var configurationError: Error?

        do {
            let profilesResponse = try await client.profiles(caching: cache?.entry(ResponseCache.Kind.profiles))
            state.profileOptions = profilesResponse.profiles ?? []
            state.isSingleProfileMode = profilesResponse.singleProfileMode ?? false
            state.selectedProfileName = Self.selectedProfileName(
                currentProfile: state.currentProfile,
                profiles: profilesResponse
            )

            if let sessionProfile = Self.nonEmpty(state.currentProfile),
               Self.nonEmpty(profilesResponse.active) != sessionProfile {
                let switchResponse = try await client.switchProfile(name: sessionProfile)
                state.profileOptions = switchResponse.profiles ?? state.profileOptions
                state.selectedProfileName = Self.nonEmpty(switchResponse.active) ?? sessionProfile
                state.currentProfile = state.selectedProfileName

                if state.currentWorkspace == nil {
                    state.currentWorkspace = Self.nonEmpty(switchResponse.defaultWorkspace)
                }

                if state.currentModel == nil {
                    state.currentModel = Self.nonEmpty(switchResponse.defaultModel)
                }
            }

            let selectedProfile = Self.profileSummary(
                matching: state.selectedProfileName,
                in: state.profileOptions
            )
            if state.currentModel == nil {
                state.currentModel = Self.nonEmpty(selectedProfile?.model)
            }

            let modelsResponse = try await client.models(caching: cache?.entry(ResponseCache.Kind.models))
            state.modelCatalogGroups = modelsResponse.catalogGroups
            if state.currentModel == nil {
                state.currentModel = modelsResponse.defaultModel
            }
            if Self.nonEmpty(state.currentModelProvider) == nil {
                state.currentModelProvider = Self.nonEmpty(selectedProfile?.provider)
                    ?? Self.uniqueProvider(for: state.currentModel, in: state.modelCatalogGroups)
            }

            // Scope the query to the session's resolved model/provider so the
            // gating fields are model-accurate (issue #18); the seeded effort is
            // the server's already-coerced value for that model.
            let reasoningResponse = try await client.reasoning(
                model: Self.nonEmpty(state.currentModel),
                provider: Self.nonEmpty(state.currentModelProvider)
            )
            state.selectedReasoningEffort = reasoningResponse.effectiveEffort
            state.supportedReasoningEfforts = reasoningResponse.normalizedSupportedEfforts
            state.supportsReasoningEffort = reasoningResponse.supportsReasoningEffort

            let workspaceResponse = try await client.workspaces(caching: cache?.entry(ResponseCache.Kind.workspaces))
            state.workspaceRoots = workspaceResponse.workspaces ?? []
            if state.currentWorkspace == nil {
                state.currentWorkspace = workspaceResponse.last ?? state.workspaceRoots.compactMap(\.path).first
            }
            state.workspaceSuggestions = state.workspaceRoots.compactMap(\.path)
        } catch {
            configurationError = error
        }

        do {
            state.agentCommands = (try await client.commands(caching: cache?.entry(ResponseCache.Kind.commands))).commands ?? []
        } catch {
            state.agentCommands = []
        }

        return ChatComposerConfigLoadResult(
            state: state,
            configurationError: configurationError
        )
    }

    private static func profileSummary(
        matching profileName: String?,
        in profileOptions: [ProfileSummary]
    ) -> ProfileSummary? {
        guard let profileName = nonEmpty(profileName) else { return nil }
        return profileOptions.first { $0.normalizedName == profileName }
    }

    private static func uniqueProvider(
        for modelID: String?,
        in groups: [ModelCatalogGroup]
    ) -> String? {
        guard let modelID = nonEmpty(modelID) else { return nil }
        let providers = Set(
            groups
                .flatMap(\.slashAutocompleteModels)
                .filter { $0.id == modelID }
                .compactMap { nonEmpty($0.providerID) }
        )
        return providers.count == 1 ? providers.first : nil
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}
