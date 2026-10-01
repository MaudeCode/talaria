import SwiftUI

private struct AccessorySurfaceModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    let fallbackMaterial: Material
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content
            .background(
                Color(.secondarySystemBackground).opacity(colorScheme == .dark ? 0.28 : 0.48),
                in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
            .adaptiveGlass(
                .regular,
                isInteractive: false,
                fallbackMaterial: fallbackMaterial,
                in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(Color(.separator).opacity(colorScheme == .dark ? 0.42 : 0.28), lineWidth: 0.5)
                    .allowsHitTesting(false)
            }
    }
}

extension View {
    /// The translucent rounded surface behind floating accessories such as status chips and
    /// transcript marker cards.
    func accessorySurface(fallbackMaterial: Material, cornerRadius: CGFloat) -> some View {
        modifier(AccessorySurfaceModifier(fallbackMaterial: fallbackMaterial, cornerRadius: cornerRadius))
    }
}
