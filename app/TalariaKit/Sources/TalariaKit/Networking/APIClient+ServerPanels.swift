import Foundation

extension APIClient {
    public func models() async throws -> ModelsResponse {
        try await send(endpoint: .models, method: "GET")
    }

    public func models(caching cache: ResponseCache.Entry?) async throws -> ModelsResponse {
        try await send(endpoint: .models, caching: cache)
    }

    /// Live (uncached) model list for the active provider. The server resolves
    /// the provider itself when no `provider` param is sent and echoes it back,
    /// so callers can match the result against the cached catalog's groups.
    public func modelsLive() async throws -> ModelsLiveResponse {
        try await send(endpoint: .modelsLive, method: "GET")
    }

    public func commands() async throws -> CommandsResponse {
        try await send(endpoint: .commands, method: "GET")
    }

    public func commands(caching cache: ResponseCache.Entry?) async throws -> CommandsResponse {
        try await send(endpoint: .commands, caching: cache)
    }

    /// Saves the default model. Pass `provider` whenever the row names its
    /// provider (`provider_id` from the catalog group): Core persists
    /// `{model, provider}` atomically and resolves slash-qualified ids like
    /// `anthropic/...` through the named provider's route. Without it such an
    /// id can be persisted through the wrong provider.
    public func saveDefaultModel(model: String, provider: String? = nil) async throws -> DefaultModelResponse {
        try await send(
            endpoint: .defaultModel,
            method: "POST",
            body: DefaultModelRequest(model: model, provider: provider)
        )
    }

    /// The active profile's auxiliary task slots (`GET /api/model/auxiliary`, TAL-388).
    public func auxiliaryModels() async throws -> AuxiliaryModelsResponse {
        try await send(endpoint: .auxiliaryModels, method: "GET")
    }

    /// Saves one auxiliary task slot (`__reset__` returns every slot to Auto).
    /// `model` is a catalog entry id or a typed id and `provider` the entry's
    /// group `provider_id`; the server splits `@provider:` ids itself. Auto is
    /// provider `auto` with an empty model. Answers the refreshed slots.
    public func setAuxiliaryModel(task: String, model: String, provider: String?) async throws -> AuxiliaryModelSetResponse {
        try await send(
            endpoint: .setModel,
            method: "POST",
            body: AuxiliaryModelSetRequest(scope: "auxiliary", task: task, model: model, provider: provider)
        )
    }

    /// Reasoning status for a specific model/provider (`GET /api/reasoning`).
    /// Passing the session's current model + provider makes `supported_efforts`
    /// model-accurate (mirrors the upstream WebUI composer chip, issue #18);
    /// with no params the server resolves the config default model instead.
    public func reasoning(model: String? = nil, provider: String? = nil) async throws -> ReasoningStatusResponse {
        try await send(endpoint: .reasoning(model: model, provider: provider), method: "GET")
    }

    public func saveReasoningEffort(_ effort: String) async throws -> ReasoningStatusResponse {
        try await send(
            endpoint: .reasoning(),
            method: "POST",
            body: ReasoningEffortRequest(effort: effort)
        )
    }

    public func saveReasoningDisplay(_ display: String) async throws -> ReasoningStatusResponse {
        try await send(
            endpoint: .reasoning(),
            method: "POST",
            body: ReasoningDisplayRequest(display: display)
        )
    }

    public func personalities() async throws -> PersonalitiesResponse {
        try await send(endpoint: .personalities, method: "GET")
    }

    public func setPersonality(sessionID: String, name: String) async throws -> PersonalitySetResponse {
        try await send(
            endpoint: .setPersonality,
            method: "POST",
            body: PersonalitySetRequest(sessionId: sessionID, name: name)
        )
    }

    public func profiles() async throws -> ProfilesResponse {
        try await profiles(caching: nil)
    }

    public func profiles(caching cache: ResponseCache.Entry?) async throws -> ProfilesResponse {
        let switchCount = ActiveServerProfile.switchCount(for: baseURL)
        let response: ProfilesResponse = try await send(endpoint: .profiles, caching: cache)
        ActiveServerProfile.record(response.effectiveDefaultProfileName, for: baseURL, ifNoSwitchSince: switchCount)
        return response
    }

    public func switchProfile(name: String) async throws -> ProfileSwitchResponse {
        let response: ProfileSwitchResponse = try await send(
            endpoint: .switchProfile,
            method: "POST",
            body: ProfileSwitchRequest(name: name)
        )
        if response.error == nil {
            ActiveServerProfile.record(
                ProfilesResponse(profiles: nil, active: response.active).effectiveDefaultProfileName ?? name,
                for: baseURL
            )
            try persistCookies()
            try forgetProfileOwner()
            if ProviderQuotaWidgetSnapshotStore().clear() {
                ProviderQuotaWidgetSnapshotStore.reloadTimelines()
            }
        }
        return response
    }

    /// Creates a new profile (`POST /api/profile/create`), mirroring the webui's
    /// create form payload: `clone_config` is always sent, everything else only
    /// when provided (`clone_from` is intentionally omitted — the server clones
    /// from the active profile). Rejected with 403 in single-profile mode.
    public func createProfile(
        name: String,
        cloneConfig: Bool = false,
        defaultModel: String? = nil,
        modelProvider: String? = nil,
        baseUrl: String? = nil,
        apiKey: String? = nil
    ) async throws -> ProfileCreateResponse {
        try await send(
            endpoint: .createProfile,
            method: "POST",
            body: ProfileCreateRequest(
                name: name,
                cloneConfig: cloneConfig,
                defaultModel: defaultModel,
                modelProvider: modelProvider,
                baseUrl: baseUrl,
                apiKey: apiKey
            )
        )
    }

    public func providers() async throws -> ProvidersResponse {
        try await send(endpoint: .providers, method: "GET")
    }

    public func providerQuotas(sourceID: String? = nil, refresh: Bool = false) async throws -> ProviderQuotasResponse {
        try await send(
            endpoint: .providerQuotas(sourceID: sourceID, refresh: refresh),
            method: "GET"
        )
    }

    public func settings() async throws -> SettingsResponse {
        try await send(endpoint: .settings, method: "GET")
    }

    /// Saves the request profile's quota thresholds; the server validates and clamps them and answers the stored set.
    public func saveProviderQuotaThresholds(_ thresholds: ProviderQuotaThresholds) async throws -> SettingsResponse {
        try await send(endpoint: .settings, method: "POST", body: ProviderQuotaThresholdsSaveRequest(providerQuotaThresholds: thresholds))
    }

    public func updatesCheck() async throws -> UpdatesCheckResponse {
        try await send(endpoint: .updatesCheck, method: "GET")
    }

    /// Forces a *live* update check: `POST /api/updates/check` with `{ "force": true }`.
    /// Upstream runs a real `git fetch` for this path (`check_for_updates(force=True)`),
    /// whereas the plain GET only returns the cached status. Same response shape, so
    /// `UpdatesCheckResponse` is reused. Used by the manual "Check for updates" button (#308).
    public func updatesCheckForced() async throws -> UpdatesCheckResponse {
        try await send(
            endpoint: .updatesCheck,
            method: "POST",
            body: UpdatesCheckForceRequest(force: true)
        )
    }

    /// Applies a pending repo update. The server pulls `--ff-only` and then
    /// restarts itself, so the caller must tolerate a brief connection outage
    /// and re-poll afterwards. Defaults to the `webui` target (issue #180 scope;
    /// no `agent` target, `/force`, or `/summary`).
    public func applyUpdate(target: String = "webui") async throws -> UpdatesApplyResponse {
        try await send(
            endpoint: .updatesApply,
            method: "POST",
            body: UpdatesApplyRequest(target: target)
        )
    }

    public func updateNotifications() async throws -> UpdateNotificationsResponse {
        try await send(endpoint: .updateNotifications, method: "GET")
    }

    public func clearUpdateNotifications() async throws -> UpdateNotificationsResponse {
        try await send(endpoint: .updateNotificationsClear, method: "POST", body: UpdateNotificationsClearRequest(clear: true))
    }

    public func readUpdateNotification(id: String) async throws -> UpdateNotificationRecord {
        try await send(endpoint: .updateNotificationRead(id: id), method: "POST", body: UpdateNotificationReadRequest(read: true))
    }

    public func dismissUpdateNotification(id: String) async throws -> UpdateNotificationDismissResponse {
        try await send(endpoint: .updateNotificationDismiss(id: id), method: "POST", body: UpdateNotificationDismissRequest(dismiss: true))
    }

    public func performUpdateNotificationAction(id: String, actionID: String) async throws -> UpdateNotificationRecord {
        try await send(endpoint: .updateNotificationAction(id: id, actionID: actionID), method: "POST", body: UpdateNotificationActionRequest(perform: true))
    }

    public func insights(days: Int) async throws -> InsightsResponse {
        try await send(endpoint: .insights(days: days), method: "GET")
    }
}

private struct AuxiliaryModelSetRequest: Encodable {
    let scope: String
    let task: String
    let model: String
    let provider: String?
}

private struct DefaultModelRequest: Encodable {
    let model: String
    /// The catalog row's provider, so the server persists `{model, provider}`
    /// atomically and resolves slash-qualified ids through the right route.
    /// Surface split, verified in source: the compatibility pin
    /// (`f1d399b4`, `routes.py:4475`) reads only `body.get("model")` and
    /// silently ignores the extra key; `set_hermes_default_model` accepts
    /// `provider` from upstream HEAD `a00b02f` (`api/config.py:4780`).
    /// Optional so a providerless custom-model save still sends the bare
    /// `{model}` body; synthesized Encodable omits nil keys.
    let provider: String?
}

private struct ReasoningEffortRequest: Encodable {
    let effort: String
}

private struct UpdateNotificationReadRequest: Encodable { let read: Bool }
private struct UpdateNotificationsClearRequest: Encodable { let clear: Bool }
private struct UpdateNotificationDismissRequest: Encodable { let dismiss: Bool }
private struct UpdateNotificationActionRequest: Encodable { let perform: Bool }

private struct ReasoningDisplayRequest: Encodable {
    let display: String
}

private struct PersonalitySetRequest: Encodable {
    let sessionId: String
    let name: String
}

private struct ProfileSwitchRequest: Encodable {
    let name: String
}

private struct ProfileCreateRequest: Encodable {
    let name: String
    let cloneConfig: Bool
    let defaultModel: String?
    let modelProvider: String?
    let baseUrl: String?
    let apiKey: String?
}

private struct UpdatesApplyRequest: Encodable {
    let target: String
}

private struct UpdatesCheckForceRequest: Encodable {
    let force: Bool
}

private struct ProviderQuotaThresholdsSaveRequest: Encodable {
    let providerQuotaThresholds: ProviderQuotaThresholds
}
