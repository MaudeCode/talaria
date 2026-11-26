import Foundation
import Observation

/// Like ModelsSettingsViewModel, retains newer choices over older full-response saves.
/// One instance belongs to a Settings visit and its active server/profile.
@MainActor
@Observable
public final class ServerSettingsStore {
    public private(set) var confirmedSettings: SettingsResponse?
    public private(set) var toolsetCatalog: ToolsetsCatalog?
    public private(set) var errorMessage: String?
    public private(set) var isLoading = false

    private var overrides: [String: (id: UUID, apply: (inout SettingsResponse) -> Void)] = [:]
    private var toolsetOverrides: [String: (id: UUID, enabled: Bool)] = [:]
    private var unresolved: [UUID: PartialKeyPath<ServerSettingsStore>] = [:]
    private var toolsetGeneration = 0
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

    public var showsTools: Bool {
        settings?.agentApprovals != nil || toolsetCatalog?.toolsets.contains {
            $0.group == "available" || $0.group == "not_available"
        } == true
    }

    public func isToolsetEnabled(_ item: ToolsetChoice) -> Bool {
        toolsetOverrides[item.name]?.enabled ?? item.selected ?? false
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
        async let toolsets: Void = loadToolsets()
        defer { if generation == current { isLoading = false } }
        do {
            let response = try await client.settings()
            guard generation == current else { return }
            confirmedSettings = response
            clearResolvedOverrides(for: \.confirmedSettings)
        } catch {
            guard generation == current else { return }
            if !APIError.isCancellation(error) { errorMessage = error.localizedDescription }
        }
        await toolsets
    }

    private func loadToolsets() async {
        toolsetGeneration += 1
        let current = toolsetGeneration
        do {
            let catalog = try await client.toolsetDefaults()
            guard toolsetGeneration == current else { return }
            toolsetCatalog = catalog
            clearResolvedOverrides(for: \.toolsetCatalog)
        } catch {
            guard toolsetGeneration == current, !APIError.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    @discardableResult
    public func setToolsetDefault(name: String, enabled: Bool) -> Task<Void, Never> {
        let id = UUID()
        toolsetOverrides[name] = (id, enabled)
        toolsetGeneration += 1
        return enqueueWrite(id, snapshot: \.toolsetCatalog) {
            try await self.client.setToolsetDefault(name: name, enabled: enabled)
        } reconcile: {
            try await self.client.toolsetDefaults()
        }
    }

    @discardableResult
    public func setBotName(_ value: String) -> Task<Void, Never> {
        save("bot_name", \.botName, String(value.prefix(64)))
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
    public func setContinueInterruptedChats(_ value: Bool) -> Task<Void, Never> {
        save("continue_interrupted_chats", \.continueInterruptedChats, value)
    }
    /// TAL-2331, TAL-2341: the server applies this switch to the transcripts it sends, so open chats reread theirs once the
    /// save settles.
    @discardableResult
    public func setToolCallSetting(_ setting: ToolCallSetting, _ value: Bool) -> Task<Void, Never> {
        let write = save(setting.rawValue, \.toolCallSettings[setting], value)
        let server = client.baseURL
        return Task {
            await write.value
            NotificationCenter.default.post(name: .talariaSessionsChanged, object: server,
                                            userInfo: [SessionsChange.userInfoKey: SessionsChange.changed(reason: setting.rawValue, sessionID: nil)])
        }
    }
    /// TAL-2341: off, the server names no call on Live Activities and push alerts.
    @discardableResult
    public func setLiveActivityCurrentTool(_ value: Bool) -> Task<Void, Never> {
        save("live_activity_current_tool", \.liveActivityCurrentTool, value)
    }
    /// TAL-2336: off, the server sends Live Activities and push alerts only each call's kind. Owner only.
    @discardableResult
    public func setActivityCallDetails(_ value: Bool) -> Task<Void, Never> {
        save("activity_call_details", \.activityCallDetails, value)
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
        return enqueueWrite(id, snapshot: \.confirmedSettings) {
            try await self.client.send(endpoint: .settings, method: "POST", body: [key: value])
        } reconcile: {
            try await self.client.settings()
        }
    }

    private func enqueueWrite<Snapshot>(
        _ id: UUID, snapshot: ReferenceWritableKeyPath<ServerSettingsStore, Snapshot>,
        write: @escaping () async throws -> Snapshot,
        reconcile: @escaping () async throws -> Snapshot
    ) -> Task<Void, Never> {
        errorMessage = nil
        pendingWrites += 1
        let previous = writeTask
        let task = Task {
            await previous?.value
            defer { pendingWrites -= 1 }
            do {
                self[keyPath: snapshot] = try await write()
                clearOverride(id)
                clearResolvedOverrides(for: snapshot)
            } catch {
                if APIError.isDefinitiveWriteFailure(error) {
                    clearOverride(id)
                } else {
                    // Never replay an unknown write. A read determines whether the choice was stored.
                    do {
                        self[keyPath: snapshot] = try await reconcile()
                        clearOverride(id)
                        clearResolvedOverrides(for: snapshot)
                    } catch { unresolved[id] = snapshot }
                }
                errorMessage = error.localizedDescription
            }
        }
        writeTask = task
        return task
    }

    private func clearOverride(_ id: UUID) {
        overrides = overrides.filter { $0.value.id != id }
        toolsetOverrides = toolsetOverrides.filter { $0.value.id != id }
        unresolved.removeValue(forKey: id)
    }

    private func clearResolvedOverrides(for snapshot: PartialKeyPath<ServerSettingsStore>) {
        for (id, source) in unresolved where source == snapshot { clearOverride(id) }
    }
}
