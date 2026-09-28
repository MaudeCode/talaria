import SwiftUI
import TalariaKit

struct AccentColorSettings: View {
    @Binding var selectedHex: String
    let customColor: Binding<Color>

    private var selectedColorName: String {
        HeaderLogoColor.displayName(for: selectedHex)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Text("Accent Color")
                    .foregroundStyle(.primary)

                Spacer(minLength: 12)

                Text(selectedColorName)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline)

            HStack(spacing: 10) {
                ForEach(HeaderLogoColor.presets) { preset in
                    HeaderLogoColorPresetButton(
                        preset: preset,
                        isSelected: HeaderLogoColor.normalizedHex(selectedHex) == preset.hex
                    ) {
                        selectedHex = preset.hex
                    }
                }
            }

            ColorPicker("Custom", selection: customColor, supportsOpacity: false)
                .font(.subheadline)
        }
    }
}
