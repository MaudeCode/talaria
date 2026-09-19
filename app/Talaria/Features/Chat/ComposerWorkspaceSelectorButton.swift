import SwiftUI
import UIKit

struct ComposerWorkspaceSelectorButton: View {
    let title: String
    let isDisabled: Bool
    let lineLimit: Int
    let verticalPadding: CGFloat
    let horizontalPadding: CGFloat
    let color: Color
    let controlFont: Font
    let chevronFont: Font
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            ComposerSecondaryBarLabel(
                title: title,
                systemImage: "folder",
                lineLimit: lineLimit,
                verticalPadding: verticalPadding,
                horizontalPadding: horizontalPadding,
                color: color,
                controlFont: controlFont,
                chevronFont: chevronFont
            )
        }
        .buttonStyle(.chatTactile(.capsule))
        .disabled(isDisabled)
        .accessibilityLabel("Choose workspace path")
    }
}
