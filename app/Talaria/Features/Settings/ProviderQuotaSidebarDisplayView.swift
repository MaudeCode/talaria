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
        Form {
            Section("Quotas Group") {
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

            Section {
                Toggle("Color by State", isOn: $colorsByState)
            } footer: {
                Text("Pinned accounts appear in the Quotas group below the sidebar destinations. Rows stay the same height; these controls choose their detail, rail and icon.")
            }
        }
        .navigationTitle("Sidebar Quotas")
        .adaptiveSecondaryNavigationTitle(title: String(localized: "Sidebar Quotas"))
        .navigationBarTitleDisplayMode(.inline)
    }
}
