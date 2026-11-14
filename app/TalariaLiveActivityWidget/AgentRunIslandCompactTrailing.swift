import ActivityKit
import SwiftUI
import WidgetKit
import TalariaKit

struct AgentRunIslandCompactTrailing: View {
    @Environment(\.liveActivityPalette) private var palette
    let state: AgentRunActivityAttributes.ContentState

    var body: some View {
        if let title = state.status.compactTitle {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(palette.color(for: state.status, isStale: state.isStale))
                .minimumScaleFactor(0.72)
                .lineLimit(1)
                .accessibilityHidden(true)
        }
    }
}
