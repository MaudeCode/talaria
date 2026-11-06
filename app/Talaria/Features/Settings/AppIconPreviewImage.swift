import SwiftUI
import UIKit

struct AppIconPreviewImage: View {
    let name: String
    let size: CGFloat

    private var cornerRadius: CGFloat { max(12, size * 0.225) }

    var body: some View {
        Image(name)
            .resizable()
            .renderingMode(.original)
            .scaledToFit()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.12), radius: 6, x: 0, y: 3)
            .accessibilityHidden(true)
    }
}
