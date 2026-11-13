import SwiftUI
import TalariaKit

struct ComposerMetaControlLabel: View {
    @ScaledMetric(relativeTo: .footnote) private var providerIconSize: CGFloat = 13

    let title: String
    let systemImage: String?
    var minWidth: CGFloat?
    let maxWidth: CGFloat?
    let color: Color
    let controlFont: Font
    let chevronFont: Font
    var providerID: String? = nil
    var summary: String? = nil

    var body: some View {
        ComposerChipContent(
            title: title,
            collapsesTitle: systemImage != nil,
            spacing: 5,
            font: controlFont
        ) {
            if let providerID, !providerID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ProviderIconView(providerID: providerID, label: providerID, tint: color, size: providerIconSize)
            }
            if let systemImage {
                Image(systemName: systemImage)
                    .font(controlFont)
            }
        } trailing: {
            if let summary { Text(summary).font(controlFont).foregroundStyle(.secondary) }
            Image(systemName: "chevron.down")
                .font(chevronFont)
        }
        .fixedSize(horizontal: maxWidth == nil, vertical: false)
        .foregroundStyle(color)
        .frame(minWidth: minWidth, maxWidth: maxWidth, alignment: .leading)
        .transaction { transaction in
            transaction.animation = nil
        }
        .chatMinimumHitTarget(horizontalPadding: 0, verticalPadding: Self.hitPadding, in: Rectangle())
    }

    /// How far the hit shape reaches above and below the label without taking layout space.
    static let hitPadding: CGFloat = 14
}

/// A composer chip's icon, title and trailing accessory. A title that does not fit on one line
/// drops out, leaving the icon, instead of showing an ellipsis (TAL-484); the chip's button
/// still carries the title for VoiceOver. A chip without an icon keeps its truncating title.
struct ComposerChipContent<Icon: View, Trailing: View>: View {
    let title: String
    var collapsesTitle = true
    let spacing: CGFloat
    let font: Font
    @ViewBuilder let icon: Icon
    @ViewBuilder let trailing: Trailing

    var body: some View {
        if collapsesTitle {
            ViewThatFits(in: .horizontal) {
                row(showsTitle: true)
                row(showsTitle: false)
            }
        } else {
            row(showsTitle: true)
        }
    }

    private func row(showsTitle: Bool) -> some View {
        HStack(spacing: spacing) {
            icon
                // An SF Symbol can stand taller than the title's line (the toolsets wrench: 18 pt against 15.67 pt at
                // footnote). Centred on the line without setting its height, every titled chip keeps one height, so
                // a selector the session load adds does not grow the strip and move the composer (TAL-1998).
                .frame(height: showsTitle ? 0 : nil)

            if showsTitle {
                Text(title)
                    .lineLimit(1)
                    .font(font)
                    .layoutPriority(1)
            }

            trailing
        }
    }
}
