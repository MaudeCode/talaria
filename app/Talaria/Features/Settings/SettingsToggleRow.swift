import SwiftUI

struct SettingsToggleRow: View {
    let title: String
    let systemImage: String
    @Binding var isOn: Bool
    var accessibilityIdentifier: String? = nil
    var isMenuItem = false

    @ViewBuilder
    var body: some View {
        if isMenuItem {
            Toggle(title, isOn: $isOn)
        } else {
            Toggle(isOn: $isOn) {
                SettingsRowLabel(title: title, systemImage: systemImage)
            }
            .indexedSettingsRow(title: title, identifier: accessibilityIdentifier)
            .toggleStyle(.switch)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
    }
}
