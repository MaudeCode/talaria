import SwiftUI
import UIKit

struct ComposerMetaControlLabel: View {
    @ScaledMetric(relativeTo: .footnote) private var iconSize: CGFloat = 13

    let title: String
    let systemImage: String?
    /// Provider whose registry glyph (or initials fallback) leads the title.
    var providerIcon: (id: String, label: String)? = nil
    var minWidth: CGFloat?
    let maxWidth: CGFloat
    let color: Color
    let controlFont: Font
    let chevronFont: Font

    var body: some View {
        HStack(spacing: 5) {
            if let providerIcon {
                ProviderIconView(
                    providerID: providerIcon.id,
                    label: providerIcon.label,
                    tint: color,
                    size: iconSize
                )
            } else if let systemImage {
                if systemImage == "lucide.brain" {
                    LucideBrainIcon()
                        .frame(width: iconSize, height: iconSize)
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
