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
            SettingsValueRow(title: String(localized: "Accent Color"), systemImage: "paintpalette") {
                Text(selectedColorName).foregroundStyle(.secondary)
            } supplementary: {
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
            }

            SettingsColorRow(title: String(localized: "Custom"), selection: customColor, supportsOpacity: false)
                .font(.subheadline)
        }
    }
}
