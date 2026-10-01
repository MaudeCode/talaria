import SwiftUI

private struct ChatTimelineAccessoryInsetSurfaceModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var backgroundColor: Color {
        if reduceTransparency {
            return Color(.secondarySystemGroupedBackground)
        }

        return Color(.secondarySystemFill).opacity(0.72)
    }

    func body(content: Content) -> some View {
        content
            .background(
                backgroundColor,
                in: RoundedRectangle(cornerRadius: 9, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .stroke(Color(.separator).opacity(colorScheme == .dark ? 0.36 : 0.22), lineWidth: 0.5)
                    .allowsHitTesting(false)
            }
    }
}

extension View {
    func chatTimelineAccessoryInsetSurface() -> some View {
        modifier(ChatTimelineAccessoryInsetSurfaceModifier())
    }
}
