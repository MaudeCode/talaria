import SwiftUI
import TalariaKit

struct HeaderLogoColorPresetButton: View {
    let preset: HeaderLogoColorPreset
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(preset.color)
                    .overlay(Circle().stroke(Color.primary.opacity(0.18), lineWidth: 1))

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(preset.hex == "#FFFFFF" ? .black : .white)
                        .accessibilityHidden(true)
                }
            }
            .frame(width: 34, height: 34)
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(String(localized: "\(preset.name) header logo color"))
        .accessibilityValue(isSelected ? "Selected" : "")
        .accessibilityHint("Updates the Sessions header logo color.")
    }
}
