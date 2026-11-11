import SwiftUI

struct SettingsToggleRow: View {
    let title: String
    let systemImage: String
    @Binding var isOn: Bool
    var accessibilityIdentifier: String? = nil

    var body: some View {
        Toggle(isOn: $isOn) {
            SettingsRowLabel(title: title, systemImage: systemImage)
        }
        .accessibilityIdentifier(accessibilityIdentifier ?? "")
        .toggleStyle(.switch)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }
}
