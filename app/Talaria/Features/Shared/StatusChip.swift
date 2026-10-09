import SwiftUI

/// The app's status chip: a short status with a leading activity indicator or symbol. Features
/// supply the content and emphasis; the chip owns the look, Reduce Motion, Dynamic Type and
/// accessibility.
struct StatusChip: View {
    enum Icon: Equatable {
        /// Work in progress: a spinner, or a still dot with Reduce Motion.
        case activity
        /// A standing state, drawn as an SF Symbol.
        case symbol(String)
    }

    enum Emphasis {
        /// Background progress the user can ignore.
        case standard
        /// A state the user should notice.
        case prominent
        /// A state that changes what the agent may do without asking. Only the icon takes the
        /// warning colour, so the caption keeps its text contrast.
        case warning
    }

    static let cornerRadius: CGFloat = 16

    let label: String
    var accessibilityLabel: String?
    let icon: Icon
    var emphasis: Emphasis = .standard
    /// When set, the time since then follows the label ("· 1:23"). The system advances it, so
    /// the chip does not redraw each second.
    var elapsedSince: Date?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 8) {
            iconView
                .foregroundStyle(emphasis == .warning ? AnyShapeStyle(.orange) : textStyle)
                .accessibilityHidden(true)

            caption
                .font(.caption.weight(.semibold))
                .foregroundStyle(textStyle)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                .minimumScaleFactor(0.88)
        }
        .statusChipChrome()
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel ?? label)
    }

    private var caption: Text {
        guard let elapsedSince else { return Text(label) }
        return Text(label)
            + Text(verbatim: " · ")
            + Text(timerInterval: elapsedSince...Date.distantFuture, countsDown: false).monospacedDigit()
    }

    @ViewBuilder
    private var iconView: some View {
        switch icon {
        case .activity:
            if reduceMotion {
                Circle()
                    .frame(width: 7, height: 7)
            } else {
                ProgressView()
                    .controlSize(.mini)
            }
        case .symbol(let name):
            Image(systemName: name)
                .font(.caption.weight(.semibold))
        }
    }

    private var textStyle: AnyShapeStyle {
        emphasis == .standard ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary)
    }
}

/// A tappable chip in the status chip's look, for an action that sits in a row of status chips.
struct StatusChipButton: View {
    let systemImage: String
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            // Set as text so the symbol takes the caption's line height and the chip matches a
            // status chip's height.
            Text(Image(systemName: systemImage))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
                // Stretches to a taller neighbour in a fixed-height row, e.g. a two-line status chip.
                .frame(maxHeight: .infinity)
                .statusChipChrome()
                .chatMinimumHitTarget(in: RoundedRectangle(cornerRadius: StatusChip.cornerRadius, style: .continuous))
        }
        .buttonStyle(.chatTactile(.icon))
        .accessibilityLabel(accessibilityLabel)
    }
}

extension View {
    /// The status chip's padding and surface, shared by every chip so a row of them matches.
    func statusChipChrome() -> some View {
        padding(.horizontal, 11)
            .padding(.vertical, 7)
            .accessorySurface(fallbackMaterial: .regularMaterial, cornerRadius: StatusChip.cornerRadius)
    }
}
