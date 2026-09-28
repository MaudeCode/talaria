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
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.warningRemainingPercentKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var warningRemainingPercent = ProviderQuotaWidgetAppearanceSettings.defaultWarningRemainingPercent
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.criticalRemainingPercentKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var criticalRemainingPercent = ProviderQuotaWidgetAppearanceSettings.defaultCriticalRemainingPercent
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.paceTolerancePercentKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var paceTolerancePercent = ProviderQuotaWidgetAppearanceSettings.defaultPaceTolerancePercent
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.paceWarningBurnRatePercentKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var paceWarningBurnRatePercent = ProviderQuotaWidgetAppearanceSettings.defaultPaceWarningBurnRatePercent
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.paceCriticalBurnRatePercentKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var paceCriticalBurnRatePercent = ProviderQuotaWidgetAppearanceSettings.defaultPaceCriticalBurnRatePercent
    @AppStorage(ProviderQuotaWidgetAppearanceSettings.paceMinimumElapsedHoursKey, store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults)
    private var paceMinimumElapsedHours = ProviderQuotaWidgetAppearanceSettings.defaultPaceMinimumElapsedHours

    var body: some View {
        Group {
            Section("Automatic Colors") {
                colorPicker("Healthy", selection: $healthyColor, customHex: $customHealthyColorHex)
                colorPicker("Warning", selection: $warningColor, customHex: $customWarningColorHex)
                colorPicker("Critical", selection: $criticalColor, customHex: $customCriticalColorHex)
                colorPicker("Stale", selection: $staleColor, customHex: $customStaleColorHex)
                colorPicker("Unavailable", selection: $unavailableColor, customHex: $customUnavailableColorHex)
            }

            if colorBasis == .pace {
                Section {
                    Stepper(
                        "Over pace at \(paceTolerancePercent)%",
                        value: $paceTolerancePercent,
                        in: 0...25
                    )
                    Stepper(
                        "Warning burn rate: \(paceWarningBurnRatePercent)%",
                        value: $paceWarningBurnRatePercent,
                        in: 100...300,
                        step: 5
                    )
                    Stepper(
                        "Critical burn rate: \(paceCriticalBurnRatePercent)%",
                        value: $paceCriticalBurnRatePercent,
                        in: 100...400,
                        step: 5
                    )
                    Stepper(
                        "Projection after \(paceMinimumElapsedHours) hr",
                        value: $paceMinimumElapsedHours,
                        in: 0...72
                    )
                } header: {
                    Text("Pace Breakpoints")
                } footer: {
                    Text("Pace compares quota remaining with the share of the weekly reset window remaining. Burn-rate alerts apply only when current usage projects exhaustion before reset.")
                }
            } else {
                Section {
                    Stepper(
                        "Warning at \(warningRemainingPercent)% remaining",
                        value: $warningRemainingPercent,
                        in: 1...99
                    )
                    Stepper(
                        "Critical at \(criticalRemainingPercent)% remaining",
                        value: $criticalRemainingPercent,
                        in: 0...99
                    )
                } header: {
                    Text("Overall Breakpoints")
                } footer: {
                    Text("Overall Percentage ignores reset time and colors the widget from the quota remaining.")
                }
            }
        }
        .onChange(of: reloadFingerprint) {
            if criticalRemainingPercent > warningRemainingPercent {
                criticalRemainingPercent = warningRemainingPercent
            }
            if paceCriticalBurnRatePercent < paceWarningBurnRatePercent {
                paceCriticalBurnRatePercent = paceWarningBurnRatePercent
            }
            reloadWidgets()
        }
    }

    private var reloadFingerprint: String {
        [
            String(warningRemainingPercent),
            String(criticalRemainingPercent),
            String(paceTolerancePercent),
            String(paceWarningBurnRatePercent),
            String(paceCriticalBurnRatePercent),
            String(paceMinimumElapsedHours),
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
}
