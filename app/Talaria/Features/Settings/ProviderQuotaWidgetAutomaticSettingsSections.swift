import SwiftUI
import TalariaKit

struct ProviderQuotaWidgetAutomaticSettingsSections: View {
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
    @State private var thresholds: ProviderQuotaThresholds?
    @State private var thresholdsAreCached = false
    @State private var thresholdsLoaded = false
    @State private var thresholdSave: Task<Void, Never>?

    var body: some View {
        Group {
            Section("Automatic Colors") {
                colorPicker("Healthy", selection: $healthyColor, customHex: $customHealthyColorHex)
                colorPicker("Warning", selection: $warningColor, customHex: $customWarningColorHex)
                colorPicker("Critical", selection: $criticalColor, customHex: $customCriticalColorHex)
                colorPicker("Stale", selection: $staleColor, customHex: $customStaleColorHex)
                colorPicker("Unavailable", selection: $unavailableColor, customHex: $customUnavailableColorHex)
            }

            if let thresholds {
                if colorBasis == .pace {
                    Section {
                        Stepper(
                            "Over pace at \(thresholds.paceTolerancePercent)%",
                            value: threshold(\.paceTolerancePercent),
                            in: 0...25
                        )
                        Stepper(
                            "Warning burn rate: \(thresholds.paceWarningBurnRatePercent)%",
                            value: threshold(\.paceWarningBurnRatePercent),
                            in: 100...300,
                            step: 5
                        )
                        Stepper(
                            "Critical burn rate: \(thresholds.paceCriticalBurnRatePercent)%",
                            value: threshold(\.paceCriticalBurnRatePercent),
                            in: 100...400,
                            step: 5
                        )
                        Stepper(
                            "Projection after \(thresholds.paceMinimumElapsedHours) hr",
                            value: threshold(\.paceMinimumElapsedHours),
                            in: 0...72
                        )
                    } header: {
                        Text("Pace Breakpoints")
                    } footer: {
                        thresholdFooter("Pace compares quota remaining with the share of the weekly reset window remaining. Burn-rate alerts apply only when current usage projects exhaustion before reset.")
                    }
                    .disabled(thresholdsAreCached)
                } else {
                    Section {
                        Stepper(
                            "Warning at \(thresholds.warningRemainingPercent)% remaining",
                            value: threshold(\.warningRemainingPercent),
                            in: 1...99
                        )
                        Stepper(
                            "Critical at \(thresholds.criticalRemainingPercent)% remaining",
                            value: threshold(\.criticalRemainingPercent),
                            in: 0...99
                        )
                    } header: {
                        Text("Overall Breakpoints")
                    } footer: {
                        thresholdFooter("Overall Percentage ignores reset time and colors the widget from the quota remaining.")
                    }
                    .disabled(thresholdsAreCached)
                }
            } else if thresholdsLoaded {
                Section {
                    Text("Connect to a server that provides quota thresholds to change when quotas turn warning or critical.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Breakpoints")
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
        Picker(title, selection: selection) {
            ForEach(ProviderQuotaWidgetArcColor.allCases.filter { $0 != .automatic }) { color in
                Text(color.title).tag(color.rawValue)
            }
        }
        if selection.wrappedValue == ProviderQuotaWidgetArcColor.custom.rawValue {
            ColorPicker("Custom \(title) Color", selection: HeaderLogoColor.binding(customHex))
        }
    }

    private var colorBasis: ProviderQuotaWidgetColorBasis {
        ProviderQuotaWidgetColorBasis(rawValue: colorBasisRawValue) ?? .defaultValue
    }

    private func reloadWidgets() {
        ProviderQuotaWidgetSnapshotStore.reloadTimelines()
    }

    @ViewBuilder
    private func thresholdFooter(_ text: LocalizedStringKey) -> some View {
        if thresholdsAreCached {
            Text("Offline: showing the breakpoints last read from the server.")
        } else {
            Text(text)
        }
    }

    private var client: APIClient? {
        ServerRegistry.shared.activeServer.flatMap { URL(string: $0.urlString) }.map { APIClient(baseURL: $0) }
    }

    private func loadThresholds() async {
        let defaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
        do {
            guard let client else { throw URLError(.notConnectedToInternet) }
            // nil from a server that predates TAL-411: nothing to edit.
            let fresh = try await client.settings().providerQuotaThresholds
            fresh?.cache(defaults: defaults)
            thresholds = fresh
            thresholdsAreCached = false
        } catch {
            thresholds = ProviderQuotaThresholds.cached(defaults: defaults)
            thresholdsAreCached = thresholds != nil
        }
        thresholdsLoaded = true
    }

    /// Steps apply at once and save after a short pause; the server's clamped answer replaces them, then quotas refresh.
    private func threshold(_ keyPath: WritableKeyPath<ProviderQuotaThresholds, Int>) -> Binding<Int> {
        Binding(
            get: { thresholds?[keyPath: keyPath] ?? 0 },
            set: { value in
                guard var next = thresholds, !thresholdsAreCached else { return }
                next[keyPath: keyPath] = value
                thresholds = next
                thresholdSave?.cancel()
                thresholdSave = Task { await save(next) }
            }
        )
    }

    private func save(_ next: ProviderQuotaThresholds) async {
        do {
            try await Task.sleep(for: .milliseconds(600))
            guard let client else { return }
            let saved = try await client.saveProviderQuotaThresholds(next).providerQuotaThresholds ?? next
            guard !Task.isCancelled else { return }
            saved.cache(defaults: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
            thresholds = saved
            _ = await ProviderQuotaWidgetRefreshClient.refreshFromSharedCredentials()
        } catch is CancellationError {
            // A newer step replaced this save.
        } catch {
            await loadThresholds()
        }
    }
}
