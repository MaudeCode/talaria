import SwiftUI
import TalariaKit

struct ProviderQuotaSidebarDisplayView: View {
    @AppStorage(ProviderQuotaSidebarSettings.detailKey)
    private var detailRawValue = ProviderQuotaSidebarDetail.defaultValue.rawValue
    @AppStorage(ProviderQuotaSidebarSettings.showsRailKey) private var showsRail = true
    @AppStorage(ProviderQuotaSidebarSettings.showsMarkerKey) private var showsMarker = true
    @AppStorage(ProviderQuotaSidebarSettings.showsIconKey) private var showsIcon = true
    @AppStorage(ProviderQuotaSidebarSettings.colorsByStateKey) private var colorsByState = true

    @Environment(\.settingsScrollAnchor) private var scrollAnchor

    var body: some View {
        SettingsPage(title: String(localized: "Sidebar Quotas"), indexPage: .sidebarQuotas) {
            SettingsSection(title: String(localized: "Quotas Group")) {
                SettingsPickerRow(title: SettingsIndex.sidebarQuotasDetail.title, systemImage: "list.bullet", selection: $detailRawValue) {
                    ForEach(ProviderQuotaSidebarDetail.allCases) { detail in
                        Text(detail.title).tag(detail.rawValue)
                    }
                }

                SettingsToggleRow(title: SettingsIndex.sidebarQuotasProviderIcon.title, systemImage: "app", isOn: $showsIcon)
                SettingsToggleRow(title: SettingsIndex.sidebarQuotasQuotaRail.title, systemImage: "gauge", isOn: $showsRail)
                if showsRail || scrollAnchor == .setting(.sidebarQuotasPaceMarker) {
                    SettingsToggleRow(title: SettingsIndex.sidebarQuotasPaceMarker.title, systemImage: "gauge", isOn: $showsMarker)
                        .disabled(!showsRail)
                }
            }

            SettingsToggleRow(title: SettingsIndex.sidebarQuotasColorByState.title, systemImage: "paintpalette", isOn: $colorsByState)
                .sidebarRowPadding()
                .sidebarRow(isSelected: false)
        }
        .navigationTitle("Sidebar Quotas")
        .adaptiveSecondaryNavigationTitle(title: String(localized: "Sidebar Quotas"))
        .navigationBarTitleDisplayMode(.inline)
    }
}
