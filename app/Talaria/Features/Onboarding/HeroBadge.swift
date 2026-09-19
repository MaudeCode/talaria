import SwiftUI
import UIKit

struct HeroBadge: View {
    let systemImage: String
    let title: String

    var body: some View {
        Label(title, systemImage: systemImage)
            .font(.caption.weight(.medium))
            .foregroundStyle(.white.opacity(0.68))
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Color.white.opacity(0.06), in: Capsule())
            .overlay(Capsule().stroke(Color.white.opacity(0.08), lineWidth: 1))
    }
}
