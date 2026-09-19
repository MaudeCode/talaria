import SwiftUI

struct SessionFilterChip: View {
    let title: String
    let systemImage: String

    var body: some View {
        Label(title, systemImage: systemImage)
            .font(.subheadline.weight(.medium))
            .lineLimit(1)
            .padding(.horizontal, 12)
            .frame(height: 38)
            .background(.thinMaterial, in: Capsule())
            .overlay(Capsule().stroke(Color.primary.opacity(0.08), lineWidth: 1))
    }
}
