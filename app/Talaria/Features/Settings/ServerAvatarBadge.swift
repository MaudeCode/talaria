import SwiftUI
import TalariaKit

struct ServerAvatarBadge: View {
    let initials: String
    let colorHex: String
    var size: CGFloat = 32
    var font: Font = AppFont.caption(weight: .semibold)

    var body: some View {
        Text(initials)
            .font(font)
            .lineLimit(1)
            .minimumScaleFactor(0.3)
            .foregroundStyle(HeaderLogoColor.prefersDarkForeground(for: colorHex) ? Color.black : Color.white)
            .frame(width: size, height: size)
            .background(HeaderLogoColor.color(for: colorHex), in: Circle())
            .overlay(Circle().stroke(.white.opacity(0.18), lineWidth: 1))
            .accessibilityHidden(true)
    }
}
