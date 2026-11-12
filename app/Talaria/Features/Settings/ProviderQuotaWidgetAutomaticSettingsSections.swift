import SwiftUI
import TalariaKit

struct ProviderQuotaWidgetAutomaticSettingsSections: View {
    @Environment(\.settingsScrollAnchor) private var scrollAnchor
    @Binding var healthyColor: String
    @Binding var warningColor: String
    @Binding var criticalColor: String
    @Binding var staleColor: String
    @Binding var unavailableColor: String
    @Binding var customHealthyColorHex: String
    @Binding var customWarningColorHex: String
    @Binding var customCriticalColorHex: String
    @Binding var customStaleColorHex: String
    @Binding var customUnavailableColorHex: String
    var body: some View {
        Group {
            SettingsSection(title: String(localized: "Automatic Colors")) {
                colorPicker(.widgetHealthy, custom: .widgetCustomHealthyColor, selection: $healthyColor, customHex: $customHealthyColorHex)
                colorPicker(.widgetWarning, custom: .widgetCustomWarningColor, selection: $warningColor, customHex: $customWarningColorHex)
                colorPicker(.widgetCritical, custom: .widgetCustomCriticalColor, selection: $criticalColor, customHex: $customCriticalColorHex)
                colorPicker(.widgetStale, custom: .widgetCustomStaleColor, selection: $staleColor, customHex: $customStaleColorHex)
                colorPicker(.widgetUnavailable, custom: .widgetCustomUnavailableColor, selection: $unavailableColor, customHex: $customUnavailableColorHex)
            }
        }
        .onChange(of: reloadFingerprint) { reloadWidgets() }
    }

    private var reloadFingerprint: String {
        [
            healthyColor,
            warningColor,
            criticalColor,
            staleColor,
            unavailableColor,
            customHealthyColorHex,
            customWarningColorHex,
            customCriticalColorHex,
            customStaleColorHex,
            customUnavailableColorHex
        ].joined(separator: "|")
    }

    @ViewBuilder
    private func colorPicker(
        _ entry: SettingsIndex,
        custom: SettingsIndex,
        selection: Binding<String>,
        customHex: Binding<String>
    ) -> some View {
        SettingsPickerRow(title: entry.title, systemImage: "paintpalette", selection: selection) {
            ForEach(ProviderQuotaWidgetArcColor.allCases.filter { $0 != .automatic }) { color in
                Text(color.title).tag(color.rawValue)
            }
        }
        if selection.wrappedValue == ProviderQuotaWidgetArcColor.custom.rawValue || scrollAnchor == .setting(custom) {
            SettingsColorRow(title: custom.title, selection: HeaderLogoColor.binding(customHex))
        }
    }

    private func reloadWidgets() {
        ProviderQuotaWidgetSnapshotStore.reloadTimelines()
    }
}

/// Profile thresholds formerly embedded in widget customization; the shared server writer remains their owner.
struct ProviderQuotaThresholdSettingsSections: View {
    @Environment(ServerSettingsStore.self) private var settingsStore: ServerSettingsStore?
    @State private var standaloneStore: ServerSettingsStore?
    /// The server's thresholds for the active profile (TAL-411), or the last read while offline.
    @State private var cachedThresholds: ProviderQuotaThresholds?
    @State private var thresholdsAreCached = false
    @State private var thresholdsLoaded = false
    private var store: ServerSettingsStore? { settingsStore ?? standaloneStore }
    private var thresholds: ProviderQuotaThresholds? {
        thresholdsAreCached ? cachedThresholds : store?.settings?.providerQuotaThresholds
    }

    var body: some View {
        Group {
            if thresholds != nil {
                SettingsSection(
                    title: String(localized: "Pace Breakpoints"),
                    help: String(localized: """
                    Pace compares quota remaining with the share of the weekly reset window remaining. Burn-rate alerts \
                    apply only when current usage projects exhaustion before reset.
                    """)
                ) {
                    Group {
                        SettingsStepperRow(
                            title: SettingsIndex.providersOverPaceAt.title,
                            value: threshold(\.paceTolerancePercent),
                            in: 0...25,
                            format: { String(localized: "\($0)%") }
                        )
                        SettingsStepperRow(
                            title: SettingsIndex.providersWarningBurnRate.title,
                            value: threshold(\.paceWarningBurnRatePercent),
                            in: 100...300,
                            step: 5,
                            format: { String(localized: "\($0)%") }
                        )
                        SettingsStepperRow(
                            title: SettingsIndex.providersCriticalBurnRate.title,
                            value: threshold(\.paceCriticalBurnRatePercent),
                            in: 100...400,
                            step: 5,
                            format: { String(localized: "\($0)%") }
                        )
                        SettingsStepperRow(
                            title: SettingsIndex.providersProjectionAfter.title,
                            value: threshold(\.paceMinimumElapsedHours),
                            in: 0...72,
                            format: { String(localized: "\($0) hr") }
                        )
                    }
                    .disabled(thresholdsAreCached)
                    thresholdStatus
                    if let error = store?.errorMessage { SettingsErrorFootnote(SettingsErrorText(error)) }
                }
                SettingsSection(
                    title: String(localized: "Overall Breakpoints"),
                    help: String(localized: """
                    Overall Percentage ignores reset time and colors the widget from the quota remaining.
                    """)
                ) {
                    Group {
                        SettingsStepperRow(
                            title: SettingsIndex.providersWarningAt.title,
                            value: threshold(\.warningRemainingPercent),
                            in: 1...99,
                            format: { String(localized: "\($0)% remaining") }
                        )
                        SettingsStepperRow(
                            title: SettingsIndex.providersCriticalAt.title,
                            value: threshold(\.criticalRemainingPercent),
                            in: 0...99,
                            format: { String(localized: "\($0)% remaining") }
                        )
                    }
                    .disabled(thresholdsAreCached)
                    thresholdStatus
                    if let error = store?.errorMessage { SettingsErrorFootnote(SettingsErrorText(error)) }
                }
            } else if thresholdsLoaded {
                SettingsSection(title: String(localized: "Breakpoints")) {
                    Text("Connect to a server that provides quota thresholds to change when quotas turn warning or critical.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else {
                ProgressView(String(localized: "Loading"))
                    .listRowSeparator(.hidden)
            }
        }
        .task { await loadThresholds() }
    }

    @ViewBuilder
    private var thresholdStatus: some View {
        if thresholdsAreCached {
            Text("Offline: showing the breakpoints last read from the server.")
        }
    }

    private var client: APIClient? {
        ServerRegistry.shared.activeServer.flatMap { URL(string: $0.urlString) }.map { APIClient(baseURL: $0) }
    }

    private func loadThresholds() async {
        let defaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
        if store == nil, let client { standaloneStore = ServerSettingsStore(client: client) }
        guard let store else {
            cachedThresholds = ProviderQuotaThresholds.cached(defaults: defaults)
            thresholdsAreCached = cachedThresholds != nil
            thresholdsLoaded = true
            return
        }
        await store.loadIfNeeded()
        if let settings = store.settings {
            settings.providerQuotaThresholds?.cache(defaults: defaults)
            thresholdsAreCached = false
        } else {
            cachedThresholds = ProviderQuotaThresholds.cached(defaults: defaults)
            thresholdsAreCached = cachedThresholds != nil
        }
        thresholdsLoaded = true
    }

    private func threshold(_ keyPath: WritableKeyPath<ProviderQuotaThresholds, Int>) -> Binding<Int> {
        Binding(
            get: { thresholds?[keyPath: keyPath] ?? 0 },
            set: { value in
                guard var next = thresholds, !thresholdsAreCached, let store else { return }
                next[keyPath: keyPath] = value
                let write = store.setQuotaThresholds(next)
                Task {
                    await write.value
                    store.confirmedSettings?.providerQuotaThresholds?.cache(defaults: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
                    _ = await ProviderQuotaWidgetRefreshClient.refreshFromSharedCredentials()
                }
            }
        )
    }
}
