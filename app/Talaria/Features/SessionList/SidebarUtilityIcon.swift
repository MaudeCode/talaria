import SwiftUI

struct SidebarUtilityIcon: View {
    let assetImage: String
    var tint: Color = .primary
    var size: CGFloat = 21

    var body: some View {
        Image(assetImage)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .foregroundStyle(tint)
            .frame(width: 28)
            .accessibilityHidden(true)
    }
}
