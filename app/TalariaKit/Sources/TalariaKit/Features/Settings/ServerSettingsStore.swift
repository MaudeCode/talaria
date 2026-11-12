import Foundation
import Observation

/// Like ModelsSettingsViewModel, retains newer choices over older full-response saves.
/// One instance belongs to a Settings visit and its active server/profile.
@MainActor
@Observable
public final class ServerSettingsStore {
    public private(set) var confirmedSettings: SettingsResponse?
    public private(set) var errorMessage: String?
    public private(set) var isLoading = false

    private var overrides: [String: (id: UUID, apply: (inout SettingsResponse) -> Void)] = [:]
    private var unresolved: Set<UUID> = []
    private var generation = 0
    private var pendingWrites = 0
    private var didLoad = false
    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private var initialLoad: Task<Void, Never>?
    @ObservationIgnored private var writeTask: Task<Void, Never>?

    public init(client: APIClient) { self.client = client }

    public var settings: SettingsResponse? {
        guard var result = confirmedSettings else { return nil }
        for patch in overrides.values { patch.apply(&result) }
        return result
    }

    public func loadIfNeeded() async {
        if let initialLoad { await initialLoad.value; return }
        guard !didLoad else { return }
        let task = Task { await load() }
        initialLoad = task
        await task.value
        didLoad = true
        initialLoad = nil
    }

    public func load() async {
        while pendingWrites > 0 { await writeTask?.value }
        generation += 1
        let current = generation
        isLoading = true
        errorMessage = nil
        defer { if generation == current { isLoading = false } }
        do {
            let response = try await client.settings()
            guard generation == current else { return }
            confirmedSettings = response
            clearResolvedOverrides()
        } catch {
            guard generation == current else { return }
            if !APIError.isCancellation(error) { errorMessage = error.localizedDescription }
        }
    }

    @discardableResult
    public func setAgentApprovals(_ value: Bool) -> Task<Void, Never> {
        save("agent_approvals", \.agentApprovals, value)
    }
    @discardableResult
    public func setCompressionPrepareAhead(_ value: Bool) -> Task<Void, Never> {
        save("compression_prepare_ahead", \.compressionPrepareAhead, value)
    }
    @discardableResult
    public func setAutoTitleRefreshEvery(_ value: String) -> Task<Void, Never> {
        save("auto_title_refresh_every", \.autoTitleRefreshEvery, value)
    }
    @discardableResult
    public func setCheckForUpdates(_ value: Bool) -> Task<Void, Never> {
        save("check_for_updates", \.checkForUpdates, value)
    }
    @discardableResult
    public func setAutoApplyUpdates(_ value: Bool) -> Task<Void, Never> {
        save("auto_apply_updates", \.autoApplyUpdates, value)
    }
    @discardableResult
    public func setSummarizeUpdatesAutomatically(_ value: Bool) -> Task<Void, Never> {
        save("summarize_updates_automatically", \.summarizeUpdatesAutomatically, value)
    }
    @discardableResult
    public func setUpdateChannel(_ value: String) -> Task<Void, Never> {
        save("update_channel", \.updateChannel, value)
    }
    @discardableResult
    public func setAgentUpdateChannel(_ value: String) -> Task<Void, Never> {
        save("agent_update_channel", \.agentUpdateChannel, value)
    }
    @discardableResult
    public func setIgnoreAgentUpdates(_ value: Bool) -> Task<Void, Never> {
        save("ignore_agent_updates", \.ignoreAgentUpdates, value)
    }
    @discardableResult
    public func setQuotaThresholds(_ value: ProviderQuotaThresholds) -> Task<Void, Never> {
        save("provider_quota_thresholds", \.providerQuotaThresholds, value)
    }
    @discardableResult
    public func setMaxTokensText(_ text: String) -> Task<Void, Never>? {
        guard text.isEmpty || Int(text) != nil else {
            errorMessage = String(localized: "Enter a whole number or leave blank for no limit.")
            return nil
        }
        return save("max_tokens", \.maxTokens, text.isEmpty ? nil : Int(text))
    }

    private func save<Value: Encodable>(
        _ key: String, _ path: WritableKeyPath<SettingsResponse, Value>, _ value: Value
    ) -> Task<Void, Never> {
        let id = UUID()
        overrides[key] = (id, { $0[keyPath: path] = value })
        generation += 1
        isLoading = false
        errorMessage = nil
        pendingWrites += 1
        let previous = writeTask
        let task = Task {
            await previous?.value
            defer { pendingWrites -= 1 }
            do {
                confirmedSettings = try await client.send(endpoint: .settings, method: "POST", body: [key: value])
                clearOverride(id)
                clearResolvedOverrides()
            } catch {
                if APIError.isDefinitiveWriteFailure(error) {
                    clearOverride(id)
                } else {
                    // Never replay an unknown write. A read determines whether the choice was stored.
                    do {
                        confirmedSettings = try await client.settings()
                        clearOverride(id)
                        clearResolvedOverrides()
                    } catch { unresolved.insert(id) }
                }
                errorMessage = error.localizedDescription
            }
        }
        writeTask = task
        return task
    }

    private func clearOverride(_ id: UUID) {
        overrides = overrides.filter { $0.value.id != id }
        unresolved.remove(id)
    }

    private func clearResolvedOverrides() {
        for id in unresolved { clearOverride(id) }
    }
}
