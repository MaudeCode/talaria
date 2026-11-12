import SwiftUI
import TalariaKit

/// Settings pages already share rows; this scope shares their server/profile read and writer.
struct ServerSettingsScope<Content: View>: View {
    @Environment(ServerSettingsStore.self) private var inherited: ServerSettingsStore?
    @State private var local: ServerSettingsStore
    private let content: (ServerSettingsStore) -> Content

    init(server: URL, @ViewBuilder content: @escaping (ServerSettingsStore) -> Content) {
        _local = State(initialValue: ServerSettingsStore(client: APIClient(baseURL: server)))
        self.content = content
    }

    var body: some View {
        let store = inherited ?? local
        content(store).environment(store)
            .task { await store.loadIfNeeded() }
    }
}

/// Extends SettingsSection and its shared control rows for the server-owned preferences.
struct ServerSettingsSections: View {
    enum Page { case tools, limits, titles, updates }
    let page: Page
    @Environment(ServerSettingsStore.self) private var store: ServerSettingsStore?
    @Environment(\.settingsScrollAnchor) private var scrollAnchor

    var body: some View {
        if let store, let settings = store.settings {
            switch page {
            case .tools:
                if let value = settings.agentApprovals {
                    SettingsSection(title: String(localized: "Approvals")) {
                        toggle(SettingsIndex.toolsAgentApprovals.titleResource, "checkmark.shield", \.agentApprovals, value,
                               "settings-tools-agent-approvals", store.setAgentApprovals)
                    }
                }
            case .limits:
                if settings.hasMaxTokens || settings.compressionPrepareAhead != nil {
                    SettingsSection(title: String(localized: "Limits")) {
                        if settings.hasMaxTokens {
                            SettingsTextFieldRow(
                                title: SettingsIndex.modelsMaxTokens.title,
                                text: Binding(get: { store.settings?.maxTokens.map(String.init) ?? "" },
                                              set: { store.setMaxTokensText($0) }),
                                placeholder: String(localized: "No limit"), keyboardType: .numberPad
                            )
                            .accessibilityIdentifier("settings-chat-max-tokens")
                        }
                        if let value = settings.compressionPrepareAhead {
                            toggle(SettingsIndex.modelsPrepareCompressionAhead.titleResource, "archivebox", \.compressionPrepareAhead, value,
                                   "settings-chat-compression-ahead", store.setCompressionPrepareAhead)
                        }
                    }
                }
            case .titles:
                if let value = settings.autoTitleRefreshEvery {
                    SettingsPickerRow(
                        title: SettingsIndex.systemRefreshTitlesEvery.title, systemImage: "textformat",
                        selection: binding(\.autoTitleRefreshEvery, value, store.setAutoTitleRefreshEvery),
                        accessibilityIdentifier: "settings-chat-title-refresh"
                    ) {
                        Text("Off").tag("0")
                        Text("5").tag("5")
                        Text("10").tag("10")
                        Text("20").tag("20")
                    }
                }
            case .updates:
                if settings.checkForUpdates != nil || settings.autoApplyUpdates != nil || settings.summarizeUpdatesAutomatically != nil
                    || settings.updateChannel != nil || settings.agentUpdateChannel != nil || settings.ignoreAgentUpdates != nil {
                    SettingsSection(title: String(localized: "Updates")) {
                        if let value = settings.checkForUpdates {
                            toggle(SettingsIndex.systemCheckForUpdates.titleResource, "arrow.triangle.2.circlepath", \.checkForUpdates, value,
                                   "settings-system-check-updates", store.setCheckForUpdates)
                        }
                        if let value = settings.autoApplyUpdates {
                            toggle(SettingsIndex.systemApplyWebUpdatesAutomatically.titleResource, "arrow.down.circle", \.autoApplyUpdates, value,
                                   "settings-system-auto-apply", store.setAutoApplyUpdates)
                        }
                        if let value = settings.summarizeUpdatesAutomatically {
                            toggle(SettingsIndex.systemSummarizeUpdates.titleResource, "text.alignleft", \.summarizeUpdatesAutomatically, value,
                                   "settings-system-summarize", store.setSummarizeUpdatesAutomatically)
                        }
                        if let value = settings.updateChannel, let channels = settings.updateChannels {
                            SettingsPickerRow(
                                title: SettingsIndex.systemWebChannel.title, systemImage: "network",
                                selection: binding(\.updateChannel, value, store.setUpdateChannel),
                                accessibilityIdentifier: "settings-system-web-channel"
                            ) {
                                ForEach(channels, id: \.self) { channel in
                                    Text(channelTitle(channel)).tag(channel)
                                }
                            }
                        }
                        if let value = settings.agentUpdateChannel {
                            SettingsPickerRow(
                                title: SettingsIndex.systemAgentChannel.title, systemImage: "cpu",
                                selection: binding(\.agentUpdateChannel, value, store.setAgentUpdateChannel),
                                accessibilityIdentifier: "settings-system-agent-channel"
                            ) {
                                Text("Stable").tag("stable")
                                Text("Experimental").tag("experimental")
                            }
                        }
                        if let value = settings.ignoreAgentUpdates {
                            toggle(SettingsIndex.systemIgnoreAgentUpdates.titleResource, "bell.slash", \.ignoreAgentUpdates, value,
                                   "settings-system-ignore-agent", store.setIgnoreAgentUpdates)
                        }
                    }
                }
            }
        }
        if let entry = requestedUnavailableSetting {
            let row = SettingsInfoRow(title: entry.title, value: String(localized: "Not Available on This Server"))
            if case .titles = page { row }
            else { SettingsSection(title: entry.section) { row } }
        }
    }

    private var requestedUnavailableSetting: SettingsIndex? {
        guard let entry = scrollAnchor?.entry else { return nil }
        let settings = store?.settings
        let available: Bool
        switch (page, entry) {
        case (.tools, .toolsAgentApprovals): available = settings?.agentApprovals != nil
        case (.limits, .modelsMaxTokens): available = settings?.hasMaxTokens == true
        case (.limits, .modelsPrepareCompressionAhead): available = settings?.compressionPrepareAhead != nil
        case (.titles, .systemRefreshTitlesEvery): available = settings?.autoTitleRefreshEvery != nil
        case (.updates, .systemCheckForUpdates): available = settings?.checkForUpdates != nil
        case (.updates, .systemApplyWebUpdatesAutomatically): available = settings?.autoApplyUpdates != nil
        case (.updates, .systemSummarizeUpdates): available = settings?.summarizeUpdatesAutomatically != nil
        case (.updates, .systemWebChannel): available = settings?.updateChannel != nil && settings?.updateChannels != nil
        case (.updates, .systemAgentChannel): available = settings?.agentUpdateChannel != nil
        case (.updates, .systemIgnoreAgentUpdates): available = settings?.ignoreAgentUpdates != nil
        default: return nil
        }
        return available ? nil : entry
    }

    private func toggle(_ title: LocalizedStringResource, _ icon: String, _ path: KeyPath<SettingsResponse, Bool?>,
                        _ value: Bool, _ id: String,
                        _ save: @escaping (Bool) -> Task<Void, Never>) -> some View {
        SettingsToggleRow(title: String(localized: title), systemImage: icon, isOn: binding(path, value, save),
                          accessibilityIdentifier: id)
    }

    private func binding<Value>(_ path: KeyPath<SettingsResponse, Value?>, _ fallback: Value,
                                _ save: @escaping (Value) -> Task<Void, Never>) -> Binding<Value> {
        Binding(get: { store?.settings?[keyPath: path] ?? fallback }, set: { _ = save($0) })
    }

    private func channelTitle(_ channel: String) -> String {
        switch channel {
        case "stable": String(localized: "Stable")
        case "nightly": String(localized: "Nightly")
        case "experimental": String(localized: "Experimental")
        default: channel
        }
    }
}
