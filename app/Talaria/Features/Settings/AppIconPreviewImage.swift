import SwiftUI
import UIKit

struct AppIconPreviewImage: View {
    let name: String
    let size: CGFloat

    var body: some View {
        Image(name)
            .resizable()
            .renderingMode(.original)
            .scaledToFit()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.12), radius: 6, x: 0, y: 3)
            .accessibilityHidden(true)
    }
}
