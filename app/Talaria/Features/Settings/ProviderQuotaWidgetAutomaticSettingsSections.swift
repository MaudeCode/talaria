import SwiftUI
import TalariaKit

struct ProviderQuotaWidgetAutomaticSettingsSections: View {
    @Environment(ServerSettingsStore.self) private var settingsStore: ServerSettingsStore?
    @State private var standaloneStore: ServerSettingsStore?
    @AppStorage(ProviderQuotaWidgetColorBasis.storageKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var colorBasisRawValue = ProviderQuotaWidgetColorBasis.defaultValue.rawValue
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
            SettingsSection(title: String(localized: "Automatic Colors")) {
                colorPicker("Healthy", selection: $healthyColor, customHex: $customHealthyColorHex)
                colorPicker("Warning", selection: $warningColor, customHex: $customWarningColorHex)
                colorPicker("Critical", selection: $criticalColor, customHex: $customCriticalColorHex)
                colorPicker("Stale", selection: $staleColor, customHex: $customStaleColorHex)
                colorPicker("Unavailable", selection: $unavailableColor, customHex: $customUnavailableColorHex)
            }

            if thresholds != nil {
                if colorBasis == .pace {
                    SettingsSection(
                        title: String(localized: "Pace Breakpoints"),
                        help: String(localized: """
                        Pace compares quota remaining with the share of the weekly reset window remaining. Burn-rate alerts \
                        apply only when current usage projects exhaustion before reset.
                        """)
                    ) {
                        Group {
                            SettingsStepperRow(
                                title: String(localized: "Over pace at"),
                                value: threshold(\.paceTolerancePercent),
                                in: 0...25,
                                format: { String(localized: "\($0)%") }
                            )
                            SettingsStepperRow(
                                title: String(localized: "Warning burn rate"),
                                value: threshold(\.paceWarningBurnRatePercent),
                                in: 100...300,
                                step: 5,
                                format: { String(localized: "\($0)%") }
                            )
                            SettingsStepperRow(
                                title: String(localized: "Critical burn rate"),
                                value: threshold(\.paceCriticalBurnRatePercent),
                                in: 100...400,
                                step: 5,
                                format: { String(localized: "\($0)%") }
                            )
                            SettingsStepperRow(
                                title: String(localized: "Projection after"),
                                value: threshold(\.paceMinimumElapsedHours),
                                in: 0...72,
                                format: { String(localized: "\($0) hr") }
                            )
                        }
                        .disabled(thresholdsAreCached)
                        thresholdStatus
                        if let error = store?.errorMessage { SettingsErrorFootnote(SettingsErrorText(error)) }
                    }
                } else {
                    SettingsSection(
                        title: String(localized: "Overall Breakpoints"),
                        help: String(localized: """
                        Overall Percentage ignores reset time and colors the widget from the quota remaining.
                        """)
                    ) {
                        Group {
                            SettingsStepperRow(
                                title: String(localized: "Warning at"),
                                value: threshold(\.warningRemainingPercent),
                                in: 1...99,
                                format: { String(localized: "\($0)% remaining") }
                            )
                            SettingsStepperRow(
                                title: String(localized: "Critical at"),
                                value: threshold(\.criticalRemainingPercent),
                                in: 0...99,
                                format: { String(localized: "\($0)% remaining") }
                            )
                        }
                        .disabled(thresholdsAreCached)
                        thresholdStatus
                        if let error = store?.errorMessage { SettingsErrorFootnote(SettingsErrorText(error)) }
                    }
                }
            } else if thresholdsLoaded {
                SettingsSection(title: String(localized: "Breakpoints")) {
                    Text("Connect to a server that provides quota thresholds to change when quotas turn warning or critical.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .task { await loadThresholds() }
        .onChange(of: reloadFingerprint) {
            reloadWidgets()
        }
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
        _ title: String,
        selection: Binding<String>,
        customHex: Binding<String>
    ) -> some View {
        SettingsPickerRow(title: title, systemImage: "paintpalette", selection: selection) {
            ForEach(ProviderQuotaWidgetArcColor.allCases.filter { $0 != .automatic }) { color in
                Text(color.title).tag(color.rawValue)
            }
        }
        if selection.wrappedValue == ProviderQuotaWidgetArcColor.custom.rawValue {
            SettingsColorRow(title: String(localized: "Custom \(title) Color"), selection: HeaderLogoColor.binding(customHex))
        }
    }

    private var colorBasis: ProviderQuotaWidgetColorBasis {
        ProviderQuotaWidgetColorBasis(rawValue: colorBasisRawValue) ?? .defaultValue
    }

    private func reloadWidgets() {
        ProviderQuotaWidgetSnapshotStore.reloadTimelines()
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
