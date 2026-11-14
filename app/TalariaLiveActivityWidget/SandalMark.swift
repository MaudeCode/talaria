import ActivityKit
import SwiftUI
import WidgetKit

struct SandalMark: View {
    @Environment(\.liveActivityPalette) private var palette
    let height: CGFloat

    var body: some View {
        Image("Sandal")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .foregroundStyle(palette.primaryText)
            .frame(width: height * 0.93, height: height)
            .accessibilityHidden(true)
    }
}
