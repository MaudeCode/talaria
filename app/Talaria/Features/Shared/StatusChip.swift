import SwiftUI

/// The app's status chip: a short status with a leading activity indicator or symbol. Features
/// supply the content; the chip owns the look, Reduce Motion, Dynamic Type and accessibility.
struct StatusChip: View {
    enum Icon: Equatable {
        /// Work in progress: a spinner, or a still dot with Reduce Motion.
        case activity
        /// A standing state, drawn as an SF Symbol beside primary text.
        case symbol(String)
    }

    let label: String
    var accessibilityLabel: String?
    let icon: Icon

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 8) {
            iconView
                .accessibilityHidden(true)

            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(icon == .activity ? .secondary : .primary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                .minimumScaleFactor(0.88)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .chatTimelineAccessorySurface(fallbackMaterial: .regularMaterial, cornerRadius: 16)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel ?? label)
    }

    @ViewBuilder
    private var iconView: some View {
        switch icon {
        case .activity:
            if reduceMotion {
                Circle()
                    .fill(.secondary)
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
}
