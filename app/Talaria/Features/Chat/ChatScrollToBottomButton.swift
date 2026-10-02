import SwiftUI

struct ChatScrollToBottomButton: View {
    static let diameter: CGFloat = 32

    @Environment(\.colorScheme) private var colorScheme

    let bottomPadding: CGFloat
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
                .frame(width: Self.diameter, height: Self.diameter)
                .foregroundStyle(.primary)
                .adaptiveGlass(
                    .regular,
                    isInteractive: true,
                    fallbackMaterial: .regularMaterial,
                    in: Circle()
                )
                .chatMinimumHitTarget(in: Circle())
        }
        .buttonStyle(.chatTactile(
            .icon,
            shadow: ChatTactileButtonStyle.Shadow(
                color: .black,
                opacity: colorScheme == .dark ? 0.32 : 0.16,
                radius: 8,
                y: 4,
                pressedOpacity: colorScheme == .dark ? 0.18 : 0.08,
                pressedRadius: 3,
                pressedY: 2
            )
        ))
        .padding(.bottom, bottomPadding)
        .accessibilityLabel("Scroll to latest message")
    }
}

/// The run status chip's footprint above the composer, so the scroll button can sit beside it.
struct ChatRunStatusChipSlot: Equatable {
    let width: CGFloat
    /// Bottom padding that centres the button on the chip's row.
    let buttonBottomPadding: CGFloat
}
