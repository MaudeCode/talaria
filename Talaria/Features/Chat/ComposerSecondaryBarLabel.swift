import SwiftUI
import UIKit

struct ComposerSecondaryBarLabel: View {
    let title: String
    let systemImage: String
    let lineLimit: Int
    let verticalPadding: CGFloat
    let horizontalPadding: CGFloat
    let color: Color
    let controlFont: Font
    let chevronFont: Font

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(controlFont)

            Text(title)
                .lineLimit(lineLimit)
                .truncationMode(.middle)
                .font(controlFont)

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
