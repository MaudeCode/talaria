import SwiftUI

/// SettingsValueRow's status sibling; SettingsStatusPill owns its tint treatment.
struct SettingsStatusRow: View {
    let title: String
    let systemImage: String
    let status: String
    var tone: Color = .secondary
    var isLoading = false
    var accessibilityIdentifier: String? = nil

    var body: some View {
        SettingsValueRow(title: title, systemImage: systemImage) {
            HStack(spacing: 8) {
                SettingsStatusPill(label: status, tint: tone, lineLimit: nil)
                if isLoading { ProgressView().accessibilityHidden(true) }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(status)
        .accessibilityIdentifier(accessibilityIdentifier ?? "")
    }
}
