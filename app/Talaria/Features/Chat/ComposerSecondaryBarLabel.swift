import SwiftUI
import UIKit

struct ComposerSecondaryBarLabel: View {
    let title: String
    let systemImage: String
    let verticalPadding: CGFloat
    let horizontalPadding: CGFloat
    let color: Color
    let controlFont: Font
    let chevronFont: Font

    var body: some View {
        ComposerChipContent(
            title: title,
            spacing: 6,
            font: controlFont
        ) {
            Image(systemName: systemImage)
                .font(controlFont)
        } trailing: {
            Image(systemName: "chevron.down")
                .font(chevronFont)
        }
        .foregroundStyle(color)
        .padding(.horizontal, horizontalPadding)
        .padding(.vertical, verticalPadding)
        .adaptiveGlass(
            .regular,
            isInteractive: true,
            fallbackMaterial: .ultraThinMaterial,
            in: Capsule()
        )
        .clipShape(Capsule())
        .chatMinimumHitTarget(in: Capsule())
    }
}
