import SwiftUI
import UIKit
import TalariaKit

struct AppIconChoiceRow: View {
    let icon: AppIconChoice
    let isSelected: Bool
    let isUpdating: Bool

    var body: some View {
        SettingsItemRow(title: icon.title, subtitle: icon.subtitle, isSelected: isSelected, isLoading: isUpdating) {
            AppIconChoicePreview(icon: icon)
        }
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(isUpdating ? "Updating app icon" : isSelected ? "Selected" : "")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var accessibilityLabel: String {
        "\(icon.title). \(icon.subtitle)"
    }
}
