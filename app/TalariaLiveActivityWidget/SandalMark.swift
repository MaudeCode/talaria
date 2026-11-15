import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct SandalMark: View {
    @Environment(\.liveActivityPalette) private var palette
    let height: CGFloat
    var color: Color? = nil

    var body: some View {
        Image("Sandal")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .foregroundStyle(color ?? palette.primaryText)
            .frame(width: height * 0.93, height: height)
            .accessibilityHidden(true)
    }
}
