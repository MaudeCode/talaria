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
            Section("Content") {
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
                Text("Sidebar rows remain the same height. These controls only choose which compact presentation fields are shown.")
            }
        }
        .navigationTitle("Sidebar Display")
        .navigationBarTitleDisplayMode(.inline)
    }
}
