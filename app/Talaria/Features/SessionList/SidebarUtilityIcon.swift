import SwiftUI

struct SidebarUtilityIcon: View {
    let assetImage: String
    var tint: Color = .primary

    var body: some View {
        Image(assetImage)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: 21, height: 21)
            .foregroundStyle(tint)
            .frame(width: 28)
            .accessibilityHidden(true)
    }
}
