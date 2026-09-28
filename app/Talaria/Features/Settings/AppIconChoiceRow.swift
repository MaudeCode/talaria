import SwiftUI
import UIKit
import TalariaKit

struct AppIconChoiceRow: View {
    let icon: AppIconChoice
    let isSelected: Bool
    let isUpdating: Bool

    var body: some View {
        HStack(spacing: 12) {
            AppIconChoicePreview(icon: icon)

            VStack(alignment: .leading, spacing: 2) {
                Text(icon.title)
                    .font(AppFont.body(weight: .semibold))
                    .foregroundStyle(.primary)

                Text(icon.subtitle)
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            if isUpdating {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Updating app icon")
            } else if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.green)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 58)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(isSelected ? "Selected" : "")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var accessibilityLabel: String {
        "\(icon.title). \(icon.subtitle)"
    }
}
