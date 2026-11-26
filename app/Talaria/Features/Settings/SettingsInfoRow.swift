import SwiftUI

struct SettingsInfoRow: View {
    let title: String
    let value: String
    var valueIsSelectable = false
    var wrapsValue = false

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        SettingsValueRow(title: title) {
            if valueIsSelectable {
                valueText
                    .textSelection(.enabled)
            } else {
                valueText
            }
        }
    }

    private var valueText: some View {
        Text(value)
            .foregroundStyle(.secondary)
            .lineLimit(wrapsValue ? nil : (dynamicTypeSize.isAccessibilitySize ? 4 : 2))
            .fixedSize(horizontal: false, vertical: wrapsValue)
            .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
    }
}
