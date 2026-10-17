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
    /// When set, an elapsed time that follows the label ("Working 42s").
    var elapsed: String?

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
        guard let elapsed else { return Text(label) }
        return Text(label) + Text(verbatim: " ") + Text(verbatim: elapsed).monospacedDigit()
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
        modifier(StatusChipChrome())
    }
}

private extension EnvironmentValues {
    @Entry var statusChipIsGrouped = false
}

private struct StatusChipChrome: ViewModifier {
    @Environment(\.statusChipIsGrouped) private var isGrouped

    func body(content: Content) -> some View {
        let padded = content.padding(.horizontal, 11).padding(.vertical, 7)
        if isGrouped {
            padded
        } else {
            padded.accessorySurface(fallbackMaterial: .regularMaterial, cornerRadius: StatusChip.cornerRadius)
        }
    }
}

/// Extends StatusChip's chrome to any number of independent compact entries. The same subviews
/// survive row/stack changes, so a ticking status or focused button never needs a second copy.
/// A floating first segment stays visible without adding to the reported reserved height.
struct StatusChipGroup<Content: View>: View {
    private let content: Content
    private let reservesFirstSegment: Bool
    private let onReservedHeightChange: ((CGFloat) -> Void)?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(
        reservesFirstSegment: Bool = true,
        onReservedHeightChange: ((CGFloat) -> Void)? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.content = content()
        self.reservesFirstSegment = reservesFirstSegment
        self.onReservedHeightChange = onReservedHeightChange
    }

    var body: some View {
        Group(subviews: content) { segments in
            StatusChipGroupLayout(vertical: dynamicTypeSize.isAccessibilitySize, reservesFirstSegment: reservesFirstSegment) {
                // Report reserved geometry after layout, without writing state during measurement.
                Color.clear
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onReservedHeightChange?($0) }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                ForEach(segments) { segment in
                    // Layout places one surface around a row, or one around each stacked entry.
                    Color.clear
                        .accessorySurface(fallbackMaterial: .regularMaterial, cornerRadius: StatusChip.cornerRadius)
                        .clipped()
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    Color(.separator)
                        .clipped()
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    segment.environment(\.statusChipIsGrouped, segments.count > 1)
                }
            }
        }
    }
}

/// After the reserved-height marker, each entry supplies a surface, divider and content. This keeps chrome
/// and sizing in one pass, without measuring an animated row back into its own state.
private struct StatusChipGroupLayout: Layout {
    var vertical: Bool
    var reservesFirstSegment: Bool
    private let spacing: CGFloat = 8
    private let dividerWidth: CGFloat = 0.5

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrangement(width: proposal.width, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrangement(width: bounds.width, subviews: subviews)
        subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(width: 1, height: result.reservedHeight))
        for (index, frame) in result.frames.enumerated() {
            let surface = result.frames.count == 1 ? .zero : (result.horizontal
                ? (index == 0 ? CGRect(origin: .zero, size: result.size) : .zero)
                : frame)
            let divider = result.horizontal && index > 0
                ? CGRect(x: frame.minX - dividerWidth, y: (result.size.height - 18) / 2, width: dividerWidth, height: 18)
                : .zero
            for (offset, rect) in [surface, divider, frame].enumerated() {
                subviews[index * 3 + offset + 1].place(
                    at: CGPoint(x: bounds.minX + rect.minX, y: bounds.minY + rect.minY),
                    proposal: ProposedViewSize(rect.size)
                )
            }
        }
    }

    private func arrangement(width: CGFloat?, subviews: Subviews) -> (size: CGSize, frames: [CGRect], horizontal: Bool, reservedHeight: CGFloat) {
        let entries = stride(from: 3, to: subviews.count, by: 3).map { subviews[$0] }
        guard !entries.isEmpty else { return (.zero, [], true, 0) }
        let reserved = entries.indices.dropFirst(reservesFirstSegment ? 0 : 1)
        let ideal = entries.map { $0.sizeThatFits(.unspecified) }
        let available = max(0, width ?? .infinity)
        var widths = ideal.map(\.width)
        var excess = max(0, widths.reduce(0, +) + CGFloat(entries.count - 1) * dividerWidth - available)
        // Negative layout priority marks the status as flexible. Counts keep their measured
        // widths; only a small part of the status caption uses StatusChip's existing text scaling.
        for index in entries.indices where entries[index].priority < 0 {
            let reduction = min(excess, max(0, widths[index] - 64) * 0.1)
            widths[index] -= reduction
            excess -= reduction
        }
        if (!vertical || entries.count == 1) && excess < 0.5 {
            let height = ideal.map(\.height).max() ?? 0
            var x: CGFloat = 0
            let frames = widths.enumerated().map { index, width in
                defer { x += width + dividerWidth }
                return CGRect(x: x, y: (height - ideal[index].height) / 2, width: width, height: ideal[index].height)
            }
            let reservedHeight = reserved.map { ideal[$0].height }.max() ?? 0
            return (CGSize(width: max(0, x - dividerWidth), height: height), frames, true, reservedHeight)
        }
        let sizes = entries.enumerated().map { index, entry in
            entry.sizeThatFits(ProposedViewSize(width: min(ideal[index].width, available), height: nil))
        }
        let stackWidth = sizes.map(\.width).max() ?? 0
        var y: CGFloat = 0
        let frames = sizes.map { size in
            defer { y += size.height + spacing }
            return CGRect(x: (stackWidth - size.width) / 2, y: y, width: size.width, height: size.height)
        }
        let reservedHeight = reserved.reduce(CGFloat(0)) { $0 + sizes[$1].height }
            + CGFloat(max(0, reserved.count - 1)) * spacing
        return (CGSize(width: stackWidth, height: max(0, y - spacing)), frames, false, reservedHeight)
    }
}
