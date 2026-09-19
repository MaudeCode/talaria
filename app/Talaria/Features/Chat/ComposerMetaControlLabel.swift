import SwiftUI
import UIKit

struct ComposerMetaControlLabel: View {
    @ScaledMetric(relativeTo: .footnote) private var brainIconSize: CGFloat = 13

    let title: String
    let systemImage: String?
    var minWidth: CGFloat?
    let maxWidth: CGFloat
    let color: Color
    let controlFont: Font
    let chevronFont: Font

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                if systemImage == "lucide.brain" {
                    LucideBrainIcon()
                        .frame(width: brainIconSize, height: brainIconSize)
                } else {
                    Image(systemName: systemImage)
                        .font(controlFont)
                }
            }

            Text(title)
                .lineLimit(1)
                .truncationMode(.tail)
                .font(controlFont)
                .layoutPriority(1)

            Image(systemName: "chevron.down")
                .font(chevronFont)
        }
        .foregroundStyle(color)
        .frame(minWidth: minWidth, maxWidth: maxWidth, alignment: .leading)
        .transaction { transaction in
            transaction.animation = nil
        }
        .chatMinimumHitTarget(horizontalPadding: 0, verticalPadding: 14, in: Rectangle())
    }
}
