import ActivityKit
import SwiftUI
import WidgetKit

struct SandalMark: View {
    let height: CGFloat

    var body: some View {
        Image("Sandal")
            .resizable()
            .renderingMode(.template)
            .scaledToFit()
            .foregroundStyle(AgentRunLiveActivityTheme.primaryText)
            .frame(width: height * 0.93, height: height)
            .accessibilityHidden(true)
    }
}
