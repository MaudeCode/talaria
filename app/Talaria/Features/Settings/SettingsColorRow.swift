import SwiftUI

/// Color control using the same label as SettingsToggleRow.
struct SettingsColorRow: View {
    let title: String
    var systemImage = "paintpalette"
    @Binding var selection: Color
    var supportsOpacity = true
    var accessibilityIdentifier: String? = nil

    var body: some View {
        ColorPicker(selection: $selection, supportsOpacity: supportsOpacity) {
            SettingsRowLabel(title: title, systemImage: systemImage)
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .indexedSettingsRow(title: title, identifier: accessibilityIdentifier)
    }
}
