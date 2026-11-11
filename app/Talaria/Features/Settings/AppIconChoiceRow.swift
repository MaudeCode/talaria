import SwiftUI
import UIKit
import TalariaKit

struct AppIconChoiceRow: View {
    let icon: AppIconChoice
    let isSelected: Bool
    let isUpdating: Bool

    var body: some View {
        SettingsItemRow(title: icon.title, isSelected: isSelected, isLoading: isUpdating) {
            AppIconChoicePreview(icon: icon)
        }
        .accessibilityLabel(icon.title)
        .accessibilityValue(isUpdating ? "Updating app icon" : isSelected ? "Selected" : "")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

}
