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
        SidebarList {
            SettingsSection(title: String(localized: "Quotas Group")) {
                Picker("Detail", selection: $detailRawValue) {
                    ForEach(ProviderQuotaSidebarDetail.allCases) { detail in
                        Text(detail.title).tag(detail.rawValue)
                    }
                }

                Toggle("Provider Icon", isOn: $showsIcon)
                Toggle("Quota Rail", isOn: $showsRail)
                if showsRail {
                    Toggle("Pace Marker", isOn: $showsMarker)
                }
            }

            Toggle("Color by State", isOn: $colorsByState)
                .sidebarRowPadding()
                .sidebarRow(isSelected: false)
        }
        .navigationTitle("Sidebar Quotas")
        .adaptiveSecondaryNavigationTitle(title: String(localized: "Sidebar Quotas"))
        .navigationBarTitleDisplayMode(.inline)
    }
}
