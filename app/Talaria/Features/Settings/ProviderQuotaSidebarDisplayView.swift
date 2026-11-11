import SwiftUI
import TalariaKit

struct ProviderQuotaSidebarDisplayView: View {
    @AppStorage(ProviderQuotaSidebarSettings.detailKey)
    private var detailRawValue = ProviderQuotaSidebarDetail.defaultValue.rawValue
    @AppStorage(ProviderQuotaSidebarSettings.showsRailKey) private var showsRail = true
    @AppStorage(ProviderQuotaSidebarSettings.showsMarkerKey) private var showsMarker = true
    @AppStorage(ProviderQuotaSidebarSettings.showsIconKey) private var showsIcon = true
    @AppStorage(ProviderQuotaSidebarSettings.colorsByStateKey) private var colorsByState = true

    var body: some View {
        SettingsPage(title: String(localized: "Sidebar Quotas")) {
            SettingsSection(title: String(localized: "Quotas Group")) {
                SettingsPickerRow(title: String(localized: "Detail"), systemImage: "list.bullet", selection: $detailRawValue) {
                    ForEach(ProviderQuotaSidebarDetail.allCases) { detail in
                        Text(detail.title).tag(detail.rawValue)
                    }
                }

                SettingsToggleRow(title: String(localized: "Provider Icon"), systemImage: "app", isOn: $showsIcon)
                SettingsToggleRow(title: String(localized: "Quota Rail"), systemImage: "gauge", isOn: $showsRail)
                if showsRail {
                    SettingsToggleRow(title: String(localized: "Pace Marker"), systemImage: "gauge", isOn: $showsMarker)
                }
            }

            SettingsToggleRow(title: String(localized: "Color by State"), systemImage: "paintpalette", isOn: $colorsByState)
                .sidebarRowPadding()
                .sidebarRow(isSelected: false)
        }
        .navigationTitle("Sidebar Quotas")
        .adaptiveSecondaryNavigationTitle(title: String(localized: "Sidebar Quotas"))
        .navigationBarTitleDisplayMode(.inline)
    }
}
