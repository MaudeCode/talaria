import SwiftUI
import TalariaKit

/// SettingsValueRow's status sibling; SettingsStatusPill owns its tint treatment.
struct SettingsStatusRow: View {
    let title: String
    let systemImage: String
    let status: String
    var tone: Color = .secondary
    var detail: String? = nil
    var isLoading = false
    var accessibilityIdentifier: String? = nil

    var body: some View {
        SettingsValueRow(title: title, systemImage: systemImage) {
            HStack(spacing: 8) {
                SettingsStatusPill(label: status, tint: tone, lineLimit: nil)
                if isLoading { ProgressView().accessibilityHidden(true) }
            }
        } supplementary: {
            if let detail {
                Text(detail)
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .environment(\.settingsIndexPage, nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(detail.map { "\(status)\n\($0)" } ?? status)
        .indexedSettingsRow(title: title, identifier: accessibilityIdentifier)
    }
}
